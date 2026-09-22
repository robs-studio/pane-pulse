// Which VS Code terminal a Claude process lives in, found by walking the process tree.
//
// Every hook event carries `claude_pid`; VS Code tells us only each terminal's SHELL pid
// (`Terminal.processId`). Claude is a descendant of that shell, so a mapping is a walk up the
// ppid chain from the claude pid until one ancestor is a terminal's shell. Measured on this
// iMac: `claude 3330` -> `zsh 91051`, one hop. A fixed one-hop assumption breaks the moment a
// wrapper sits in between -- `npx claude`, `uv run claude` -- so the walk climbs up to
// MAX_HOPS levels.
//
// Known gap: a claude inside tmux never resolves. The tmux server daemonises -- it is
// reparented to launchd or init -- so no VS Code shell is ever among that claude's ancestors,
// however far the walk climbs. It answers `undefined`, never a crash, and its pane is not marked.
//
// A process snapshot costs a spawn (`ps` is ~10-20 ms; PowerShell's CIM query far more), so
// this module does not snapshot per event. It holds the last snapshot, and takes ONE fresh
// one for a call only when the claude pid is missing from it (a claude born since) or when a
// miss is about to be cached. The spawn is async `execFile` with a timeout, never a sync
// call: this runs inside the VS Code extension host, and blocking it freezes every extension
// in the window. A failed snapshot is logged and answers `undefined`; `resolve()` never
// throws.
//
// Answers are cached per claude pid, and misses are cached too, because a second VS Code
// window's events arrive here constantly and belong to someone else. A miss is cached only
// when it is definite: every terminal's `processId` was known, or the pid is dead. A
// `processId` not yet known makes the miss provisional, so the next event retries -- retry on
// the next event, never poll.
//
// Each kind of answer is dropped only by the news that can make it wrong, never wholesale,
// because a mapping is the one thing that still knows a claude which has just exited was ours:
// its SessionEnd lands after the process has gone, and a fresh walk would find it dead.
//   * A terminal OPENING (`terminalOpened()`) drops every miss and the held snapshot. The new
//     shell may be the one a missed pid runs under, and a pid cached as dead may since have
//     been reused. It keeps every mapping: a new terminal cannot adopt a claude already running.
//   * A terminal CLOSING (`terminalClosed(terminal)`) drops the mappings to that terminal, and
//     nothing else.
//   * A pane GOING (`forget(claudePid)`, which the controller calls when a session ends, its
//     terminal closes, or a newer claude takes over its tab) drops that one mapping, so a later
//     event for the pid is walked afresh instead of answered from the cache, and a pid reused
//     since maps where it now runs once the held snapshot is newer than the reuse.
// An answer already in flight when that news arrives is still returned, but never cached if
// the news could have changed it.
//
// A `processId` can stay pending, and the event pipeline awaits every `resolve()` in turn, so
// one terminal that never reports its pid must not freeze the window. Each terminal's
// `processId` gets ONE settle handler, on first sight, recording the answer in a memo. The
// first walk to meet it still pending waits at most PROCESS_ID_WAIT_MS, on a single unref'd
// timer cleared the moment either side wins; after that it reads as unknown, with no waiting,
// until the handler fires. A terminal's shell pid never changes, so none of the three drops
// the memo.
//
// No polling, no timer beyond that one bounded wait, and nothing persisted: no pid survives a
// VS Code application restart (the terminals relaunch with new pids), while a window reload
// keeps them, so the wiring rebuilds a Mapper at activation from `window.terminals` and this
// holds memory only.
//
// Nothing here imports 'vscode': the tests run under plain node, where no such module exists.
// A real `vscode.Terminal` satisfies `TerminalLike` structurally.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

/** The two members of `vscode.Terminal` a mapping needs; a real Terminal satisfies it. */
export type TerminalLike = {
  readonly name: string;
  /** The SHELL's pid. Read once per terminal and memoised: a shell pid never changes. */
  readonly processId: PromiseLike<number | undefined>;
};

/** One process, as a snapshot sees it. `tty` is the raw column, or null where there is none. */
export type ProcessRow = {
  readonly pid: number;
  readonly ppid: number;
  readonly tty: string | null;
};

