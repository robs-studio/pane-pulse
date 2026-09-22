// The Terminal checkbox: Pane Pulse's switch for VS Code's environment change indicator.
//
// VS Code puts a warning triangle on a terminal's tab when an extension wants to relaunch that
// terminal to change its environment (`terminal.integrated.environmentChangesIndicator`). A
// restart of the extension host issues the built-in Git extension's variables afresh, so every
// Claude pane open at the time gets one, and a Claude pane cannot be relaunched without ending
// its session. Rob asked for a checkbox among Pane Pulse's own settings that turns it off
// (2026-09-22).
//
// planIndicator() decides and IndicatorSync does what it decided through the host handed in, so
// node --test holds both with no VS Code. Four rules:
//
//   * TICKED MEANS OFF. The checkbox drives VS Code's own setting, in the user's settings: while
//     it is ticked, an indicator reading anything but `off` becomes `off`, whether the run is a
//     change of the box or start-up, so a box ticked while VS Code was closed is honoured and a
//     run that failed is simply tried again. Unticked, the indicator goes back to what it was,
//     which may be no value at all.
//   * WHAT WAS THERE IS KEPT FIRST. The value about to be replaced goes into the extension's
//     global state before `off` is written, so the way back exists before anything changes.
//   * ALREADY OFF IS LEFT ALONE. Ticking over an indicator that is already off keeps nothing and
//     writes nothing, so unticking leaves it off, as it was, and `off` is never kept as the value
//     to go back to. That is also what keeps two windows from fighting: every window hears the
//     same change, and one that reads another's `off` keeps nothing.
//   * UNTICKING NEVER UNDOES A HAND. It puts the kept value back only while the indicator still
//     reads `off`; one changed by hand in the meantime is left as it is, and the kept value goes
//     either way. A window whose global state lags another's, and so finds nothing kept, does
//     nothing, and the next start-up's run puts the value back once the state has caught up.
//
// No vscode import: the host reads and writes the two settings and the global state.

/** VS Code's own setting, as a section and a key. */
export const INDICATOR_SECTION = 'terminal.integrated';
export const INDICATOR_KEY = 'environmentChangesIndicator';

/** The value that hides the indicator. */
export const INDICATOR_OFF = 'off';

/** The checkbox, under package.json's `panePulse` section. */
export const DISABLE_INDICATOR_SETTING = 'terminal.disableEnvironmentChangeIndicator';

/** Where the value to go back to is kept, in the extension's global state. */
export const KEPT_INDICATOR_KEY = 'panePulse.environmentChangesIndicator.before';

/** The indicator's user value before `off` was written, or null when it had none. */
export type KeptIndicator = Readonly<{ before: string | null }>;

/**
 * What one run does, in this order: keep `keep`, write `write` (null removes the user value), then
 * forget the kept value. An empty plan does nothing.
 */
export type IndicatorPlan = Readonly<{
  keep?: KeptIndicator;
  write?: string | null;
  forget?: true;
}>;

/** A kept value as the global state holds it, or undefined when nothing is kept. */
export function keptOf(value: unknown): KeptIndicator | undefined {
  if (value === undefined || value === null) return undefined;
  const before = typeof value === 'object' ? (value as { before?: unknown }).before : undefined;
  // Anything else kept there reads as no value to go back to, VS Code's own default.
  return Object.freeze({ before: typeof before === 'string' ? before : null });
}

/**
 * The run the four rules ask for. `want` is the checkbox, `kept` what the global state holds and
 * `current` the indicator's user value; anything but `true` is an unticked box.
 */
export function planIndicator(want: unknown, kept: unknown, current: unknown): IndicatorPlan {
  const off = current === INDICATOR_OFF;
  if (want === true) {
    if (off) return Object.freeze({});
    const before = typeof current === 'string' ? current : null;
    return Object.freeze({ keep: Object.freeze({ before }), write: INDICATOR_OFF });
  }
  const held = keptOf(kept);
  if (held === undefined) return Object.freeze({});
  return Object.freeze(off ? { write: held.before, forget: true } : { forget: true });
}

/** What IndicatorSync reads and writes; the wiring backs each with VS Code. */
export type IndicatorHost = Readonly<{
  /** The checkbox. */
  want: () => unknown;
  /** The indicator's value in the user's settings. */
  current: () => unknown;
  /** The kept value, as the global state holds it. */
  kept: () => unknown;
  /** Keeps a value, or forgets it with undefined. */
  keep: (kept: KeptIndicator | undefined) => PromiseLike<void>;
  /** Writes the indicator's user value, or removes it with undefined. */
  write: (value: string | undefined) => PromiseLike<void>;
  log: (line: string) => void;
}>;

/** How a value reads in the log. */
function shown(value: string | null): string {
  return value === null ? 'no value of its own' : JSON.stringify(value);
}

/** The text of a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Brings the indicator in line with the checkbox, one run at a time. */
export class IndicatorSync {
  readonly #host: IndicatorHost;
  #queue: Promise<void> = Promise.resolve();

  constructor(host: IndicatorHost) {
    this.#host = host;
  }

  /** Runs once after any run still going, so two changes never interleave. Never rejects. */
  sync(): Promise<void> {
    this.#queue = this.#queue.then(() => this.#run());
    return this.#queue;
  }

  async #run(): Promise<void> {
    const host = this.#host;
    let plan: IndicatorPlan;
    try {
      plan = planIndicator(host.want(), host.kept(), host.current());
    } catch (error) {
      host.log(`could not read the environment change indicator's settings: ${messageOf(error)}`);
      return;
    }
    if (plan.keep !== undefined) {
      try {
        await host.keep(plan.keep);
      } catch (error) {
        host.log(
          `left the environment change indicator on, since its value could not be kept first: ` +
            messageOf(error),
        );
        return;
      }
    }
    if (plan.write !== undefined) {
      try {
        await host.write(plan.write ?? undefined);
      } catch (error) {
        // The kept value stays, and the indicator is as it was, so the next run tries again.
        host.log(`could not set the environment change indicator: ${messageOf(error)}`);
        return;
      }
    }
    if (plan.forget === true) await this.#forget();
    if (plan.keep !== undefined) {
      host.log(
        'turned the environment change indicator off, as the checkbox asks; it had ' +
          shown(plan.keep.before),
      );
    } else if (plan.write !== undefined) {
      host.log(`put the environment change indicator back to ${shown(plan.write)}`);
    } else if (plan.forget === true) {
      host.log(
        'left the environment change indicator as it is: it was changed by hand while the ' +
          'checkbox was ticked',
      );
    }
  }

  /** Forgets the kept value, logging a failure rather than throwing it. */
  async #forget(): Promise<void> {
    try {
      await this.#host.keep(undefined);
    } catch (error) {
      this.#host.log(
        `could not forget the environment change indicator's old value: ${messageOf(error)}`,
      );
    }
  }
}
