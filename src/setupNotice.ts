// The setup notice: what the Panes panel says at its top while something Pane Pulse needs is
// missing.
//
// The first-run prompt (firstRun.ts) is a one-time nudge: a toast that asks at most three times
// and then never again. Someone who chose Not now or Don't ask again, or who ran Uninstall Hooks,
// still opens the Panes panel to an empty list, and the list alone never says why. So while the
// hooks are not in, or Node.js could not be found, the top of the panel says so, one line each,
// beside the button that fixes it: Set it up runs Install Hooks, Get Node.js opens nodejs.org.
// The toast is the nudge; the panel is the signpost, and each line goes the moment its thing is in.
//
// setupNeeds() decides which lines show from three facts, renderSetupNotice() writes them as
// HTML, withSetupNotice() puts that at the top of the list, and SetupNotice reads the facts and
// runs the buttons through the host handed in, so node --test holds all of it with no VS Code.
// Eleven rules:
//
//   1. THE REAL STATE, NEVER THE PROMPT'S MEMORY. Installed is whether the hooks' install record
//      is there (installer.ts hasInstallRecord(), on activate()'s one root), read afresh; Node.js
//      is the last answer findNode() gave. The first-run folder is never read, so the notice
//      comes back after Uninstall Hooks, after Don't ask again, and after all three asks.
//   2. THE WORDS. HOOKS_LINE with the button Set it up, NODE_LINE with Get Node.js, and
//      NOTICE_LABEL naming the notice for a screen reader. The two button words are firstRun.ts's
//      own, so the toast and the panel always say the same. No em dash, anywhere in this file.
//   3. EITHER, BOTH OR NEITHER, IN ONE ORDER. The hooks line first, then the Node line. With
//      neither, the list's HTML is exactly what it would be without this file.
//   4. NO ANSWER, NO LINE. The Node line shows only after findNode() has answered false. Before
//      its first answer, or after a check that failed, the notice claims nothing about Node.js.
//   5. INSTALLED IS READ AT EVERY RENDER. needs() reads it every time (one stat), and moved() says
//      whether it has changed since, so the 2 s names tick that runs while the panel is on screen
//      redraws within about 2 s of an install or an uninstall from any road. A hidden panel is
//      drawn afresh when it is shown, and the notice's own Set it up redraws it when Install Hooks
//      returns.
//   6. NODE IS ASKED SPARINGLY. One check at activation. Once found, never again in this window:
//      the extension host's PATH is fixed for its life. While not found, checked again when the
//      panel comes on screen, when the window regains focus, and after the notice's Set it up
//      returns; never two at once, and never within NODE_RECHECK_MS of the last start, by the
//      host's clock. An answer redraws only when it changes what needs() would return, and is
//      logged only when it differs from the last one; a check that failed is logged every time.
//   7. A BUTTON RUNS WHAT ALREADY EXISTS. Set it up runs Install Hooks, its preview and modal
//      confirm unchanged; Get Node.js opens nodejs.org. Both buttons run one at a time from the
//      panel: a press while that same button's last run is still going is logged and does
//      nothing. The notice never notifies, never claims a day, never counts as an ask, never
//      writes a file.
//   8. ONLY A LOCAL WINDOW SHOWS IT. In a remote window (SSH, WSL, Codespaces) Install Hooks would
//      write settings the local window never reads, as the first-run prompt's rule 2 says: no
//      lines, no Node checks, and a press is refused. A remote name that cannot be read counts
//      as remote.
//   9. THE LIST STAYS THE LIST. The notice sits inside `#list`, before the counts line or the
//      empty message. It is no part of the panel's model (the counts, the badge and the `.panel`
//      tree are untouched) and carries no `.row` or `.col` class. Its buttons are native
//      <button>s that Tab, Enter and Space reach, and a focused one keeps its focus across a
//      redraw (main.ts). No style attribute, every text escaped, no new command id.
//  10. A CLOSED SET, CHECKED AT THE DOOR. A button names its action in `data-setup`, one of
//      SETUP_ACTIONS. panelView.ts passes on only what isSetupAction() accepts, and act() checks
//      again; anything else is logged and dropped. A need naming anything else is never drawn.
//  11. NEVER THROWS. Every fault is logged under `pane-pulse setup: ` and dropped, act() never
//      rejects, and an installed() that throws means no notice at all.
//
// No vscode import and nothing from node:. The host says whether the hooks are installed and
// whether this is a remote window, looks for Node.js, runs Install Hooks, opens the site, redraws
// the panel and tells the time. escapeHtml() is panel.ts's, so the notice is escaped exactly as
// the list under it is.
import { GET_NODE, SET_IT_UP } from './firstRun.ts';
import { escapeHtml } from './panel.ts';