/** Every process on the machine at one instant, keyed by pid. */
export type ProcessSnapshot = ReadonlyMap<number, ProcessRow>;

/** A claude process, the terminal it runs in, and the pty device that reaches that terminal. */
export type Mapping<T> = {
  readonly terminal: T;
  readonly shellPid: number;
  readonly claudePid: number;
  /** An existing `/dev/...` path, or null when there is none (always null on win32). */
  readonly ttyPath: string | null;
};

export type MapperOptions = {
  /** Where the process table comes from. Defaults to the real per-OS snapshot. */
  readonly snapshot?: () => Promise<ProcessSnapshot>;
  /** Picks the default snapshot command. Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Whether a tty path is really there. Defaults to `fs.existsSync`. */
  readonly exists?: (path: string) => boolean;
  /** Where a failure is reported. Defaults to nowhere; the wiring passes the output channel. */
  readonly log?: (line: string) => void;
  /** How long one walk waits on a pending shell pid. Defaults to PROCESS_ID_WAIT_MS. */
  readonly processIdWaitMs?: number;
};

/** Runs a command and answers its stdout. Injected so the snapshot road is testable. */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<string>;

/** The most parent hops between a claude process and its terminal's shell. */
export const MAX_HOPS = 12;

/**
 * The longest a walk waits on a terminal's still-pending shell pid, and only the first walk to
 * meet it: later walks read it as unknown straight away until it settles.
 */
export const PROCESS_ID_WAIT_MS = 1000;

/** A hung `ps` or PowerShell is killed after this; PowerShell's cold start needs the room. */
export const SNAPSHOT_TIMEOUT_MS = 10_000;

/** A whole process table as text is tens of kilobytes; this leaves room for a busy machine. */
const SNAPSHOT_MAX_BUFFER = 16 * 1024 * 1024;

/** How much of a bad input a failure message quotes. */
const QUOTE_LIMIT = 120;

const WIN32_SNAPSHOT_SCRIPT =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ' +
  'ConvertTo-Json -Compress';

function fail(source: string, message: string): never {
  throw new Error(`pane-pulse mapping (${source}): ${message}`);
}

function quote(value: string): string {
  return JSON.stringify(value.length > QUOTE_LIMIT ? `${value.slice(0, QUOTE_LIMIT)}...` : value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pidOf(token: unknown, source: string, what: string): number {
  if (typeof token === 'number' && Number.isSafeInteger(token) && token >= 0) return token;
  if (typeof token === 'string' && /^\d+$/.test(token)) return Number(token);
  fail(source, `${what} must be a non-negative integer, got ${JSON.stringify(token)}`);
}

function addRow(
  rows: Map<number, ProcessRow>,
  row: ProcessRow,
  source: string,
  where: string,
): void {
  if (rows.has(row.pid)) {
    fail(source, `${where} repeats pid ${row.pid}; one pid cannot be two processes`);
  }
  rows.set(row.pid, Object.freeze(row));
}

/**
 * Parse `ps -eo pid=,ppid=,tty=`: one process per line, whitespace-separated, right-aligned
 * (so lines open with spaces), blank lines ignored. The tty column is kept raw (`ttys004`,
 * `pts/3`, `??`, `?`) for `normaliseTty` to judge; a line without one gets null. Throws on a
 * line it cannot read, quoting it, rather than guessing at a process table.
 */
export function parsePs(stdout: string): ProcessSnapshot {
  const rows = new Map<number, ProcessRow>();
  stdout.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    const where = `line ${index + 1}`;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 2 || fields.length > 3) {
      const found = `${fields.length} column(s)`;
      fail('ps', `${where} has ${found}, expected pid ppid [tty]: ${quote(line)}`);
    }
    const pid = pidOf(fields[0], 'ps', `${where} pid`);
    const ppid = pidOf(fields[1], 'ps', `${where} ppid`);
    addRow(rows, { pid, ppid, tty: fields[2] ?? null }, 'ps', where);
  });
  return rows;
}

/**
 * Parse the win32 CIM query's `ConvertTo-Json -Compress` output. PowerShell emits a bare
 * object, not an array, when exactly one process comes back, so both forms are read. Windows
 * has no tty, so every row's is null. Throws on anything that is not that shape, quoting it.
 */
