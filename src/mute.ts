// The mute markers: the one road by which the extension tells the hook to keep a pane quiet.
//
// The hook draws a pane's mark and cannot see the pane list, so a mute has to reach it before
// the mark does, as a file it can find on its own: `<root>/mute/<claude_pid>`. hook/hook.js and
// the PostToolUse shell one-liner ask for it by existence alone, a stat, and never open it;
// while it exists, every sequence but a clear is suppressed. This module is the marker's only
// writer. The controller decides which pids are muted; this file puts a marker down, takes it
// up, and sweeps away the ones whose process has died.
//
// Four rules this file is built around, each load-bearing:
//
//   * KEYED BY THE CLAUDE PID, NOT THE SESSION. The one-liner's subagent guard has eaten stdin
//     before a session_id could be read, so the pid in its environment is all it has; and a
//     /clear changes the session inside one live process, which would let marks through after
//     every /clear in a muted pane.
//   * A MARKER NEVER OUTLIVES ITS PROCESS FOR LONG. A pid can be reused, and a stale marker
//     would silence whichever claude got it next. So the controller takes a pid's marker up at
//     its SessionEnd, its terminal's close, an unmute and its death, and sweep() takes up every
//     marker whose process is dead, at activation. Only the dead: dead is dead for every
//     window, while a live pid's marker may belong to another window's terminal. The hook's
//     own startup delete (hook.js, MUTED MEANS NO SEQUENCE BUT CLEAR) covers the reuse a sweep
//     cannot see.
//   * EVERY WRITE IS GUARDED. A marker is written through backup.ts's writeFileAtomic, never a
//     temp-and-rename of this file's own, so it lands whole and assertNotInBrain refuses a root
//     inside a Glitch brain; a delete asks the same guard first. Only a pid written the way
//     String() writes it is ever named, so list() reads back exactly what the hook stats and a
//     path can never be steered out of mute/. The contents are for a person reading the
//     folder: which pid, since when, and which build wrote it. The hook never reads them.
//   * DEAD IS A FACT, NEVER A GUESS. isAlive() answers false only when kill(pid, 0) says ESRCH,
//     no such process; signal 0 sends nothing, and Node answers it on every platform. EPERM is
//     a process that exists and is not ours, so it is alive. Any other answer is a surprise and
//     reads as alive too, because a pane called dead is retired and its tab cleared, and that
//     must never happen on a surprise.
//
// No vscode import and nothing thrown: every method catches, logs one line opening with
// LOG_PREFIX, and answers. A marker that could not be written costs a mark on a muted tab; a
// throw would land in the controller or in the extension host's own event loop. The one
// exception is controllerMarkers() (C22), and it is deliberate: the controller reads only a
// throw as a marker that did not land, and catches it, so the adapter turns this file's false
// into one. That is what lets the controller try a failed put-down again at the pane's next
// event, and keep a failed take-up remembered until a later one succeeds.
import * as fs from 'node:fs';
import { join } from 'node:path';

import { assertNotInBrain, writeFileAtomic } from './backup.ts';
import { VERSION } from './version.ts';

/** `<root>/mute/`. hook/hook.js exports the same name, and tests/mute.test.mjs holds them equal. */
export const MUTE_DIRNAME = 'mute';

/** Every line this module logs opens with this, as the other modules' lines do. */
export const LOG_PREFIX = 'pane-pulse mute: ';

/** Sends nothing: it only asks whether the process exists. */
const PROBE_SIGNAL = 0;

/** The one answer that means dead: there is no such process. */
const NO_SUCH_PROCESS = 'ESRCH';

/** A process that exists and belongs to someone else: alive. */
const NOT_OURS = 'EPERM';

/** What an unlink answers when there is no marker to take up: the goal already holds. */
const ABSENT_CODES: readonly string[] = Object.freeze(['ENOENT', 'ENOTDIR']);

/** A marker's name: a pid in the digits String() writes, with no leading zero. */
const MARKER_NAME = /^[1-9][0-9]*$/;

/** How much of an offending value a log line quotes. */
const QUOTE_LIMIT = 120;

/** What list() and sweep() answer when they could not look. */
const NONE: readonly number[] = Object.freeze([]);

type Log = (line: string) => void;

/** How isAlive() asks: process.kill's shape. Injected in tests, so every errno can be answered. */
export type Kill = (pid: number, signal: number) => unknown;

/**
 * The node:fs calls this module makes itself, injectable so a test can break them. The write is
 * not among them on purpose: it goes through writeFileAtomic, over node:fs, so no fake can
 * route a marker around assertNotInBrain.
 */
