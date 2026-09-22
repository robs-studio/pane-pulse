// The pane model: one pure reducer that says what each pane is, and whether its mark must go.
//
// Every cell of it is written down in the plan, so nothing here is invented. Two kinds of
// input reach it. A hook event carries the state hook/hook.js already computed from
// hook/decision-table.json, and the model takes that state as given rather than re-deriving
// it: tests/drift.test.mjs is what keeps the hook honest, and a second opinion here would
// only be a second place to drift. The hook has also written its own sequence to the
// terminal by the time its event lands, so a hook event never asks the extension for a clear.
// Everything else is a focus input, reported by VS Code, by the pane list or by the liveness
// sweep: a tab selected or left, a row clicked, the window gaining or losing OS focus, a
// terminal closing, a claude process found gone. VS Code makes its own inputs weak
// (onDidChangeActiveTerminal dedupes on object identity, and there is no API for true terminal
// focus).
//
// That weakness is why exactly one question about looking can produce a clear, and why this
// file does not answer it itself: clearsOnFocus() in decision.ts decides whether looking at a
// pane drops its mark. A wrong input about looking can then only ever cost a finished-but-unread
// mark, never a waiting one, which goes when the hook reports a new state (answering, or
// submitting anything else), or when its process is gone (below), and by nothing else. So the
// state that looking clears is never named here.
//
// And only an act counts as looking: `gained`, which is a tab being selected or a row being
// clicked (ruling 17, Rob's decision). There is no input for "this pane is probably being
// watched", such as the active terminal of a focused window, because that is a guess, and a
// guess that clears lets a finished mark disappear unseen: VS Code cannot tell looking at a
// terminal from reading a file with that terminal still selected, and gives no signal at all
// for a hidden panel. The window's own focus still reaches the model, which changes nothing
// for it, from every state.
//
// `gained` is not the only input that ever returns a clear, though: `processGone` is the
// other, and it is a fact about the process, not a guess about looking. The liveness sweep
// sends it only when kill(pid, 0) answers ESRCH (EPERM reads as alive), and it retires the pane
// from every live state with a clear, since a dead claude will never print over its own mark
// again (an idle pane's clear is a harmless write). A pane already gone stays gone with no
// action, because its tab may be another claude's by now.
//
// No I/O, no vscode, no clock: the wiring owns the terminals and the writer owns the pty.
// Every pane and reduction returned is frozen, and the pane passed in is never touched.
import { NOOP, PANE_STATES, clearsOnFocus, isPaneState } from './decision.ts';
import type { PaneState, RowState } from './decision.ts';

/** One pane as the model knows it. Which terminal it is belongs to the mapper, not here. */
export type Pane = { readonly state: PaneState };

/**
 * Every input that is not a hook event. `gained` and `lost` come from onDidChangeActiveTerminal
 * (and `gained` from a pane-list row click as well, the covering path for returning from an
 * editor, and for a pane that finished while its tab was already the selected one);
 * `windowFocused` and `windowBlurred` from onDidChangeWindowState; `terminalClosed` from
 * onDidCloseTerminal; `processGone` from the liveness sweep, when a claude pid no longer
 * answers kill(pid, 0). Nothing here stands for a guess that a pane is being looked at.
 */
export type FocusInputKind =
  | 'gained'
  | 'lost'
  | 'windowFocused'
  | 'windowBlurred'
  | 'terminalClosed'
  | 'processGone';

/** The six focus inputs, so tests and callers enumerate them rather than restate the list. */
export const FOCUS_INPUT_KINDS: readonly FocusInputKind[] = Object.freeze([
  'gained',
  'lost',
  'windowFocused',
  'windowBlurred',
  'terminalClosed',
  'processGone',
]);

/** A hook event carrying the state its row resolved to (the no-op included), or a focus input. */
export type ModelInput =
  | { readonly kind: 'hook'; readonly state: RowState }
  | { readonly kind: FocusInputKind };

/** A pane's next state, plus `clear` when the extension must now drop that pane's mark. */
export type Reduction = { readonly pane: Pane; readonly action?: 'clear' };

/**
 * One frozen pane per state, built from PANE_STATES rather than restated. The model only ever
 * hands these out, so a pane it returned can be compared by identity as well as by value.
 */
const PANES = Object.freeze(
  Object.fromEntries(PANE_STATES.map((state) => [state, Object.freeze({ state })])),
) as Readonly<Record<PaneState, Pane>>;

/** What a pane never seen before reads as: nothing is known about it, so it carries no mark. */
export const INITIAL_PANE: Pane = PANES.idle;

/** What looking leaves behind once it drops a mark: no mark at all, the state INITIAL_PANE has. */
const CLEARED_STATE: PaneState = 'idle';

/** What a pane becomes when its terminal closes or its process is gone, whatever it was before. */
const CLOSED_STATE: PaneState = 'gone';

function fail(message: string): never {
  throw new Error(`pane-pulse model: ${message}`);
}

/**
 * The canonical pane for a state. A state outside the table (a malformed event file, say) is
 * refused by name rather than stored, since a pane in no known state has no glyph to draw.
 */
function paneOf(state: PaneState): Pane {
  if (!isPaneState(state)) {
    fail(`${JSON.stringify(state)} is not a pane state (one of ${PANE_STATES.join(' | ')})`);
  }
  return PANES[state];
}

/** One outcome, frozen. The `action` key exists only when there is an action to take. */
function reduction(pane: Pane, action?: 'clear'): Reduction {
  return Object.freeze(action === undefined ? { pane } : { pane, action });
}

/**
 * The pane's next state for one input, and whether its mark must be cleared. Pure: no I/O,
 * the same answer for the same arguments, and neither argument is mutated. `undefined` is a
 * pane never seen before, which reads as INITIAL_PANE: the cold start, where the very first
 * input may be the Stop that finished a turn before the extension knew the pane at all.
 *
 * - A hook event moves the pane to the state it carries, from any state, and so revives a gone
 *   pane; a no-op event changes nothing, a gone pane included. Never an action: the hook has
 *   already written its own sequence to the terminal.
 * - `gained` clears the mark when clearsOnFocus() says looking clears it, leaving the pane idle;
 *   on any other pane it changes nothing. It is the only input whose clear is about looking.
 * - `lost`, `windowFocused` and `windowBlurred` change nothing, from every state.
 * - `terminalClosed` makes the pane gone, from every state.
 * - `processGone` makes the pane gone and clears its mark, from every live state; a gone pane
 *   stays gone, with no action. With `gained`, the only input that ever returns a clear.
 */
export function reduce(pane: Pane | undefined, input: ModelInput): Reduction {
  const current = pane === undefined ? INITIAL_PANE : paneOf(pane.state);
  switch (input.kind) {
    case 'hook':
      return reduction(input.state === NOOP ? current : paneOf(input.state));
    case 'gained':
      return clearsOnFocus(current)
        ? reduction(PANES[CLEARED_STATE], 'clear')
        : reduction(current);
    case 'lost':
    case 'windowFocused':
    case 'windowBlurred':
      return reduction(current);
    case 'terminalClosed':
      return reduction(PANES[CLOSED_STATE]);
    case 'processGone':
      return current.state === CLOSED_STATE
        ? reduction(current)
        : reduction(PANES[CLOSED_STATE], 'clear');
    default: {
      const unhandled: never = input;
      return fail(`${JSON.stringify(unhandled)} is neither a hook event nor a focus input`);
    }
  }
}