export function parseCimJson(stdout: string): ProcessSnapshot {
  const text = stdout.replace(/^\uFEFF/, '').trim();
  const rows = new Map<number, ProcessRow>();
  if (text === '') return rows;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail('cim', `output is not JSON (${messageOf(error)}): ${quote(text)}`);
  }
  const items: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  items.forEach((item, index) => {
    const where = `item ${index}`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      fail('cim', `${where} must be an object, got ${quote(JSON.stringify(item))}`);
    }
    const raw = item as Record<string, unknown>;
    const pid = pidOf(raw['ProcessId'], 'cim', `${where}.ProcessId`);
    const ppid = pidOf(raw['ParentProcessId'], 'cim', `${where}.ParentProcessId`);
    addRow(rows, { pid, ppid, tty: null }, 'cim', where);
  });
  return rows;
}

/**
 * A raw tty column as a device path this module can hand to the writer, or null. Absolute
 * stays as it is; `ttys004` (darwin) and `pts/3` (linux) take `/dev/`; `?`, `??`, `''` and
 * anything else mean no usable terminal. A path is answered only if `exists` says it is there.
 */
export function normaliseTty(raw: string, exists: (path: string) => boolean): string | null {
  const tty = raw.trim();
  let path: string;
  if (tty.startsWith('/')) path = tty;
  else if (/^ttys\d+$/.test(tty) || /^pts\/\d+$/.test(tty)) path = `/dev/${tty}`;
  else return null;
  return exists(path) ? path : null;
}

/** A command line, split for `execFile` so no shell ever parses it. */
export type SnapshotCommand = { readonly file: string; readonly args: readonly string[] };

/** The command that lists every process on this platform. */
export function snapshotCommand(platform: NodeJS.Platform): SnapshotCommand {
  const args = platform === 'win32'
    ? ['-NoProfile', '-Command', WIN32_SNAPSHOT_SCRIPT]
    : ['-eo', 'pid=,ppid=,tty='];
  return Object.freeze({
    file: platform === 'win32' ? 'powershell' : 'ps',
    args: Object.freeze(args),
  });
}

const execFileAsync = promisify(execFile);

async function runCommand(file: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, [...args], {
    encoding: 'utf8',
    timeout: SNAPSHOT_TIMEOUT_MS,
    maxBuffer: SNAPSHOT_MAX_BUFFER,
    windowsHide: true,
  });
  return stdout;
}

/** Take a real process snapshot: `ps` on darwin and linux, one CIM query on win32. */
export async function snapshotProcesses(
  platform: NodeJS.Platform = process.platform,
  run: CommandRunner = runCommand,
): Promise<ProcessSnapshot> {
  const { file, args } = snapshotCommand(platform);
  const stdout = await run(file, args);
  return platform === 'win32' ? parseCimJson(stdout) : parsePs(stdout);
}

/** A snapshot, and the ticket it was launched under: it is fresh for any call ticketed before. */
type Taken = { readonly ticket: number; readonly snapshot: ProcessSnapshot };

/**
 * What is known of one terminal's shell pid. `waiting`: the one bounded wait is running, and
 * every walk that meets the terminal shares it. `expired`: that wait ran out with the pid still
 * pending, so walks read it as unknown without waiting. `settled`: the promise answered, and
 * the answer (`undefined` included) is final.
 */
type ShellPidMemo =
  | { readonly kind: 'waiting'; readonly waited: Promise<void> }
  | { readonly kind: 'expired' }
  | { readonly kind: 'settled'; readonly pid: number | undefined };

const EXPIRED: ShellPidMemo = Object.freeze({ kind: 'expired' });

/** Every known shell pid -> its terminal, and whether every terminal could be attributed. */
type Shells<T> = { readonly byPid: ReadonlyMap<number, T>; readonly complete: boolean };

/**
 * Climb from `claudePid` through its parents -- the pid itself first, then up to MAX_HOPS
 * ancestors -- and answer the first pid that is a terminal's shell. The hop bound also ends
 * any ppid cycle, which win32 can produce when a parent's pid has been reused.
 */