/** Every line this module logs opens with this, as the other modules' lines do. */
export const LOG_PREFIX = 'pane-pulse setup: ';

// ------------------------------------------------------------------------------ the words

/** The hooks line; the first-run prompt asks in the same words when Node.js was found. */
export const HOOKS_LINE = "Pane Pulse isn't marking your tabs yet: it needs to add hooks to Claude Code.";

/** The Node line, worded couldn't find: a Node.js this PATH cannot see reads as missing. */
export const NODE_LINE =
  "Claude Code runs the hooks with Node.js, and Pane Pulse couldn't find it. Install it, then " +
  'restart VS Code.';

/** The notice's aria-label. */
export const NOTICE_LABEL = 'Pane Pulse setup';

/** The least time between the starts of two Node checks (rule 6). */
export const NODE_RECHECK_MS = 10_000;

// ------------------------------------------------------------------------------ the actions

/** What a notice button can do: run Install Hooks, or open nodejs.org. */
export type SetupAction = 'installHooks' | 'getNode';

/** Every action, in the order the lines show. The page names one in a button's `data-setup`. */
export const SETUP_ACTIONS: readonly SetupAction[] = Object.freeze(['installHooks', 'getNode']);

/** Whether `value` is one of SETUP_ACTIONS, and not a name Object.prototype happens to carry. */
export function isSetupAction(value: unknown): value is SetupAction {
  return typeof value === 'string' && (SETUP_ACTIONS as readonly string[]).includes(value);
}

/** Each action's button, in firstRun.ts's words. */
const BUTTONS: Readonly<Record<SetupAction, string>> = Object.freeze({
  installHooks: SET_IT_UP,
  getNode: GET_NODE,
});

// ------------------------------------------------------------------------------ the log lines

export const LOG_NODE_FOUND = `${LOG_PREFIX}found Node.js, so the panel stops looking for it`;
export const LOG_NODE_MISSING = `${LOG_PREFIX}couldn't find Node.js, so the panel says so`;
export const LOG_INSTALL_BUSY =
  `${LOG_PREFIX}Install Hooks is still running from the panel, so this press does nothing`;
export const LOG_OPEN_BUSY =
  `${LOG_PREFIX}nodejs.org is still opening from the panel, so this press does nothing`;

/** A notice button was pressed, named by the words on it. */
export function logPressed(action: SetupAction): string {
  return `${LOG_PREFIX}pressed ${isSetupAction(action) ? BUTTONS[action] : quoted(action)}`;
}

/** One step that failed, and why. The notice drops it (rule 11). */
export function logFailed(what: string, message: string): string {
  return `${LOG_PREFIX}${what} failed: ${message}`;
}

/** A value for a log line: a string quoted, anything else as String() prints it. */
function quoted(value: unknown): string {
  try {
    return typeof value === 'string' ? JSON.stringify(value) : String(value);
  } catch {
    return 'a value that could not be printed';
  }
}

function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'an error that could not be printed';
  }
}

// ------------------------------------------------------------------------------ the needs

/** What the notice is decided from. */
export type SetupFacts = Readonly<{
  /** The hooks' install record is there. */
  installed: boolean;
  /** findNode()'s last answer; undefined before the first, or after a check that failed. */
  nodeFound: boolean | undefined;
  /** A remote window. */
  remote: boolean;
}>;

/** One line of the notice: what is missing, the words, the button and what the button does. */
export type SetupNeed = Readonly<{
  need: 'hooks' | 'node';
  line: string;
  button: string;
  action: SetupAction;
}>;

const HOOKS_NEED: SetupNeed = Object.freeze({
  need: 'hooks',
  line: HOOKS_LINE,
  button: SET_IT_UP,
  action: 'installHooks',
});

const NODE_NEED: SetupNeed = Object.freeze({
  need: 'node',
  line: NODE_LINE,
  button: GET_NODE,
  action: 'getNode',
});

const NONE: readonly SetupNeed[] = Object.freeze([]);

/**
 * The notice's lines, hooks first (rules 3, 4 and 8): none in a remote window; the hooks line
 * while they are not in; the Node line only once findNode() has answered false. Pure.
 * Facts it cannot read claim nothing.
 */
export function setupNeeds(facts: SetupFacts): readonly SetupNeed[] {
  if (typeof facts !== 'object' || facts === null || facts.remote !== false) return NONE;
  const needs: SetupNeed[] = [];
  if (facts.installed === false) needs.push(HOOKS_NEED);
  if (facts.nodeFound === false) needs.push(NODE_NEED);
  return needs.length === 0 ? NONE : Object.freeze(needs);
}

// ------------------------------------------------------------------------------ the HTML

