// The event reader: claims each file the hook drops, and hands this window the ones it owns.
//
// Every Claude Code session on the machine runs hook/hook.js (or, for PostToolUse, the shell
// one-liner src/installer.ts writes), and every run drops one small JSON file into
// <root>/events/. Every VS Code window on the machine runs this module against that one folder.
// Four facts shape everything below:
//
//   * MOST EVENTS ARE SOMEBODY ELSE'S. A headless run, a pane in another window, a session in a
//     plain terminal: the hook fires for all of them. An event no terminal here owns is the
//     normal case, never an error, and it must cost a bounded amount of work -- it is claimed
//     at most once per thing the mapper learns, and never in a loop.
//   * A FILE IS TAKEN BY RENAMING IT. `<name>` -> `<name>.claim-<windowKey>` is atomic on all
//     three operating systems, so exactly one window wins; a rename that fails with ENOENT means
//     another window got there first. A window that finds the event is not its own renames it
//     back, so the window that does own it can still take it. That is the handoff.
//   * THE SKIP SET IS PER FILE, NOT PER PID. A released file is not claimed again until the
//     mapper learns something, but a pid is never written off: at the start of every pass each
//     skipped file's pid is asked about again, and a file whose pid now resolves joins that
//     pass's batch. The batch is emitted in `ts` order, so a pane whose first event beat its
//     own mapping has its older events sorted in with its newer ones, never after them.
//   * ENOENT IS NEWS, NOT AN ERROR. Several windows move the same files at once, so any file may
//     vanish between two calls. Every operation reads ENOENT as "another window moved it";
//     anything else is logged and the source carries on. Nothing here is ever fatal.
//
// windowKey is minted in memory at activation and never persisted: context.globalState is
// shared by every window of one extension on one machine, so a persisted key would be the same
// key everywhere and the rename could no longer tell two windows apart.
//
// A claim is aged by when it was CLAIMED, a file by when it was WRITTEN. A rename keeps the
// write-time mtime, so the claimer stamps the claim with the time of the claim (or an old
// orphan would look stale to every other window the instant it was taken), and a release puts
// the write time back (or an orphan re-claimed on every rescan would never grow old enough for
// retention to prune it).
//
// A MUTED PANE'S EVENTS STILL ARRIVE. A pane the member muted (a marker at
// <root>/mute/<claude_pid>) or launched with PANE_PULSE_IGNORE set gets no mark but `clear`,
// yet its writer still drops every event, so the pane list keeps following it. Such an event
// says why in `muted`, "env" or "marker" (env wins when both hold), and its `sequence` is what
// actually reached the tab: null for a mark held back, "clear" when a clear went out. So the
// controller keeps trusting `sequence` as the tab's one fact, and a muted event arms no settle
// and cancels none. This reader passes `muted` through as written and never weighs it against
// `sequence`: a mark on record went out, and dropping its event would hide it from the one
// place that can clear it.
//
// There is no polling timer anywhere in this file. A pass runs on start, on a change in the
// folder, on rescan(), which the wiring calls when the terminal mapper learns something, and on
// poke(), which the controller calls on a tab click, a row click and a window-focus change: an
// OS watch can drop a notification, and a mark must not wait on disk for the next change.
import * as fs from 'node:fs';
import { join } from 'node:path';

import { NOOP, PANE_STATES, SEQUENCE_NAMES } from './decision.ts';
import type { RowState, SequenceName } from './decision.ts';

/**
 * Why a muted pane's writer held its mark back: PANE_PULSE_IGNORE in the pane's environment, or
 * the marker the extension wrote for it. A writer that finds both records `env`.
 */
export type MuteSource = 'env' | 'marker';

export const MUTE_SOURCES: readonly MuteSource[] = Object.freeze(['env', 'marker']);

/**
 * One hook event as its writer recorded it. JSON-mirroring, so the fields stay snake_case.
 * `state` is what the hook already computed from the decision table; the extension trusts it
 * rather than re-deriving it, and tests/drift.test.mjs is what keeps the hook honest.
 */