function walk<T>(
  snapshot: ProcessSnapshot,
  claudePid: number,
  byPid: ReadonlyMap<number, T>,
): { readonly terminal: T; readonly shellPid: number } | undefined {
  let pid = claudePid;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    const terminal = byPid.get(pid);
    if (terminal !== undefined) return { terminal, shellPid: pid };
    const row = snapshot.get(pid);
    if (row === undefined || row.ppid === pid) return undefined;
    pid = row.ppid;
  }
  return undefined;
}

/**
 * Maps claude pids to the terminals they run in. Generic over the terminal so a real
 * `vscode.Terminal` goes in unchanged and tests pass plain fakes.
 */
export class Mapper<T extends TerminalLike> {
  readonly #terminals: () => readonly T[];
  readonly #snapshot: () => Promise<ProcessSnapshot>;
  readonly #exists: (path: string) => boolean;
  readonly #log: (line: string) => void;
  readonly #waitMs: number;

  readonly #positive = new Map<number, Mapping<T>>();
  readonly #negative = new Set<number>();
  #held: Taken | undefined;
  /** The most recently launched snapshot, settled or not, and the ticket it launched under. */
  #launched: { readonly ticket: number; readonly result: Promise<Taken | undefined> } | undefined;
  /** One counter orders both calls and snapshots, so "taken after this call began" is a compare. */
  #ticket = 0;
  /** Bumped by `terminalOpened()`: a miss judged across it is not cached, nor its snapshot held. */
  #openings = 0;
  /** Bumped by `forget()`: a mapping found across it is returned but never cached. */
  #forgets = 0;
  /** Every terminal reported closed: a mapping to one is never cached, whenever it was found. */
  readonly #closed = new WeakSet<T>();
  /** Each terminal's shell pid as far as it is known. Nothing drops it: it never changes. */
  readonly #shellPids = new WeakMap<T, ShellPidMemo>();

  /**
   * `terminals` is read on every walk, never captured, so a terminal opened after
   * construction is seen. The wiring passes `() => window.terminals`.
   */
  constructor(terminals: () => readonly T[], options: MapperOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.#terminals = terminals;
    this.#snapshot =
      options.snapshot ?? ((): Promise<ProcessSnapshot> => snapshotProcesses(platform));
    this.#exists = options.exists ?? existsSync;
    this.#log = options.log ?? ((): void => {});
    this.#waitMs = options.processIdWaitMs ?? PROCESS_ID_WAIT_MS;
  }

  /**
   * The terminal `claudePid` runs in, or `undefined` when it runs in none of ours (another
   * window's pane, a headless run, a dead pid) or cannot be told yet. Never rejects: any
   * failure is logged and answers `undefined`, uncached, so the next event retries.
   */
  async resolve(claudePid: number): Promise<Mapping<T> | undefined> {
    try {
      return await this.#resolve(claudePid);
    } catch (error) {
      const why = messageOf(error);
      this.#log(`pane-pulse mapping: resolving claude pid ${claudePid} failed: ${why}`);
      return undefined;
    }
  }

  /** The claude pids currently mapped to `terminal`, from the cache, in the order they mapped. */
  reverse(terminal: T): readonly number[] {
    const pids: number[] = [];
    for (const mapping of this.#positive.values()) {
      if (mapping.terminal === terminal) pids.push(mapping.claudePid);
    }
    return Object.freeze(pids);
  }

  /**
   * A terminal opened: every miss and the held snapshot go, since the new shell may be the one
   * a missed pid runs under and a pid cached as dead may since have been reused. Every mapping
   * stays, because a new terminal cannot adopt a claude already running, and a claude that has
   * just exited is recognised by its mapping alone. The wiring calls it on onDidOpenTerminal.
   */
  terminalOpened(): void {
    this.#negative.clear();
    this.#held = undefined;
    this.#launched = undefined;
    this.#openings += 1;
  }

  /**
   * A terminal closed: the mappings to it go, and nothing else. A walk in flight that finds it
   * still answers it, uncached; the controller ignores a Mapping whose terminal has closed. The
   * wiring calls it on onDidCloseTerminal.
   */
  terminalClosed(terminal: T): void {
    this.#closed.add(terminal);
    for (const [pid, mapping] of this.#positive) {
      if (mapping.terminal === terminal) this.#positive.delete(pid);
    }
  }