/**
 * A copy of `value` when it is a need that can be drawn, read once so nothing it holds can change
 * between the check and the render; undefined for anything else, an action outside
 * SETUP_ACTIONS among them (rule 10).
 */
function drawable(value: unknown): SetupNeed | undefined {
  try {
    if (typeof value !== 'object' || value === null) return undefined;
    const { need, line, button, action } = value as Readonly<Record<keyof SetupNeed, unknown>>;
    if (need !== 'hooks' && need !== 'node') return undefined;
    if (typeof line !== 'string' || typeof button !== 'string' || !isSetupAction(action)) {
      return undefined;
    }
    return Object.freeze({ need, line, button, action });
  } catch {
    return undefined;
  }
}

/** One attribute, its value escaped and double-quoted. */
function attr(name: string, value: string): string {
  return ` ${name}="${escapeHtml(value)}"`;
}

/** One line of the notice and its button. */
function renderNeed(need: SetupNeed): string {
  return (
    `<div${attr('class', 'setup-item')}${attr('data-need', need.need)}>` +
    `<p${attr('class', 'setup-line')}>${escapeHtml(need.line)}</p>` +
    `<button${attr('type', 'button')}${attr('class', 'setup-button')}` +
    `${attr('data-setup', need.action)}>${escapeHtml(need.button)}</button></div>`
  );
}

/**
 * The notice's HTML: a labelled section holding each need's line and its native button, in the
 * order given, every text and attribute escaped, no style attribute (rule 9). '' for no needs.
 */
export function renderSetupNotice(needs: readonly SetupNeed[]): string {
  if (!Array.isArray(needs)) return '';
  const drawn: SetupNeed[] = [];
  for (const value of needs as readonly unknown[]) {
    const need = drawable(value);
    if (need !== undefined) drawn.push(need);
  }
  if (drawn.length === 0) return '';
  return (
    `<section${attr('class', 'setup')}${attr('aria-label', NOTICE_LABEL)}>` +
    `${drawn.map(renderNeed).join('')}</section>`
  );
}

/**
 * The list's HTML with the notice at its top, inside `#list` and before the counts line or the
 * empty message; with no needs, `listHtml` itself (rule 3).
 */
export function withSetupNotice(needs: readonly SetupNeed[], listHtml: string): string {
  const notice = renderSetupNotice(needs);
  return notice === '' ? listHtml : notice + listHtml;
}

// ------------------------------------------------------------------------------ the notice

/** What SetupNotice reads and does; the wiring backs each with VS Code. */
export type SetupNoticeHost = Readonly<{
  /** Whether the hooks' install record is there: one stat. */
  installed(): boolean;
  /** env.remoteName: undefined in a local window. */
  remote(): string | undefined;
  /** nodeCheck.ts's findNode(). */
  findNode(): Promise<boolean>;
  /** Runs Install Hooks, with its own preview and confirm. */
  runInstall(): Promise<unknown>;
  /** Opens https://nodejs.org. */
  openNodeSite(): Promise<unknown>;
  /** Draws the panel again. */
  changed(): void;
  /** The time in milliseconds, for the recheck floor. */
  now(): number;
  log(line: string): void;
}>;

/** A step that failed, already logged. */
const FAILED = Symbol('failed');

/** The notice's state in one window: the last reads, the last Node answer, what is running. */
export class SetupNotice {
  readonly #host: SetupNoticeHost;
  /** What needs() last read for installed: undefined before the first read, or after a fault. */
  #seen: boolean | undefined;
  /** findNode()'s last answer: undefined before the first, or after a check that failed. */
  #nodeFound: boolean | undefined;
  /** A Node check is in flight. */
  #checking = false;
  /** When the last Node check started, by the host's clock. */
  #lastStart: number | undefined;
  /** Install Hooks is running from the panel. */
  #installing = false;
  /** nodejs.org is opening from the panel. */
  #opening = false;

  constructor(host: SetupNoticeHost) {
    this.#host = host;
  }

  /**
   * The lines to show now. Reads installed every time and remembers it for moved() (rules 1 and
   * 5); a read that fails means no notice at all (rule 11).
   */
  needs(): readonly SetupNeed[] {
    const installed = this.#installed();
    this.#seen = installed === FAILED ? undefined : installed;
    if (installed === FAILED) return NONE;
    return setupNeeds({
      installed,
      nodeFound: this.#nodeFound,
      remote: this.#remote() !== undefined,
    });
  }

  /**
   * Whether installed now differs from what needs() last read, so the panel is due a redraw
   * (rule 5). Before any read, or after one that failed, a readable answer differs. A read that
   * fails now is logged and reads as not moved.
   */
  moved(): boolean {
    const installed = this.#installed();
    return installed !== FAILED && installed !== this.#seen;
  }