export type PaneEvent = {
  readonly ts: number;
  readonly event: string;
  readonly matcher: string | null;
  readonly notification_type: string | null;
  readonly session_id?: string;
  readonly claude_pid: number;
  readonly cwd: string;
  readonly state: RowState;
  readonly sequence: SequenceName | null;
  readonly bg?: number;
  readonly muted?: MuteSource;
};

/**
 * Which fields an event must carry and which it may leave out: hook/hook.js's EVENT_SCHEMA,
 * restated for this reader, and tests/events.test.mjs holds the two equal so neither drifts.
 * `session_id` and `bg` are optional because the shell-shaped PostToolUse writer builds its
 * record from the environment alone (its subagent guard has already eaten the payload) and has
 * neither to give. Their absence is a valid event, never a malformed one. `muted` is optional
 * because both writers add it only to a muted pane's event; absent, the writer found no mute.
 */
export const EVENT_FIELDS: {
  readonly required: readonly (keyof PaneEvent)[];
  readonly optional: readonly (keyof PaneEvent)[];
} = Object.freeze({
  required: Object.freeze<(keyof PaneEvent)[]>([
    'ts',
    'event',
    'matcher',
    'notification_type',
    'claude_pid',
    'cwd',
    'state',
    'sequence',
  ]),
  optional: Object.freeze<(keyof PaneEvent)[]>(['session_id', 'bg', 'muted']),
});

/** The folder under `<root>` both writers drop their files into. */
export const EVENTS_DIRNAME = 'events';

/** A foreign claim this old belongs to a window that died holding it, so it is released. */
export const STALE_CLAIM_MS = 10_000;

/** Any event, temp or claim file this old is deleted: nobody is ever going to want it. */
export const RETENTION_MS = 10 * 60_000;

/** Retention rides on the back of a pass, at most this often. There is no timer of its own. */
export const RETENTION_EVERY_MS = 60_000;

/** A whole event. Both writers are born `.tmp` and renamed to this, so it is never half-written. */
const EVENT_SUFFIX = '.json';
const TMP_SUFFIX = '.tmp';
const CLAIM_MARK = '.claim-';

/** `<epoch_ms>-<claude_pid>-<n>.json`. The shell writer's `n` is its own pid: still digits. */
const EVENT_NAME_PATTERN = /^(\d+)-(\d+)-(\d+)\.json$/;

/** What a window key may be: it ends a filename on three operating systems, so no dots. */
const WINDOW_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** How much of an offending value an error message quotes. */
const QUOTE_LIMIT = 120;

/** A row's state: one of the pane states, or the explicit no-op. */
const ROW_STATES: readonly RowState[] = Object.freeze([...PANE_STATES, NOOP]);

/** The node:fs calls this module makes, injectable so a test can count or break them. */
export type EventFs = Pick<
  typeof fs,
  | 'mkdirSync'
  | 'readdirSync'
  | 'readFileSync'
  | 'renameSync'
  | 'statSync'
  | 'unlinkSync'
  | 'utimesSync'
>;

/** A running watch on one folder. */
export type WatchHandle = { close(): void };

/** Starts watching `directory`: `onChange` on any change in it, `onError` if the watch dies. */
export type WatchDirectory = (
  directory: string,
  onChange: () => void,
  onError: (error: unknown) => void,
) => WatchHandle;

export type EventSourceOptions = {
  /** Whether this window has a terminal running `claudePid`. The wiring asks the mapper. */
  readonly owns: (claudePid: number) => boolean | Promise<boolean>;
  /** Called once per owned event, in `ts` order within a pass. A throw is logged, not fatal. */
  readonly onEvent: (event: PaneEvent) => void;
  /** One line per thing worth knowing. The wiring passes the output channel. */
  readonly log?: (line: string) => void;
  /** Injected in tests; production gets node:fs. */
  readonly fs?: EventFs;
  /** Epoch milliseconds. Injected in tests so retention can be driven, never waited for. */
  readonly now?: () => number;
  /** Injected in tests; production gets a non-persistent fs.watch. */
  readonly watch?: WatchDirectory;
};