export type MuteFs = Pick<typeof fs, 'readdirSync' | 'unlinkSync'>;

export type MuteMarkersOptions = {
  /** One line per failure. The wiring passes the output channel. */
  readonly log: Log;
  /** Injected in tests; production gets node:fs. */
  readonly fs?: MuteFs;
};

/** What a marker holds, for a person reading the folder. The hook only ever stats the file. */
export type MarkerRecord = {
  readonly claude_pid: number;
  /** Epoch milliseconds, when it was written. */
  readonly since: number;
  /** `pane-pulse <VERSION>`: which build wrote it. */
  readonly by: string;
};

/** The markers as the controller's host takes them: a marker that did not land is a throw. */
export type ControllerMarkers = {
  readonly add: (claudePid: number) => void;
  readonly remove: (claudePid: number) => void;
};

/** Where a pane's marker sits. hook/hook.js's markerPath, restated, and held equal to it. */
export function markerPath(root: string, claudePid: number): string {
  return join(root, MUTE_DIRNAME, String(claudePid));
}

/** A claude pid: a positive whole number. 0 and negatives name process groups, never a pane. */
function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Only reached when the caller wired no log: the extension host's own log, not silence. */
function defaultLog(line: string): void {
  console.error(line);
}

/** A log that throws, a disposed output channel say, must not turn an answer into a throw. */
function quiet(log: Log | undefined): Log {
  const target = log ?? defaultLog;
  return (line: string): void => {
    try {
      target(line);
    } catch {
      // Nowhere left to report it, and nothing here throws.
    }
  };
}

function codeOf(error: unknown): string {
  try {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { readonly code?: unknown }).code;
      if (typeof code === 'string' && code !== '') return code;
    }
  } catch {
    // A hostile error object still gets reported, as having no code.
  }
  return 'no error code';
}

function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'an error that could not be printed';
  }
}