  /**
   * One claude's pane has gone: its session ended, its terminal closed, or a newer claude took
   * over its tab. Its mapping goes, so a later event for the pid is walked afresh instead of
   * answered from the cache, and a pid reused since maps where it now runs once the held
   * snapshot is newer than the reuse. Misses and the held snapshot stay.
   */
  forget(claudePid: number): void {
    this.#positive.delete(claudePid);
    this.#forgets += 1;
  }

  async #resolve(claudePid: number): Promise<Mapping<T> | undefined> {
    if (!Number.isSafeInteger(claudePid) || claudePid <= 0) {
      this.#log(`pane-pulse mapping: ${String(claudePid)} is not a pid; nothing to resolve`);
      return undefined;
    }
    const known = this.#positive.get(claudePid);
    if (known !== undefined) return known;
    if (this.#negative.has(claudePid)) return undefined;

    this.#ticket += 1;
    const ticket = this.#ticket;
    const openings = this.#openings;
    const forgets = this.#forgets;
    const shells = await this.#shells();

    let taken = this.#held;
    if (taken === undefined || !taken.snapshot.has(claudePid)) {
      taken = await this.#fresh(ticket);
      if (taken === undefined) return undefined;
    }
    let found = walk(taken.snapshot, claudePid, shells.byPid);
    // A miss is about to be cached, and the held snapshot may predate a reused pid: judge it
    // once more against the machine as it is now. Still at most one fresh snapshot per call.
    if (found === undefined && shells.complete && taken.ticket < ticket) {
      taken = await this.#fresh(ticket);
      if (taken === undefined) return undefined;
      found = walk(taken.snapshot, claudePid, shells.byPid);
    }

    const snapshot = taken.snapshot;
    // A terminal that opened while this call walked may be the very one it missed.
    const missCacheable = openings === this.#openings;
    const claudeRow = snapshot.get(claudePid);
    if (claudeRow === undefined) {
      // Absent even from a snapshot taken after this call began: the process is dead.
      if (missCacheable) this.#negative.add(claudePid);
      return undefined;
    }
    if (found === undefined) {
      if (missCacheable && shells.complete) this.#negative.add(claudePid);
      return undefined;
    }

    const shellRow = snapshot.get(found.shellPid);
    const ttyPath =
      this.#ttyOf(claudeRow) ?? (shellRow === undefined ? null : this.#ttyOf(shellRow));
    const mapping: Mapping<T> = Object.freeze({
      terminal: found.terminal,
      shellPid: found.shellPid,
      claudePid,
      ttyPath,
    });
    // A terminal that closed, or a pane that went, while this call walked must not come back
    // through it. A terminal opening changes nothing here: it cannot adopt a claude found.
    if (forgets === this.#forgets && !this.#closed.has(found.terminal)) {
      this.#positive.set(claudePid, mapping);
    }
    return mapping;
  }

  #ttyOf(row: ProcessRow): string | null {
    return row.tty === null ? null : normaliseTty(row.tty, this.#exists);
  }

  /**
   * Every terminal's shell pid, gathered together. An unknown pid (still pending, settled as
   * `undefined`, or rejected) and a pid two terminals both claim cannot be matched, and either
   * makes this call's miss provisional: ambiguity is never settled by picking one.
   */
  async #shells(): Promise<Shells<T>> {
    const terminals = this.#terminals();
    const ids = await Promise.all(terminals.map((terminal) => this.#shellPidOf(terminal)));
    const byPid = new Map<number, T>();
    const claimed = new Set<number>();
    let complete = true;
    ids.forEach((id, index) => {
      if (id === undefined) {
        complete = false;
      } else if (claimed.has(id)) {
        complete = false;
        byPid.delete(id);
        this.#log(`pane-pulse mapping: two terminals report shell pid ${id}; matching neither`);
      } else {
        claimed.add(id);
        byPid.set(id, terminals[index]);
      }
    });
    return { byPid, complete };
  }

  /**
   * One terminal's shell pid, or `undefined` while it is unknown. Only a walk that finds the
   * bounded wait still running awaits it; a settled or expired memo answers without waiting.
   *
   * An expired memo is read one microtask late, on purpose. The wiring re-runs lookups from
   * its own `.then` on the same `processId`, attached when the terminal opened, so before this
   * module's handler; reactions run in the order they were attached, so a lookup started from
   * the wiring's reaction would otherwise read `expired` while the pid sits one reaction away.
   */
  async #shellPidOf(terminal: T): Promise<number | undefined> {
    const memo = this.#shellPids.get(terminal) ?? this.#watch(terminal);
    if (memo.kind === 'waiting') await memo.waited;
    else if (memo.kind === 'expired') await Promise.resolve();
    const known = this.#shellPids.get(terminal);
    return known?.kind === 'settled' ? known.pid : undefined;
  }