  /**
   * Looks for Node.js if rule 6 allows: never once found, never in a remote window, never with a
   * check in flight, never within NODE_RECHECK_MS of the last start. Returns at once; the answer
   * redraws the panel only when it changes the lines.
   */
  checkNode(): void {
    if (this.#nodeFound === true || this.#checking) return;
    if (this.#remote() !== undefined) return;
    const now = this.#try('reading the clock', () => {
      const time: unknown = this.#host.now();
      if (typeof time !== 'number' || !Number.isFinite(time)) {
        throw new Error(`the clock gave ${quoted(time)}, not a time`);
      }
      return time;
    });
    if (now === FAILED) return;
    // Either way round: a clock set back a moment is still within the floor.
    if (this.#lastStart !== undefined && Math.abs(now - this.#lastStart) < NODE_RECHECK_MS) return;
    this.#checking = true;
    this.#lastStart = now;
    let answer: Promise<unknown>;
    try {
      answer = Promise.resolve(this.#host.findNode());
    } catch (error) {
      answer = Promise.reject(error);
    }
    void answer.then(
      (value) => {
        if (value === true) this.#heard(true, LOG_NODE_FOUND);
        else if (value === false) this.#heard(false, LOG_NODE_MISSING);
        else {
          this.#heard(
            undefined,
            logFailed('looking for Node.js', `it answered ${quoted(value)}, not true or false`),
          );
        }
      },
      (error: unknown) => this.#heard(undefined, logFailed('looking for Node.js', messageOf(error))),
    );
  }

  /**
   * A notice button, pressed. Refused in a remote window (rule 8). Each button runs one at a time
   * (rule 7). Get Node.js opens the site and does nothing else. Set it up runs Install Hooks, and
   * once that has returned or failed, redraws the panel and looks for Node.js again (rules 5 and
   * 6). Never rejects.
   */
  async act(action: SetupAction): Promise<void> {
    try {
      await this.#act(action);
    } catch (error) {
      this.#log(logFailed('a setup button', messageOf(error)));
    }
  }

  async #act(action: SetupAction): Promise<void> {
    if (!isSetupAction(action)) {
      this.#log(logFailed('pressing a setup button', `it named no action (${quoted(action)})`));
      return;
    }
    this.#log(logPressed(action));
    const remote = this.#remote();
    if (remote !== undefined) {
      this.#log(
        logFailed(
          `pressing ${BUTTONS[action]}`,
          `this is a remote window (${remote}), where the panel sets nothing up`,
        ),
      );
      return;
    }
    // Each flag is set before the first await, so a second press while the first runs finds it:
    // a double-click opens nodejs.org once and runs Install Hooks once.
    if (action === 'getNode') {
      if (this.#opening) {
        this.#log(LOG_OPEN_BUSY);
        return;
      }
      this.#opening = true;
      try {
        await this.#tryAsync('opening nodejs.org', () => this.#host.openNodeSite());
      } finally {
        this.#opening = false;
      }
      return;
    }
    if (this.#installing) {
      this.#log(LOG_INSTALL_BUSY);
      return;
    }
    this.#installing = true;
    try {
      await this.#tryAsync('running Install Hooks', () => this.#host.runInstall());
    } finally {
      this.#installing = false;
    }
    this.#try('redrawing the panel', () => this.#host.changed());
    this.checkNode();
  }

  /**
   * A Node check has settled: remember the answer, log it only if it differs from the last one
   * (a failed check every time), and redraw if the lines changed (rule 6). So a window without
   * Node.js says so once, not again at every focus-in that passes the recheck floor.
   */
  #heard(found: boolean | undefined, line: string): void {
    this.#checking = false;
    const last = this.#nodeFound;
    this.#nodeFound = found;
    // Against the last answer, not every line ever said: a Node line a fault took away is said
    // again when it comes back.
    if (found === undefined || found !== last) this.#log(line);
    if ((found === false) !== (last === false)) {
      this.#try('redrawing the panel', () => this.#host.changed());
    }
  }

  /** installed(), read now; FAILED, logged, when it throws or answers neither true nor false. */
  #installed(): boolean | typeof FAILED {
    const installed: unknown = this.#try('looking for the install record', () =>
      this.#host.installed(),
    );
    if (installed === FAILED || typeof installed === 'boolean') return installed;
    this.#log(
      logFailed('looking for the install record', `it answered ${quoted(installed)}, not true or false`),
    );
    return FAILED;
  }

  /** The remote's name, or undefined in a local window; one that cannot be read counts as remote. */
  #remote(): string | undefined {
    const name: unknown = this.#try('reading the remote name', () => this.#host.remote());
    if (name === undefined || name === '') return undefined;
    return typeof name === 'string' ? name : 'unknown';
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