/** A value as a log line shows it, capped; never a throw, whatever the value is. */
function quote(value: unknown): string {
  try {
    // JSON would print NaN and Infinity as null, and throws on a bigint.
    if (typeof value === 'number') return String(value);
    if (typeof value === 'bigint') return `${String(value)}n`;
    const text = JSON.stringify(value) ?? String(value);
    return text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}...` : text;
  } catch {
    return 'a value that could not be printed';
  }
}

/**
 * Whether a process is running: `kill(pid, 0)` answers, and only ESRCH is dead. EPERM, a
 * process that is not ours, is alive; any other answer, and any pid that is not a positive
 * whole number, is a surprise, logged through `log` and read as alive. Never throws.
 */
export function isAlive(pid: number, kill: Kill = process.kill, log?: Log): boolean {
  const report = quiet(log);
  if (!isPid(pid)) {
    report(
      `${LOG_PREFIX}asked whether ${quote(pid)} is alive, which is not a process id; ` +
        'reading it as alive, because nothing is called dead on a surprise',
    );
    return true;
  }
  try {
    kill(pid, PROBE_SIGNAL);
    return true;
  } catch (error) {
    const code = codeOf(error);
    if (code === NO_SUCH_PROCESS) return false;
    if (code === NOT_OURS) return true;
    report(
      `${LOG_PREFIX}could not tell whether process ${pid} is alive (${code}): ` +
        `${messageOf(error)}; reading it as alive, because nothing is called dead on a surprise`,
    );
    return true;
  }
}

/**
 * The markers under one `<root>`. Construct it with the same root the hook resolves
 * (backup.ts's resolveRoot), call `sweep(isAlive)` once at activation, and hand `add` and
 * `remove` to the controller. Every method answers and none throws.
 */
export class MuteMarkers {
  readonly #root: string;
  readonly #log: Log;
  readonly #fs: MuteFs;

  constructor(root: string, options: MuteMarkersOptions) {
    this.#root = root;
    this.#log = quiet(options.log);
    this.#fs = options.fs ?? fs;
  }

  /**
   * Put down `pid`'s marker, making `mute/` (and the root) on a cold start. A second add for
   * the same pid rewrites it. Answers whether the marker was written.
   */
  add(pid: number): boolean {
    return this.#guard(`write the marker for pid ${quote(pid)}`, false, () => {
      const record: MarkerRecord = {
        claude_pid: pid,
        since: Date.now(),
        by: `pane-pulse ${VERSION}`,
      };
      writeFileAtomic(this.#pathOf(pid), `${JSON.stringify(record)}\n`);
      return true;
    });
  }

  /**
   * Take up `pid`'s marker. None there is the goal already met, so a second remove is quiet.
   * Answers whether no marker is left for it; false only when one could not be taken up.
   */
  remove(pid: number): boolean {
    return this.#guard(`remove the marker for pid ${quote(pid)}`, false, () => {
      this.#unlink(pid);
      return true;
    });
  }

  /**
   * The pids with a marker now, ascending: only names written the way String() writes a pid,
   * so a temp file, a stray name or a leading zero is never read as a marker. No `mute/` at all
   * is a cold start and answers none, quietly.
   */
  list(): readonly number[] {
    return this.#guard('list the markers', NONE, () => Object.freeze(this.#pids()));
  }

  /**
   * Take up every marker whose pid `alive` calls dead, and answer the pids whose markers this
   * sweep removed. `alive` is asked once per marker with the pid alone, so isAlive can be
   * handed in bare. Only an answer of `false` is dead: a throw, or anything else, keeps the
   * marker, because nothing is called dead on a surprise. One marker that cannot be removed is
   * logged, and the sweep goes on.
   */
  sweep(alive: (pid: number) => boolean): readonly number[] {
    return this.#guard('sweep the markers', NONE, () => {
      const removed: number[] = [];
      for (const pid of this.#pids()) {
        if (!this.#dead(pid, alive)) continue;
        try {
          if (this.#unlink(pid)) removed.push(pid);
        } catch (error) {
          this.#fail(`remove the stale marker of dead pid ${pid}`, error);
        }
      }
      return Object.freeze(removed);
    });
  }

  /** A marker's path, for a pid that can name one; anything else is refused here, by name. */
  #pathOf(pid: number): string {
    if (!isPid(pid)) {
      throw new Error(
        `${quote(pid)} is not a claude pid: a marker is named by a positive whole number`,
      );
    }
    return markerPath(this.#root, pid);
  }

  /** Delete one marker, guarded as a write is. True when a file went; false when there was none. */
  #unlink(pid: number): boolean {
    const target = assertNotInBrain(this.#pathOf(pid));
    try {
      this.#fs.unlinkSync(target);
      return true;
    } catch (error) {
      if (ABSENT_CODES.includes(codeOf(error))) return false;
      throw error;
    }
  }

  /** The folder's markers, ascending. Throws on anything but a missing folder. */
  #pids(): number[] {
    let names: readonly string[];
    try {
      names = this.#fs.readdirSync(join(this.#root, MUTE_DIRNAME));
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return [];
      throw error;
    }
    return names
      .filter((name) => MARKER_NAME.test(name))
      .map(Number)
      .filter(isPid)
      .sort((a, b) => a - b);
  }

  /** Whether `alive` says this pid is dead, in so many words. A throw reads alive, logged. */
  #dead(pid: number, alive: (pid: number) => boolean): boolean {
    try {
      return alive(pid) === false;
    } catch (error) {
      this.#fail(`tell whether pid ${pid} is alive, so its marker stays`, error);
      return false;
    }
  }

  /** A public method's body: whatever it throws is logged and answered with `fallback`. */
  #guard<R>(what: string, fallback: R, body: () => R): R {
    try {
      return body();
    } catch (error) {
      this.#fail(what, error);
      return fallback;
    }
  }

  #fail(what: string, error: unknown): void {
    this.#log(`${LOG_PREFIX}could not ${what} (${codeOf(error)}): ${messageOf(error)}`);
  }
}

/**
 * `markers` as the controller's host takes them (C22). MuteMarkers answers whether a marker
 * landed and never throws, while the controller reads only a throw as failure, so each call
 * here throws an error naming the pid when the answer is anything but true. A put-down that
 * failed is then not remembered as down, and the pane's next event tries it again; a take-up
 * that failed stays remembered, and the next take-up (an unmute, a close, the sweep once the
 * pid is dead) tries it again. Why it failed is already in the log, from MuteMarkers; the throw
 * only says that it did. Pure: it keeps nothing, and calls each method once per call.
 */
export function controllerMarkers(markers: Pick<MuteMarkers, 'add' | 'remove'>): ControllerMarkers {
  const failed = (claudePid: number, what: string): never => {
    throw new Error(`${LOG_PREFIX}the marker for claude pid ${quote(claudePid)} was not ${what}`);
  };
  return Object.freeze({
    add: (claudePid: number): void => {
      if (markers.add(claudePid) !== true) failed(claudePid, 'written');
    },
    remove: (claudePid: number): void => {
      if (markers.remove(claudePid) !== true) failed(claudePid, 'taken up');
    },
  });
}
