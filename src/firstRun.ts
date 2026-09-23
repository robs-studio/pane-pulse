// The first-run prompt: one question at start-up, while this machine has never had the hooks set up.
//
// Pane Pulse does nothing until Install Hooks has run, and someone who found it on the
// Marketplace does not know that command exists: the Panes panel lists nothing and nothing says
// why. So at start-up, while this machine has never had the hooks set up, one notification says
// so and offers Set it up, Not now and Don't ask again. Eight of the nine hooks run `node`, and
// Claude Code's native installer does not bring it, so when Node.js cannot be found the question
// says that too and offers Get Node.js first. Get Node.js opens the site and then asks one
// follow-up, offering Set it up: the hooks can go in while Node.js installs, and they start once
// it is in and VS Code has restarted.
//
// planFirstRun() decides and FirstRunPrompt does what it decided through the host handed in, so
// node --test holds both with no VS Code. The prompt's whole memory is one small folder in VS
// Code's storage for the extension, which fileStore() alone reads and writes: `set-up`,
// `never-ask`, and one `asked-YYYY-MM-DD` per ask. Eight rules:
//
//   1. FIRST RUN MEANS NEVER SET UP. The prompt asks only while this machine has never had the
//      hooks set up. Any start-up that finds them installed writes `set-up`, and so does a Set it
//      up whose Install Hooks put them in. From then on the prompt never asks again, even after
//      Uninstall Hooks, run in the same session as the install or any later one: someone who
//      removed the hooks meant it, and Install Hooks stays in the Command Palette.
//   2. ONLY A LOCAL WINDOW ASKS. In a remote window (SSH, WSL, Codespaces) the extension runs on
//      the remote, where Install Hooks would write a VS Code settings file the local window never
//      reads. A remote window never claims a day and never asks, and logs why. The one thing it
//      may write is `set-up`, when the remote already has the hooks installed: installed is
//      weighed before remote (rule 1).
//   3. ONE WINDOW, THE ONE YOU'RE LOOKING AT. The day has one ask across every window, and it
//      belongs in the window the person is looking at, not one behind it they may not come back
//      to. An information notification with buttons is not sticky once it is seen, either: it
//      slides into the bell a few seconds later. So only a focused window may claim, and a
//      window that starts unfocused waits for focus (once per activation), then looks at
//      everything again. A window claims the day by creating `asked-YYYY-MM-DD` with an exclusive
//      create; the one that creates it asks, and every other one gets EEXIST and stays quiet. A
//      file rather than the global state, because the global state can lag between windows
//      (indicator.ts), and an exclusive create is atomic on every OS.
//   4. THREE ASKS, SPACED, THEN SILENCE. Every ask counts, whatever the answer: Not now, closing
//      the toast, letting it slide into the bell, Get Node.js, or Set it up followed by Cancel.
//      Get Node.js and the follow-up after it are one ask: the follow-up claims no day of its
//      own and adds nothing to the count. The second ask comes no sooner than 3 days after the
//      first, the third no sooner than 7 days after the second, and after the third the prompt
//      never asks again. The `asked-*` files are kept, never deleted: their count and dates are
//      the whole memory.
//   5. DON'T ASK AGAIN IS FOREVER. It writes `never-ask`, no later start-up asks, and a note in
//      the status bar says where Install Hooks still is.
//   6. SET IT UP CHANGES NOTHING ITSELF. It runs Install Hooks, whose preview and modal confirm
//      decide everything. Once that returns, the prompt reads whether the hooks are installed and
//      writes `set-up` only if they are (rule 1); that file is in its own folder, like the rest.
//      The prompt never writes outside that folder: never the hooks' root, never Claude Code's
//      settings, never VS Code's.
//   7. LOOK AGAIN BEFORE ASKING. Whether the hooks are installed is read again right before each
//      notification shows, the question and the follow-up after Get Node.js, so a window that
//      another window, or the command line, has just set up does not ask.
//   8. NEVER THROWS, NEVER BLOCKS. run() is started with `void` after activation and never
//      rejects. A storage failure, a Node check that fails (nodeCheck.ts gives up after 3 s), or
//      a notification that cannot show is logged and dropped, and a folder that cannot be read or
//      written means no ask: fail quiet, never nag.
//
// No vscode import: the host shows the notification, runs the command, opens the site, reads
// the window's focus and remote name, and says whether the hooks are installed. Node.js is the
// host's to look for too (nodeCheck.ts, wired in extension.ts).
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every line this module logs opens with this, as the other modules' lines do. */
export const LOG_PREFIX = 'pane-pulse first-run: ';

