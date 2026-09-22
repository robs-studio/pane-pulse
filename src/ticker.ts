// A ticker: one function run on an interval, started and stopped by the binding.
//
// Two things the pane list shows can only be learned by asking again, because nothing announces
// them. VS Code fires no event when a terminal is renamed (Terminal.name changes in place), so
// the names are re-read every NAME_REFRESH_MS while the Panes view is visible, and not at all
// while it is hidden. And Claude Code fires no SessionEnd when a claude crashes or is killed, so
// every live pane's process is checked every LIVENESS_MS for as long as the extension runs. Both
// are the same small machine, so it lives here once, and extension.ts builds two.
//
// Three rules this file is built around:
//
//   * A TICK NEVER THROWS. The interval's callback runs on the extension host's own event loop,
//     where a throw lands as an uncaught error with no pane named. A run that throws, or answers
//     a promise that rejects, is logged with the interval it came from and dropped; the next
//     tick still runs.
//   * A STOPPED TICKER RUNS NOTHING. Every start arms a fresh token, and a tick runs only while
//     its own token is the armed one, so an interval that outlives its clear (a clearInterval
//     that threw, a clock that ignores it) does nothing. Starting a running ticker, or stopping
//     a stopped one, changes nothing: the view's visibility can be reported twice.
//   * DISPOSED IS FINAL. dispose() stops it and every later start is ignored, so a visibility
//     change that arrives while the extension shuts down cannot re-arm an interval nobody would
//     clear.
//
// No vscode import, and no clock of its own: the timers are injected and default to the global
// setInterval and clearInterval, looked up at each call, so tests/ticker.test.mjs drives every
// rule with a fake clock. A ticker is a VS Code Disposable by shape (a dispose() that takes and
// answers nothing), so it goes into context.subscriptions as it is. The one thing it throws on
// is a wiring fault at construction: a run that is not a function, or a wait that setInterval
// cannot keep, each refused by name.

/** How often the pane names are re-read while the Panes view is visible (D6). */
export const NAME_REFRESH_MS = 2000;

/** How often every live pane's claude is checked for being alive, always (D6). */
export const LIVENESS_MS = 5000;

/**
 * The longest wait setInterval keeps. Node runs a longer one every millisecond instead, with
 * only a warning, so a ticker asked for more is refused rather than left spinning.
 */
const MAX_INTERVAL_MS = 2 ** 31 - 1;

/** Every line this module logs opens with this, as the other modules' lines do. */
const LOG_PREFIX = 'pane-pulse ticker: ';

/** What setInterval hands back, and clearInterval takes back unread. */
type IntervalHandle = ReturnType<typeof setInterval>;

/** The two timer functions a ticker reaches for. The global pair satisfies it as it stands. */
export type IntervalTimers = {
  readonly setInterval: (run: () => void, ms: number) => IntervalHandle;
  readonly clearInterval: (handle: IntervalHandle) => void;
};

/** Everything a ticker reaches for besides its run, each defaulted so production passes a log. */
export type TickerOptions = {
  /** Defaults to the global setInterval and clearInterval, looked up at each call. */
  readonly timers?: IntervalTimers;
  /** Where a failed run is reported: the extension passes its output channel. */
  readonly log?: (line: string) => void;
};

/** The interval armed now: its handle, and the token its ticks must still match to run. */
type Armed = { readonly handle: IntervalHandle; readonly token: object };

/** Looked up when called, not when this module loads, so the default is always the global. */
const GLOBAL_TIMERS: IntervalTimers = Object.freeze({
  setInterval: (run: () => void, ms: number): IntervalHandle => setInterval(run, ms),
  clearInterval: (handle: IntervalHandle): void => clearInterval(handle),
});

/** Only reached when the caller wired no log: the extension host's own log, not silence. */
function defaultLog(line: string): void {
  console.error(line);
}

function fail(message: string): never {
  throw new Error(`${LOG_PREFIX}${message}`);
}

function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'an error that could not be printed';
  }
}

/**
 * The wait between runs. A negative or non-finite one is refused by name, as controller.ts
 * refuses a settle, and so is one longer than setInterval can keep.
 */
function intervalOf(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_INTERVAL_MS) {
    fail(
      `everyMs must be a finite number of milliseconds, 0 or more and at most ${MAX_INTERVAL_MS}, ` +
        `got ${String(value)}`,
    );
  }
  return value;
}

/** A run's answer that is a promise, or looks enough like one to reject later. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}

/**
 * Runs `run` every `everyMs` while started. Nothing runs at the start itself: the first run
 * comes one interval later, as setInterval's does. Every method may be called in any order, any
 * number of times, and none of them throws.
 */
export class Ticker {
  readonly #run: () => void;
  readonly #everyMs: number;
  readonly #timers: IntervalTimers;
  readonly #sink: (line: string) => void;

  /** The interval running now; undefined while stopped. */
  #armed: Armed | undefined;
  #disposed = false;

  /** Throws only on a wiring fault: a run that is not a function, or a wait that is not one. */
  constructor(run: () => void, everyMs: number, options: TickerOptions = {}) {
    if (typeof run !== 'function') fail(`run must be a function, got ${typeof run}`);
    this.#run = run;
    this.#everyMs = intervalOf(everyMs);
    this.#timers = options.timers ?? GLOBAL_TIMERS;
    this.#sink = options.log ?? defaultLog;
  }

  /** Whether an interval is armed now. */
  get running(): boolean {
    return this.#armed !== undefined;
  }

  /**
   * Arms the interval. A running ticker keeps the one it has, and a disposed one is never armed
   * again. A setInterval that throws is logged and leaves it stopped, so the next start retries.
   */
  start(): void {
    if (this.#disposed || this.#armed !== undefined) return;
    const token = {};
    try {
      const handle = this.#timers.setInterval(() => this.#tick(token), this.#everyMs);
      this.#armed = Object.freeze({ handle, token });
    } catch (error) {
      this.#log(`the run every ${this.#everyMs} ms could not start: ${messageOf(error)}`);
    }
  }

  /**
   * Clears the interval. A stopped ticker stays as it is. A clearInterval that throws is logged,
   * and the interval it could not clear runs nothing from here: its token is no longer armed.
   */
  stop(): void {
    const armed = this.#armed;
    if (armed === undefined) return;
    this.#armed = undefined;
    try {
      this.#timers.clearInterval(armed.handle);
    } catch (error) {
      const why = messageOf(error);
      this.#log(`the run every ${this.#everyMs} ms would not clear, so its ticks are ignored: ${why}`);
    }
  }

  /** Runs while `active` and only then: the binding hands in the Panes view's visibility. */
  setActive(active: boolean): void {
    if (active) this.start();
    else this.stop();
  }

  /** Stops it for good: every later start, and every setActive(true), is ignored. */
  dispose(): void {
    this.#disposed = true;
    this.stop();
  }

  /** One tick: the run, while this interval is still the armed one, and nothing it throws. */
  #tick(token: object): void {
    if (this.#armed?.token !== token) return;
    try {
      const answer: unknown = this.#run();
      if (isThenable(answer)) {
        void Promise.resolve(answer).then(undefined, (error: unknown) => this.#dropped(error));
      }
    } catch (error) {
      this.#dropped(error);
    }
  }

  #dropped(error: unknown): void {
    this.#log(`the run every ${this.#everyMs} ms failed, and was dropped: ${messageOf(error)}`);
  }

  #log(line: string): void {
    try {
      this.#sink(`${LOG_PREFIX}${line}`);
    } catch {
      // Nowhere left to report it, and a ticker never throws.
    }
  }
}