  /**
   * First sight of a terminal: attach the one settle handler its `processId` ever gets, and
   * start the one bounded wait. The race runs on a single timer, unref'd so it never holds the
   * process open and cleared the moment either side wins. A pid still pending when the timer
   * wins marks the terminal expired, logged once; the handler still records the pid whenever
   * it does arrive, and the next walk uses it.
   */
  #watch(terminal: T): ShellPidMemo {
    const name = JSON.stringify(terminal.name);
    const settled = Promise.resolve(terminal.processId).then(
      (pid): void => {
        this.#shellPids.set(terminal, Object.freeze({ kind: 'settled', pid }));
      },
      (error: unknown): void => {
        this.#log(`pane-pulse mapping: processId of ${name} failed: ${messageOf(error)}`);
        this.#shellPids.set(terminal, Object.freeze({ kind: 'settled', pid: undefined }));
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<void>((wake) => {
      timer = setTimeout(wake, this.#waitMs);
      timer.unref();
    });
    const waited = Promise.race([settled, expiry])
      .finally(() => clearTimeout(timer))
      .then((): void => {
        if (this.#shellPids.get(terminal)?.kind === 'settled') return;
        this.#shellPids.set(terminal, EXPIRED);
        this.#log(
          `pane-pulse mapping: the shell pid of ${name} is still pending after ` +
            `${this.#waitMs} ms; its misses stay provisional until it arrives`,
        );
      });
    const memo: ShellPidMemo = Object.freeze({ kind: 'waiting', waited });
    this.#shellPids.set(terminal, memo);
    return memo;
  }

  /**
   * A snapshot taken after the call ticketed `after` began. One already launched after that
   * point, in flight or settled, is shared rather than duplicated -- a burst of events at
   * activation costs one spawn, not one per pid -- but an older one is never shared, since
   * it could predate the very claude this call is looking for.
   */
  #fresh(after: number): Promise<Taken | undefined> {
    const launched = this.#launched;
    if (launched !== undefined && launched.ticket > after) return launched.result;

    this.#ticket += 1;
    const ticket = this.#ticket;
    const openings = this.#openings;
    const result = this.#take().then((snapshot): Taken | undefined => {
      if (snapshot === undefined) return undefined;
      const taken: Taken = Object.freeze({ ticket, snapshot });
      const held = this.#held;
      // A snapshot launched before a terminal opened is not held past it: the opening dropped
      // the held one on purpose, and this one is exactly as old.
      if (openings === this.#openings && (held === undefined || held.ticket < ticket)) {
        this.#held = taken;
      }
      return taken;
    });
    this.#launched = { ticket, result };
    return result;
  }

  /** One snapshot, with every failure logged and answered as `undefined`. */
  async #take(): Promise<ProcessSnapshot | undefined> {
    try {
      const snapshot = await this.#snapshot();
      if (snapshot.size === 0) {
        // A real process table always holds at least init and the lister itself. Empty means
        // the snapshot failed quietly, and trusting it would cache every live pid as dead.
        this.#log('pane-pulse mapping: the process snapshot came back empty; treated as failed');
        return undefined;
      }
      return snapshot;
    } catch (error) {
      this.#log(`pane-pulse mapping: process snapshot failed: ${messageOf(error)}`);
      return undefined;
    }
  }
}