/** The most asks there will ever be (rule 4). */
export const MAX_ASKS = 3;

/** The days that must pass after an ask before the next one: before the 2nd, before the 3rd. */
export const GAPS_DAYS = [3, 7] as const;

// ------------------------------------------------------------------------------ the log lines

/** An ask is being put, the `n`th of three. */
export function logAsked(n: number): string {
  return `${LOG_PREFIX}asked (${n} of ${MAX_ASKS})`;
}

export const LOG_MARKED_SET_UP =
  `${LOG_PREFIX}the hooks are installed; marked this machine set up, never asking`;
export const LOG_ALREADY_SET_UP = `${LOG_PREFIX}set up before on this machine, never asking`;
export const LOG_NEVER = `${LOG_PREFIX}told never to ask`;
export const LOG_DONE_ASKING = `${LOG_PREFIX}asked three times already, never asking again`;

/** Too soon: the last ask was on `last`, and the next may come on `next` at the earliest. */
export function logNotYet(last: string, next: string): string {
  return `${LOG_PREFIX}asked ${last}, next ask no sooner than ${next}`;
}

export const LOG_CLAIMED_ELSEWHERE = `${LOG_PREFIX}another window is asking today`;

/** A remote window, by VS Code's name for the remote (`ssh-remote`, `wsl`, `codespaces`). */
export function logRemote(name: string | undefined): string {
  return `${LOG_PREFIX}a remote window (${name ?? 'unknown'}), not asking`;
}

export const LOG_WAITING_FOR_FOCUS = `${LOG_PREFIX}waiting for this window to be focused`;

/**
 * The button the person chose, or `nothing` for a notification closed without one. A toast that
 * fades into the notification centre has not answered yet: a later click there still resolves
 * with its button, and that is the answer logged.
 */
export function logAnswer(answer: string | undefined): string {
  return `${LOG_PREFIX}answered ${answer ?? 'nothing'}`;
}

/** One step that failed, and why. The prompt drops it and does not ask (rule 8). */
export function logFailed(what: string, message: string): string {
  return `${LOG_PREFIX}${what} failed: ${message}`;
}

// ------------------------------------------------------------------------------ the words

export const SET_IT_UP = 'Set it up';
export const NOT_NOW = 'Not now';
export const DONT_ASK_AGAIN = "Don't ask again";
export const GET_NODE = 'Get Node.js';

export const ASK_WITH_NODE = "Pane Pulse isn't marking your tabs yet: it needs to add hooks to Claude Code.";
export const ASK_WITHOUT_NODE =
  "Pane Pulse isn't marking your tabs yet. It needs to add hooks to Claude Code, and those hooks " +
  "run on Node.js, which this machine doesn't seem to have.";

/** The follow-up after Get Node.js: the hooks can go in now, and start once Node.js is in. */
export const ASK_AFTER_NODE =
  'Pane Pulse can add its hooks now, while Node.js installs. They start marking your tabs once ' +
  'Node.js is installed and VS Code has restarted.';

/** The status-bar note after Don't ask again (rule 5). */
export const WONT_ASK_NOTE = 'Pane Pulse won\'t ask again. Run "Pane Pulse: Install Hooks" whenever you want it.';

/** The buttons, in the order they show. Get Node.js leads only when Node.js was not found. */
const BUTTONS_WITH_NODE: readonly string[] = Object.freeze([SET_IT_UP, NOT_NOW, DONT_ASK_AGAIN]);
const BUTTONS_WITHOUT_NODE: readonly string[] = Object.freeze([
  GET_NODE,
  SET_IT_UP,
  NOT_NOW,
  DONT_ASK_AGAIN,
]);
/** The follow-up's buttons: Set it up, or leave it for a later ask. */
const BUTTONS_AFTER_NODE: readonly string[] = Object.freeze([SET_IT_UP, NOT_NOW]);