/** An mtime and atime, kept so a release can put a file's write time back. */
type Stamps = { readonly atimeMs: number; readonly mtimeMs: number };

/** One event this window claimed and owns, held until the batch is emitted. */
type Owned = {
  readonly name: string;
  readonly claim: string;
  readonly event: PaneEvent;
  readonly written: Stamps | undefined;
};

/** `<original>.claim-<key>`, split. */
type ClaimName = { readonly original: string; readonly key: string };

/** The one never-returning helper. Messages name the path and quote the value. */
function fail(source: string, message: string): never {
  throw new Error(`pane-pulse event (${source}): ${message}`);
}

function quote(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}...` : text;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

function wholeNumber(value: unknown, minimum: number, source: string, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    fail(source, `${field} must be a whole number of at least ${minimum}, got ${quote(value)}`);
  }
  return value;
}

function finiteNumber(value: unknown, source: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(source, `${field} must be a finite number, got ${quote(value)}`);
  }
  return value;
}

function someText(value: unknown, source: string, field: string, emptyAllowed: boolean): string {
  if (typeof value !== 'string' || (!emptyAllowed && value === '')) {
    const what = emptyAllowed ? 'a string' : 'a non-empty string';
    fail(source, `${field} must be ${what}, got ${quote(value)}`);
  }
  return value;
}

function textOrNull(value: unknown, source: string, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    fail(source, `${field} must be a string or null, got ${quote(value)}`);
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  source: string,
  field: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(source, `${field} must be one of ${allowed.join(' | ')}, got ${quote(value)}`);
  }
  return value as T;
}

function recordOf(text: string, source: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(source, `is not JSON (${describe(error)}): ${quote(text)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(source, `must hold one JSON object, got ${quote(parsed)}`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

/**
 * Read one event file's text into a frozen PaneEvent, or throw naming `source` (the path).
 *
 * A missing optional field is valid; a present one of the wrong type is not, and neither is a
 * `null` in its place -- both writers leave an optional field out rather than null it. Keys this
 * reader does not know are dropped rather than refused, so a newer hook cannot silence an older
 * extension; the drift test is what keeps the known ones in step with the hook.
 */
export function parseEvent(text: string, source: string): PaneEvent {
  const record = recordOf(text, source);
  for (const field of EVENT_FIELDS.required) {
    if (!Object.hasOwn(record, field)) fail(source, `is missing the required field ${field}`);
  }

  const ts = wholeNumber(record['ts'], 0, source, 'ts');
  const event = someText(record['event'], source, 'event', false);
  const matcher = textOrNull(record['matcher'], source, 'matcher');
  const notificationType = textOrNull(record['notification_type'], source, 'notification_type');
  const sessionId = Object.hasOwn(record, 'session_id')
    ? someText(record['session_id'], source, 'session_id', false)
    : undefined;
  const claudePid = wholeNumber(record['claude_pid'], 1, source, 'claude_pid');
  const cwd = someText(record['cwd'], source, 'cwd', true);
  const state = oneOf(record['state'], ROW_STATES, source, 'state');
  const sequence =
    record['sequence'] === null
      ? null
      : oneOf(record['sequence'], SEQUENCE_NAMES, source, 'sequence');
  if (state === NOOP && sequence !== null) {
    fail(source, `is a no-op but carries the ${quote(sequence)} sequence`);
  }
  const bg = Object.hasOwn(record, 'bg') ? finiteNumber(record['bg'], source, 'bg') : undefined;
  const muted = Object.hasOwn(record, 'muted')
    ? oneOf(record['muted'], MUTE_SOURCES, source, 'muted')
    : undefined;

  return Object.freeze({
    ts,
    event,
    matcher,
    notification_type: notificationType,
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    claude_pid: claudePid,
    cwd,
    state,
    sequence,
    ...(bg === undefined ? {} : { bg }),
    ...(muted === undefined ? {} : { muted }),
  });
}

function claimNameOf(name: string): ClaimName | undefined {
  const at = name.lastIndexOf(CLAIM_MARK);
  if (at <= 0) return undefined;
  return { original: name.slice(0, at), key: name.slice(at + CLAIM_MARK.length) };
}

function isEventName(name: string): boolean {
  return name.endsWith(EVENT_SUFFIX) && !name.includes(CLAIM_MARK);
}

function isPrunable(name: string): boolean {
  return name.includes(CLAIM_MARK) || name.endsWith(EVENT_SUFFIX) || name.endsWith(TMP_SUFFIX);
}

/** The pid a well-formed event filename carries, for a file whose body could not be read. */
function pidFromName(name: string): number | undefined {
  const match = EVENT_NAME_PATTERN.exec(name);
  if (match === null) return undefined;
  const pid = Number(match[2]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Every event name still on disk in some form: whole, or held under anybody's claim. A file
 * another window is holding for a moment has not vanished; reading it as gone would drop it from
 * the skip set, and two windows would pass the same orphan back and forth for ever.
 */
function presentNames(names: readonly string[]): Set<string> {
  const present = new Set<string>();
  for (const name of names) {
    const claim = claimNameOf(name);
    present.add(claim === undefined ? name : claim.original);
  }
  return present;
}

function byTsThenName(a: Owned, b: Owned): number {
  if (a.event.ts !== b.event.ts) return a.event.ts - b.event.ts;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/** Production's watch: non-persistent, so an idle watch never keeps the host alive. */
function watchDirectory(
  directory: string,
  onChange: () => void,
  onError: (error: unknown) => void,
): WatchHandle {
  const watcher = fs.watch(directory, { persistent: false }, () => onChange());
  watcher.on('error', onError);
  return watcher;
}

/**
 * Watches `<root>/events`, claims each event file, and emits the ones whose `claude_pid` this
 * window owns, in `ts` order. Construct it with the window key minted at activation
 * (`crypto.randomUUID()`, never persisted), call `start()` once, `rescan()` whenever the mapper
 * learns something, `poke()` whenever a pass may have been missed, and `dispose()` at
 * deactivation.
 */
export class EventSource {
  private readonly directory: string;
  private readonly windowKey: string;
  private readonly owns: (claudePid: number) => boolean | Promise<boolean>;
  private readonly onEvent: (event: PaneEvent) => void;
  private readonly log: (line: string) => void;
  private readonly fs: EventFs;
  private readonly now: () => number;
  private readonly watch: WatchDirectory;

  /** Released files this window does not own, each with the pid it was asked about. */
  private readonly skipped = new Map<string, number | undefined>();
  private watcher: WatchHandle | undefined;
  private started = false;
  private disposed = false;
  private running = false;
  private dirty = false;
  private retainedAt = Number.NEGATIVE_INFINITY;

  constructor(root: string, windowKey: string, options: EventSourceOptions) {
    if (typeof windowKey !== 'string' || !WINDOW_KEY_PATTERN.test(windowKey)) {
      fail(
        'windowKey',
        `must be 1 to 128 letters, digits, '-' or '_', because it ends a filename, ` +
          `got ${quote(windowKey)}`,
      );
    }
    this.directory = join(root, EVENTS_DIRNAME);
    this.windowKey = windowKey;
    this.owns = options.owns;
    this.onEvent = options.onEvent;
    const log = options.log ?? ((line: string): void => console.warn(line));
    this.log = (line: string): void => log(`pane-pulse events: ${line}`);
    this.fs = options.fs ?? fs;
    this.now = options.now ?? Date.now;
    this.watch = options.watch ?? watchDirectory;
  }

  /**
   * Create the folder, watch it, and drain whatever was already waiting in it.
   *
   * One gap is the OS's, not this file's: fs.watch() returns before the OS is reporting (macOS
   * starts its FSEvents stream asynchronously, and libuv rebuilds its one shared stream whenever
   * any watch opens or closes), so a file landing in the first few milliseconds can go
   * unreported. It is delayed, never lost: every pass lists the whole folder, so the next change
   * in it, or the wiring's rescan() as the terminals' processIds resolve, picks it up.
   */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    // The watch is armed before the drain lists the folder, so a file landing between the two
    // is caught by the watch, not missed by both.
    this.arm();
    this.schedule();
  }

  /**
   * The mapper learned something (a terminal opened or closed, a processId resolved): forget
   * every skipped file, so each is claimed and asked about afresh, and run a pass.
   */
  rescan(): void {
    if (this.disposed) return;
    this.skipped.clear();
    if (!this.started) return;
    if (this.watcher === undefined) this.arm();
    this.schedule();
  }

  /**
   * A pass may have been missed: a change notification can be dropped, and a mark then waits on
   * disk until the next change in the folder. Run a pass now, re-arming a watch that died, but
   * keep the skip set: nothing the mapper knows has changed, so an orphan already released is not
   * claimed again (a skipped file whose pid now resolves still rejoins, as on every pass). Cheap
   * enough for every tab click, and it never overlaps a pass already running.
   */
  poke(): void {
    if (this.disposed || !this.started) return;
    if (this.watcher === undefined) this.arm();
    this.schedule();
  }

  /** Stop watching. A pass in flight gives its claims back instead of emitting them. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeWatcher();
    this.skipped.clear();
  }

  /** Passes never overlap: a change during one marks it dirty, and exactly one more follows. */
  private schedule(): void {
    if (this.disposed) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    void this.drive();
  }

  private async drive(): Promise<void> {
    do {
      this.dirty = false;
      try {
        await this.pass();
      } catch (error) {
        this.log(`a pass failed and the next change will retry it: ${describe(error)}`);
      }
    } while (this.dirty && !this.disposed);
    this.running = false;
  }

  private async pass(): Promise<void> {
    const now = this.now();
    let names = this.list();
    if (now - this.retainedAt >= RETENTION_EVERY_MS) {
      this.retainedAt = now;
      names = this.prune(names, now);
    }
    names = this.releaseStale(names, now);

    // One answer per pid per pass: the mapper is asked once, however many files a pid has.
    const ownership = new Map<number, boolean>();

    const present = presentNames(names);
    for (const [name, pid] of [...this.skipped]) {
      if (!present.has(name)) {
        this.skipped.delete(name);
      } else if (pid !== undefined && (await this.ask(pid, ownership))) {
        // Its pid resolves now, so it rejoins: the claim loop below takes it into this batch.
        this.skipped.delete(name);
      }
      if (this.disposed) return;
    }

    const batch: Owned[] = [];
    for (const name of names.filter(isEventName).sort()) {
      if (this.skipped.has(name)) continue;
      const owned = await this.take(name, ownership);
      if (owned !== undefined) batch.push(owned);
      if (this.disposed) {
        this.giveBackAll(batch);
        return;
      }
    }
    this.deliver(batch);
  }

  /** Claim one file, read it, and answer it if this window owns it; otherwise release it. */
  private async take(name: string, ownership: Map<number, boolean>): Promise<Owned | undefined> {
    const original = join(this.directory, name);
    const claim = `${original}${CLAIM_MARK}${this.windowKey}`;
    try {
      this.fs.renameSync(original, claim);
    } catch (error) {
      // ENOENT: another window took it first, which is the protocol working, not a fault.
      if (!isMissing(error)) this.log(`could not claim ${original}: ${describe(error)}`);
      return undefined;
    }
    const written = this.stampClaimed(claim);

    let text: string;
    try {
      text = this.fs.readFileSync(claim, 'utf8');
    } catch (error) {
      if (isMissing(error)) return undefined;
      this.log(`could not read ${claim}, released until the next rescan: ${describe(error)}`);
      this.giveBack(name, claim, written);
      this.skipped.set(name, pidFromName(name));
      return undefined;
    }

    let event: PaneEvent;
    try {
      event = parseEvent(text, original);
    } catch (error) {
      this.log(`deleted a malformed event: ${describe(error)}`);
      this.remove(claim);
      return undefined;
    }

    const mine = await this.ask(event.claude_pid, ownership);
    if (this.disposed) {
      this.giveBack(name, claim, written);
      return undefined;
    }
    if (!mine) {
      this.giveBack(name, claim, written);
      this.skipped.set(name, event.claude_pid);
      return undefined;
    }
    return { name, claim, event, written };
  }

  /** The mapper's answer for `pid`, once per pass. A throw is logged and reads as "not ours". */
  private async ask(pid: number, ownership: Map<number, boolean>): Promise<boolean> {
    const known = ownership.get(pid);
    if (known !== undefined) return known;
    let answer = false;
    try {
      answer = (await this.owns(pid)) === true;
    } catch (error) {
      this.log(`owns(${pid}) failed, so its events wait for the next rescan: ${describe(error)}`);
    }
    ownership.set(pid, answer);
    return answer;
  }

  /**
   * Emit every event this pass owns, in `ts` order (ties by filename), then delete the claims.
   * One throwing listener does not stop the rest: each event is delivered exactly once either way.
   */
  private deliver(batch: readonly Owned[]): void {
    // A claim another window released as stale while this pass waited on the mapper is no
    // longer ours: it is back under its own name and will come round again, so emitting it now
    // would emit it twice.
    const held = batch.filter((owned) => this.holds(owned.claim)).sort(byTsThenName);
    const emitted: Owned[] = [];
    for (const owned of held) {
      if (this.disposed) break;
      try {
        this.onEvent(owned.event);
      } catch (error) {
        this.log(`a listener threw on ${owned.name}; the rest still run: ${describe(error)}`);
      }
      emitted.push(owned);
    }
    for (const owned of emitted) this.remove(owned.claim);
    this.giveBackAll(held.slice(emitted.length));
  }

  private holds(claim: string): boolean {
    try {
      this.fs.statSync(claim);
      return true;
    } catch (error) {
      if (isMissing(error)) {
        this.log(`${claim} was released by another window while this one waited; not emitted`);
        return false;
      }
      return true;
    }
  }

  /**
   * Stamp a fresh claim with the time it was claimed, and answer the times it was written with
   * so a release can put them back. A claim another window has already moved answers nothing,
   * and the read that follows finds it gone.
   */
  private stampClaimed(claim: string): Stamps | undefined {
    let written: Stamps | undefined;
    try {
      const stats = this.fs.statSync(claim);
      written = { atimeMs: stats.atimeMs, mtimeMs: stats.mtimeMs };
      const claimed = new Date(this.now());
      this.fs.utimesSync(claim, claimed, claimed);
    } catch (error) {
      if (!isMissing(error)) this.log(`could not stamp ${claim}: ${describe(error)}`);
    }
    return written;
  }

  /** Rename a claim back under its own name, carrying its write time so it ages as written. */
  private giveBack(name: string, claim: string, written: Stamps | undefined): void {
    if (written !== undefined) {
      try {
        this.fs.utimesSync(claim, new Date(written.atimeMs), new Date(written.mtimeMs));
      } catch (error) {
        if (!isMissing(error)) {
          this.log(`could not restore the times of ${claim}: ${describe(error)}`);
        }
      }
    }
    try {
      this.fs.renameSync(claim, join(this.directory, name));
    } catch (error) {
      if (!isMissing(error)) this.log(`could not release ${claim}: ${describe(error)}`);
    }
  }

  private giveBackAll(owned: readonly Owned[]): void {
    for (const each of owned) this.giveBack(each.name, each.claim, each.written);
  }

  /** Delete one file. Answers false only when it is still there. */
  private remove(path: string): boolean {
    try {
      this.fs.unlinkSync(path);
      return true;
    } catch (error) {
      if (isMissing(error)) return true;
      this.log(`could not delete ${path}: ${describe(error)}`);
      return false;
    }
  }

  /** How long ago `path` was last modified; undefined when it has gone. */
  private ageOf(path: string, now: number): number | undefined {
    try {
      return now - this.fs.statSync(path).mtimeMs;
    } catch (error) {
      if (isMissing(error)) return undefined;
      this.log(`could not read the age of ${path}: ${describe(error)}`);
      return 0;
    }
  }

  private list(): string[] {
    try {
      return this.fs.readdirSync(this.directory);
    } catch (error) {
      if (isMissing(error)) {
        // The folder itself went (a member cleared <root>): put it back and watch it anew.
        this.closeWatcher();
        this.arm();
      } else {
        this.log(`could not list ${this.directory}: ${describe(error)}`);
      }
      return [];
    }
  }

  /** Retention: delete any event, temp or claim file older than RETENTION_MS. */
  private prune(names: readonly string[], now: number): string[] {
    const kept: string[] = [];
    let pruned = 0;
    for (const name of names) {
      if (!isPrunable(name)) {
        kept.push(name);
        continue;
      }
      const age = this.ageOf(join(this.directory, name), now);
      if (age === undefined) continue;
      if (age <= RETENTION_MS) {
        kept.push(name);
      } else if (this.remove(join(this.directory, name))) {
        this.skipped.delete(name);
        pruned += 1;
      } else {
        kept.push(name);
      }
    }
    if (pruned > 0) {
      this.log(`pruned ${pruned} file(s) older than ${RETENTION_MS / 60_000} minutes`);
    }
    return kept;
  }

  /**
   * A foreign claim older than STALE_CLAIM_MS belongs to a window that died holding it. It is
   * released under its own name, never deleted: the event may well be somebody's.
   */
  private releaseStale(names: readonly string[], now: number): string[] {
    const result: string[] = [];
    for (const name of names) {
      const claim = claimNameOf(name);
      if (claim === undefined || claim.key === this.windowKey || !isEventName(claim.original)) {
        result.push(name);
        continue;
      }
      const path = join(this.directory, name);
      const age = this.ageOf(path, now);
      if (age === undefined) continue;
      if (age <= STALE_CLAIM_MS) {
        result.push(name);
        continue;
      }
      try {
        this.fs.renameSync(path, join(this.directory, claim.original));
        this.log(`released ${name}: claimed ${Math.round(age / 1000)} s ago and never finished`);
        result.push(claim.original);
      } catch (error) {
        if (isMissing(error)) continue;
        this.log(`could not release the stale claim ${path}: ${describe(error)}`);
        result.push(name);
      }
    }
    return result;
  }

  private arm(): void {
    if (this.disposed) return;
    try {
      this.fs.mkdirSync(this.directory, { recursive: true });
    } catch (error) {
      this.log(`could not create ${this.directory}: ${describe(error)}`);
    }
    if (this.watcher !== undefined) return;
    try {
      this.watcher = this.watch(
        this.directory,
        () => this.schedule(),
        (error) => this.watchFailed(error),
      );
    } catch (error) {
      this.log(`could not watch ${this.directory}; events wait for a rescan: ${describe(error)}`);
    }
  }

  private watchFailed(error: unknown): void {
    const why = describe(error);
    this.log(`the watch on ${this.directory} stopped; a rescan or a poke re-arms it: ${why}`);
    this.closeWatcher();
  }

  private closeWatcher(): void {
    const watcher = this.watcher;
    this.watcher = undefined;
    if (watcher === undefined) return;
    try {
      watcher.close();
    } catch (error) {
      this.log(`could not close the watch on ${this.directory}: ${describe(error)}`);
    }
  }
}