// ------------------------------------------------------------------------------ the days

/** A day as the prompt writes it: four-digit year, two-digit month and day. */
const DAY_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight UTC of a real calendar day written YYYY-MM-DD, or undefined for anything else. */
function utcOf(day: string): number | undefined {
  const parts = DAY_SHAPE.exec(day);
  if (parts === null) return undefined;
  const year = Number(parts[1]);
  const month = Number(parts[2]) - 1;
  const date = Number(parts[3]);
  const at = Date.UTC(year, month, date);
  const back = new Date(at);
  // Date.UTC rolls 2026-02-30 over into March, and reads a two-digit year as 19xx: neither is a day.
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month || back.getUTCDate() !== date) {
    return undefined;
  }
  return at;
}

function isDay(value: unknown): value is string {
  return typeof value === 'string' && utcOf(value) !== undefined;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** 'YYYY-MM-DD', the calendar day `now` falls on where this machine is. */
export function localDay(now: Date): string {
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}`;
}

/**
 * Whole calendar days from `from` to `to`, both 'YYYY-MM-DD'; negative when `to` is earlier.
 * Each day is read as its own midnight UTC, so a clock change between them is never a day short
 * or a day long. NaN when either is not a real calendar day.
 */
export function daysBetween(from: string, to: string): number {
  const start = utcOf(from);
  const end = utcOf(to);
  if (start === undefined || end === undefined) return Number.NaN;
  return Math.round((end - start) / DAY_MS);
}

/** The day `days` after `day`, or `day` itself when it is not a real calendar day. */
function addDays(day: string, days: number): string {
  const at = utcOf(day);
  if (at === undefined) return day;
  const later = new Date(at + days * DAY_MS);
  return `${pad(later.getUTCFullYear(), 4)}-${pad(later.getUTCMonth() + 1, 2)}-${pad(later.getUTCDate(), 2)}`;
}

// ------------------------------------------------------------------------------ the plan

/** What a start-up knows, read from the host and the store. */
export type FirstRunFacts = Readonly<{
  /** The hooks' install record exists (installer.ts's hasInstallRecord of the hooks' root). */
  installed: boolean;
  /** `set-up` is in the folder. */
  setUp: boolean;
  /** `never-ask` is in the folder. */
  never: boolean;
  /** A remote window. */
  remote: boolean;
  /** VS Code's name for the remote, for the log line. */
  remoteName?: string;
  /** The 'YYYY-MM-DD' of every earlier ask, oldest first. */
  asked: readonly string[];
  /** 'YYYY-MM-DD', on this machine's clock. */
  today: string;
}>;

/** What a start-up does: mark the machine set up, ask, or neither, and the line to log. */
export type FirstRunPlan = Readonly<{ markSetUp?: true; ask: boolean; log: string }>;

/**
 * Rules 1, 2, 4 and 5, in that order of weight: set up before, installed now, told never, a
 * remote window, three asks already, too soon since the last one; anything else asks. Pure.
 */
export function planFirstRun(facts: FirstRunFacts): FirstRunPlan {
  if (facts.setUp) return Object.freeze({ ask: false, log: LOG_ALREADY_SET_UP });
  if (facts.installed) return Object.freeze({ markSetUp: true, ask: false, log: LOG_MARKED_SET_UP });
  if (facts.never) return Object.freeze({ ask: false, log: LOG_NEVER });
  if (facts.remote) return Object.freeze({ ask: false, log: logRemote(facts.remoteName) });
  const count = facts.asked.length;
  if (count >= MAX_ASKS) return Object.freeze({ ask: false, log: LOG_DONE_ASKING });
  if (count > 0) {
    // ISO days sort as dates do, so the latest is found whatever order they came in.
    const last = [...facts.asked].sort()[count - 1];
    const gap = GAPS_DAYS[count - 1];
    // Not `<`: a day that cannot be read is never a reason to ask (rule 8).
    if (!(daysBetween(last, facts.today) >= gap)) {
      return Object.freeze({ ask: false, log: logNotYet(last, addDays(last, gap)) });
    }
  }
  return Object.freeze({ ask: true, log: logAsked(count + 1) });
}

// ------------------------------------------------------------------------------ the store

/** The prompt's memory. Reads throw on anything but a file or folder that is not there yet. */
export type FirstRunStore = {
  setUp(): boolean;
  markSetUp(): void;
  never(): boolean;
  markNever(): void;
  /** The days of the asked-* files, sorted; none when the folder does not exist yet. */
  asked(): string[];
  /** Creates `asked-<day>` only if it is not there: true for the window that made it. */
  claimDay(day: string): boolean;
};

const SET_UP_FILE = 'set-up';
const NEVER_FILE = 'never-ask';
const ASKED_PREFIX = 'asked-';

function codeOf(error: unknown): string | undefined {
  try {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { readonly code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
  } catch {
    // A hostile error object reads as having no code.
  }
  return undefined;
}

function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'an error that could not be printed';
  }
}

/**
 * The store in `dir`, which need not exist yet: reads find nothing there, and the first write
 * makes it. Nothing is ever deleted (rule 4), and nothing is written anywhere but `dir`.
 */
export function fileStore(dir: string): FirstRunStore {
  const at = (name: string): string => join(dir, name);
  const present = (name: string): boolean => {
    try {
      statSync(at(name));
      return true;
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return false;
      throw error;
    }
  };
  const write = (name: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(at(name), '');
  };
  return Object.freeze({
    setUp: (): boolean => present(SET_UP_FILE),
    markSetUp: (): void => write(SET_UP_FILE),
    never: (): boolean => present(NEVER_FILE),
    markNever: (): void => write(NEVER_FILE),
    asked: (): string[] => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch (error) {
        if (codeOf(error) === 'ENOENT') return [];
        throw error;
      }
      return names
        .filter((name) => name.startsWith(ASKED_PREFIX))
        .map((name) => name.slice(ASKED_PREFIX.length))
        .filter(isDay)
        .sort();
    },
    claimDay: (day: string): boolean => {
      // Only a real day names a file, so the path can never be steered out of `dir`.
      if (!isDay(day)) throw new Error(`${JSON.stringify(day)} is not a day written YYYY-MM-DD`);
      // Made first and apart: a file where the folder should be answers EEXIST here too, and
      // that is a failure, not another window's claim.
      mkdirSync(dir, { recursive: true });
      try {
        writeFileSync(at(`${ASKED_PREFIX}${day}`), '', { flag: 'wx' });
        return true;
      } catch (error) {
        if (codeOf(error) === 'EEXIST') return false;
        throw error;
      }
    },
  });
}

// ------------------------------------------------------------------------------ the prompt

/** What FirstRunPrompt reads and does; the wiring backs each with VS Code. */
export type FirstRunHost = {
  /** Whether the hooks' install record exists. */
  installed(): boolean;
  /** env.remoteName: undefined in a local window. */
  remote(): string | undefined;
  /** window.state.focused. */
  focused(): boolean;
  /** Resolves on the first window state change that reports focus. */
  whenFocused(): Promise<void>;
  store: FirstRunStore;
  now(): Date;
  /** Whether `node` answers; anything but false reads as found. */
  nodeFound(): Promise<boolean>;
  /**
   * Shows the notification; resolves the button chosen, or undefined when it was closed. One
   * that has faded into the notification centre is still pending until it is clicked or closed.
   */
  ask(message: string, buttons: readonly string[]): Promise<string | undefined>;
  /** Runs Install Hooks, with its own preview and confirm. */
  runInstall(): Promise<unknown>;
  /** Opens https://nodejs.org. */
  openNodeSite(): Promise<unknown>;
  /** A short status-bar note. */
  note(text: string): void;
  log(line: string): void;
};

/** A step that failed, already logged. */
const FAILED = Symbol('failed');

/** The hooks turned out to be in after the start-up's look: mark the machine set up (rule 1). */
const MARK_SET_UP: FirstRunPlan = Object.freeze({
  markSetUp: true,
  ask: false,
  log: LOG_MARKED_SET_UP,
});

/** The day to claim and the plan made from what the start-up read. */
type Look = Readonly<{ today: string; plan: FirstRunPlan }>;

/** Puts the question at most once per run, as the eight rules allow. */
export class FirstRunPrompt {
  readonly #host: FirstRunHost;

  constructor(host: FirstRunHost) {
    this.#host = host;
  }

  /**
   * Looks, and asks if the rules allow: 'asked' once the question has been put (whatever came of
   * it), 'skipped' otherwise. Never rejects. It stays pending while it waits for focus or for an
   * answer, and resolves once the answer, and after Get Node.js the follow-up's, has been acted on.
   */
  async run(): Promise<'asked' | 'skipped'> {
    try {
      return await this.#run();
    } catch (error) {
      this.#log(logFailed('the first-run prompt', messageOf(error)));
      return 'skipped';
    }
  }

  async #run(): Promise<'asked' | 'skipped'> {
    const host = this.#host;
    let look = this.#look();
    if (look === FAILED) return 'skipped';
    if (!look.plan.ask) return this.#settle(look.plan);

    // Rule 3: the day's one ask goes to the window the person is looking at, not one behind it.
    const focused = this.#try('checking whether this window is focused', () => host.focused());
    if (focused === FAILED) return 'skipped';
    if (focused !== true) {
      this.#log(LOG_WAITING_FOR_FOCUS);
      const came = await this.#tryAsync('waiting for this window to be focused', () =>
        host.whenFocused(),
      );
      if (came === FAILED) return 'skipped';
      // Time has passed: another window may have asked or set up, and the day may have turned.
      look = this.#look();
      if (look === FAILED) return 'skipped';
      if (!look.plan.ask) return this.#settle(look.plan);
    }

    // Started before the claim, so the answer is usually in by the time it is needed.
    const node = this.#nodeFound();
    const { today, plan } = look;
    const claimed = this.#try("claiming today's ask", () => host.store.claimDay(today));
    if (claimed === FAILED) return 'skipped';
    if (claimed !== true) {
      this.#log(LOG_CLAIMED_ELSEWHERE);
      return 'skipped';
    }
    const found = await node;

    // Rule 7: set up by another window, or from the command line, since the look above.
    if (this.#markIfInstalled() !== false) return 'skipped';

    const buttons = found ? BUTTONS_WITH_NODE : BUTTONS_WITHOUT_NODE;
    this.#log(plan.log);
    const answer = await this.#tryAsync('showing the question', () =>
      host.ask(found ? ASK_WITH_NODE : ASK_WITHOUT_NODE, buttons),
    );
    if (answer === FAILED) return 'asked';
    const chosen = typeof answer === 'string' ? answer : undefined;
    this.#log(logAnswer(chosen));
    if (chosen === undefined || !buttons.includes(chosen)) return 'asked';

    // Rule 4: the claim above is the count, so Not now needs nothing more.
    if (chosen === SET_IT_UP) {
      await this.#setItUp();
    } else if (chosen === GET_NODE) {
      await this.#tryAsync('opening nodejs.org', () => host.openNodeSite());
      await this.#followUp();
    } else if (chosen === DONT_ASK_AGAIN) {
      const kept = this.#try('remembering not to ask again', () => host.store.markNever());
      // The note promises no more asks, so it shows only once that is written down.
      if (kept !== FAILED) this.#try('showing the note', () => host.note(WONT_ASK_NOTE));
    }
    return 'asked';
  }

  /**
   * Set it up, from the question or the follow-up: runs Install Hooks, then, once it has returned
   * or failed, looks again, so hooks it put in mark this machine set up now (rules 1 and 6), and
   * an Uninstall Hooks later in this same session never brings the question back.
   */
  async #setItUp(): Promise<void> {
    await this.#tryAsync('running Install Hooks', () => this.#host.runInstall());
    this.#markIfInstalled();
  }

  /**
   * After Get Node.js, one follow-up in the same ask: it claims no day and adds nothing to the
   * count (rule 4). It looks again first (rule 7), and its Set it up is the question's.
   */
  async #followUp(): Promise<void> {
    if (this.#markIfInstalled() !== false) return;
    const answer = await this.#tryAsync('showing the follow-up', () =>
      this.#host.ask(ASK_AFTER_NODE, BUTTONS_AFTER_NODE),
    );
    if (answer === FAILED) return;
    const chosen = typeof answer === 'string' ? answer : undefined;
    this.#log(logAnswer(chosen));
    if (chosen === SET_IT_UP) await this.#setItUp();
  }

  /**
   * Reads whether the hooks are installed now. True when they are, and this machine is then
   * marked set up (rule 1), a mark that fails being logged and dropped; false when they are not;
   * FAILED, already logged, when the read itself failed.
   */
  #markIfInstalled(): boolean | typeof FAILED {
    const installed = this.#try('looking for the install record', () => this.#host.installed());
    if (installed === FAILED) return FAILED;
    if (installed !== true) return false;
    this.#settle(MARK_SET_UP);
    return true;
  }

  /** What this start-up knows, and the plan made from it; FAILED once a read has failed. */
  #look(): Look | typeof FAILED {
    const host = this.#host;
    const installed = this.#try('looking for the install record', () => host.installed());
    if (installed === FAILED) return FAILED;
    const known = this.#try('reading the first-run folder', () => ({
      setUp: host.store.setUp(),
      never: host.store.never(),
      asked: host.store.asked(),
    }));
    if (known === FAILED) return FAILED;
    const remoteName = this.#try('reading the remote name', () => host.remote());
    if (remoteName === FAILED) return FAILED;
    const today = this.#try('reading the clock', () => {
      const day = localDay(host.now());
      if (!isDay(day)) throw new Error(`the clock gave no calendar day (${day})`);
      return day;
    });
    if (today === FAILED) return FAILED;
    const remote = typeof remoteName === 'string' && remoteName !== '';
    const facts: FirstRunFacts = Object.freeze({
      installed: installed === true,
      setUp: known.setUp === true,
      never: known.never === true,
      remote,
      remoteName: remote ? remoteName : undefined,
      asked: Object.freeze([...known.asked]),
      today,
    });
    return Object.freeze({ today, plan: planFirstRun(facts) });
  }

  /** A plan that does not ask: marks the machine set up if it says to, and logs its line. */
  #settle(plan: FirstRunPlan): 'skipped' {
    if (plan.markSetUp === true) {
      const marked = this.#try('marking this machine set up', () => this.#host.store.markSetUp());
      if (marked === FAILED) return 'skipped';
    }
    this.#log(plan.log);
    return 'skipped';
  }

  /** The host's Node answer, never a rejection: one that cannot be had reads as found, logged. */
  #nodeFound(): Promise<boolean> {
    const found = (value: unknown): boolean => value !== false;
    const unknown = (error: unknown): boolean => {
      this.#log(logFailed('looking for Node.js', messageOf(error)));
      return true;
    };
    try {
      return Promise.resolve(this.#host.nodeFound()).then(found, unknown);
    } catch (error) {
      return Promise.resolve(unknown(error));
    }
  }

  /** Runs one step; a throw is logged as `<what> failed` and answered with FAILED. */
  #try<R>(what: string, body: () => R): R | typeof FAILED {
    try {
      return body();
    } catch (error) {
      this.#log(logFailed(what, messageOf(error)));
      return FAILED;
    }
  }

  async #tryAsync<R>(what: string, body: () => PromiseLike<R> | R): Promise<R | typeof FAILED> {
    try {
      return await body();
    } catch (error) {
      this.#log(logFailed(what, messageOf(error)));
      return FAILED;
    }
  }

  /** A log that throws, a disposed output channel say, is never a reason to throw here. */
  #log(line: string): void {
    try {
      this.#host.log(line);
    } catch {
      // Nowhere left to report it.
    }
  }
}
