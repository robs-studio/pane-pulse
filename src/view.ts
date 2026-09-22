// The pane list in words and ids: what the Panes panel and the status bar say, in what order,
// and the commands a row's right-click menu and the panel's gear run.
//
// Rob glances at the panel to decide which of six to nine panes to open, so every order here
// leads with what needs him: a pane waiting for an answer, then one finished and not yet read,
// then one still working, then the quiet ones. The status bar's marks are the glyphs VS Code
// draws in the tab for the sequence each state writes (its `${progress}` renderer maps OSC 9;4
// state 2 to $(error), 3 to $(loading~spin) and 4 to $(alert)), so the bar and a tab can never
// disagree about a pane.
//
// A muted pane is still listed and still followed, but it asks for nothing: it sorts below every
// pane that is not muted (in the same state order among themselves), the words beside its name
// say why it is quiet in place of its state, and it is counted in no state, so the status bar
// never says it aloud; only the bar's tooltip tallies how many are muted.
//
// panel.ts builds the panel from what is here (visibleRows()'s order, the state words and
// rowDescription()'s, the empty message) and decides its buckets, columns, peek and each row's
// menu context; panelView.ts shows that in a webview, and extension.ts registers every command
// named here. The ids live here, with no vscode import, so tests/view.test.mjs can hold them to
// package.json (each contributed once, every right-click item in the plan's group and order,
// every command that needs a row hidden from the palette) and tests/installer.test.mjs can prove
// extension.ts registers each one: a renamed contribution cannot leave a dead menu item behind.
//
// Nothing here decides what looking at a pane clears. That is clearsOnFocus() in decision.ts,
// reached through the controller when a pane is opened or marked seen: only an unread mark goes
// by being looked at, a waiting mark stays until Rob answers, and a second copy of that rule
// would be a second place to get it backwards. So the state that looking clears is never
// compared against in this file.
//
// No vscode import, not even a type: this is the half node --test can hold to the plan. Every
// structure returned is frozen; the caller's rows are never touched.
import { PANE_STATES } from './decision.ts';
import type { PaneState } from './decision.ts';
import type { MuteSource } from './events.ts';

/** The activity-bar container package.json contributes. */
export const CONTAINER_ID = 'panePulse';

/** The Panes panel: the one view inside CONTAINER_ID, a webview panelView.ts provides. */
export const VIEW_ID = 'panePulse.panes';

/** Reveals the Panes panel: the status-bar item's click, and its own palette entry. */
export const SHOW_PANES_COMMAND = 'panePulse.showPanes';

/**
 * A row's Open Pane: shows that pane's terminal and dispatches `gained`, so opening an unread
 * pane marks it read by our own hand. A click or Enter on a row runs the same handler, through
 * the webview's `open` message. Hidden from the palette, like every command below that names a
 * pane: each needs the row VS Code hands a right-click menu item, and a palette entry has none.
 */
export const OPEN_PANE_COMMAND = 'panePulse.openPane';

/**
 * A row's Mark as Seen: clears an unseen pane's mark without opening it, down the same road an
 * open takes (the controller's markSeen). Listed on every row, enabled only on an unseen one.
 */
export const MARK_SEEN_COMMAND = 'panePulse.markSeen';

/**
 * A row's Mute Status, and the Unmute Status that undoes it. Mute is offered on a row that is not
 * muted and Unmute on one muted from here; a row muted by PANE_PULSE_IGNORE in its environment is
 * offered neither, since nothing here can change a running process's environment.
 */
export const MUTE_PANE_COMMAND = 'panePulse.mutePane';
export const UNMUTE_PANE_COMMAND = 'panePulse.unmutePane';

/** A row's Rename…: asks for a new name and gives it to that pane's terminal. */
export const RENAME_PANE_COMMAND = 'panePulse.renamePane';

/** A row's Copy Last Reply: puts Claude's last reply in that pane on the clipboard. */
export const COPY_REPLY_COMMAND = 'panePulse.copyLastReply';

/**
 * A row's /Clear Context: asks first, then types `/clear` into an idle or unseen pane, starting a
 * fresh conversation there (the old one stays in its history).
 */
export const CLEAR_CONTEXT_COMMAND = 'panePulse.clearContext';

/** A row's Interrupt: sends Escape to a pane that is working or waiting for an answer. */
export const INTERRUPT_PANE_COMMAND = 'panePulse.interruptPane';

/** A row's Close Pane: asks first, then closes the terminal and the Claude session in it. */
export const CLOSE_PANE_COMMAND = 'panePulse.closePane';

/**
 * The gear in the panel's title bar: opens Settings at Pane Pulse's own. It needs no row, so it
 * stays in the palette.
 */
export const OPEN_SETTINGS_COMMAND = 'panePulse.openSettings';

/**
 * One pane as the list shows it. `id` is the claude pid as a string (the pid is what every event
 * names, and a row's menu context carries it as text); `terminal` is whatever the wiring needs
 * to open the pane, generic so this module never names a vscode type; `name` is the terminal's
 * own name; `muted`, present only on a muted pane, says why: from here (`marker`) or its
 * environment.
 */
export type PaneRow<T> = {
  readonly id: string;
  readonly terminal: T;
  readonly name: string;
  readonly state: PaneState;
  readonly muted?: MuteSource;
  /**
   * Claude Code's session id for the pane: its latest event's, else the one it had before (an
   * event from the shell-shaped writer carries none), else its session registry entry's. Absent
   * until one of those names it. It changes at a `/clear`, which starts a new session.
   */
  readonly sessionId?: string;
  /** The folder the pane's claude runs in, from its latest event or its registry entry. */
  readonly cwd?: string;
  /**
   * When the pane's latest hook event was written, in milliseconds since the epoch, as the
   * event's own `ts` says. Absent until its first event: a pane listed from the registry alone
   * has sent none yet.
   */
  readonly lastEvent?: number;
};

/**
 * How many panes are in each listed state. A gone pane has retired its row, so it is not here.
 * A muted pane is counted in no state, only in `muted`, which the status bar never shows as a
 * mark: its tooltip alone tallies it.
 */
export type PaneCounts = Readonly<{
  waiting: number;
  unread: number;
  thinking: number;
  idle: number;
  muted: number;
}>;

/** The states a row can be listed in: every count but `muted`, which counts panes, not a state. */
type ListedState = Exclude<keyof PaneCounts, 'muted'>;

/** What each state reads as. The three marks' words are the plan's, verbatim. */
export const STATE_WORDS: Readonly<Record<PaneState, string>> = Object.freeze({
  waiting: 'waiting for you',
  unread: 'ready to read',
  thinking: 'working',
  idle: 'idle',
  gone: 'closed',
});

/**
 * Each state's codicon, as the status bar draws its marks. The three marks are the plan table's
 * glyphs, the ones the tab shows. idle is `circle-outline`, the empty ring VS Code's own Testing
 * view gives a result not yet known: uncoloured, and not a shape anyone reads as a mark. gone is
 * `dash`, a flat line for a pane that has ended, equally unlike the three; it is here so every
 * state has an icon, though visibleRows() drops a gone row before anything draws it. The panel's
 * own icons are its buckets', in panel.ts.
 */
export const STATE_ICONS: Readonly<Record<PaneState, string>> = Object.freeze({
  waiting: 'error',
  unread: 'alert',
  thinking: 'loading~spin',
  idle: 'circle-outline',
  gone: 'dash',
});

/** What a muted row reads as beside its name, in place of its state: the plan's words. */
export const MUTED_WORDS: Readonly<Record<MuteSource, string>> = Object.freeze({
  marker: 'muted',
  env: 'muted by its environment',
});

/** How the status bar's tooltip says the muted panes it leaves out: `, N muted`. */
const MUTED_TALLY = 'muted';

/** Every listed state, most urgent first: the order of the pane list and of the status bar. */
const LISTED_STATES: readonly ListedState[] = Object.freeze([
  'waiting',
  'unread',
  'thinking',
  'idle',
]);

/** The one listed state with no mark: it is counted, but the status bar never says it aloud. */
const UNMARKED_STATE: ListedState = 'idle';

/**
 * The listed states that carry a mark: what the status bar counts aloud. Taken from
 * LISTED_STATES rather than written out, so the bar and the list can only ever agree on order.
 */
const MARKED_STATES: readonly ListedState[] = Object.freeze(
  LISTED_STATES.filter((state) => state !== UNMARKED_STATE),
);

/** The one state that retires a row instead of listing it: a SessionEnd, or a closed terminal. */
const CLOSED_STATE: PaneState = 'gone';

/** The status bar when nothing is marked: the pulse alone, no count, nothing asking for Rob. */
const QUIET_ICON = 'pulse';
const QUIET_TOOLTIP = 'no panes need you';

/** Between two marks in the status bar, so each count stays with its own glyph. */
const MARK_GAP = '  ';

/**
 * What the list says with no panes in it. A pane is listed from its first event, its
 * SessionStart as Claude starts, and only the Pane Pulse hooks write events, so an empty list
 * before they are installed is the honest answer rather than a fault.
 */
export const EMPTY_MESSAGE =
  'No Claude panes yet. A pane shows up here once the Pane Pulse hooks are installed and ' +
  'Claude is running in it.';

/**
 * Natural order for names and pids ("Plan 2" before "Plan 10", pid "9" before "10"), in one
 * fixed locale so the list does not follow whatever locale the machine happens to have.
 */
const COLLATOR = new Intl.Collator('en', { numeric: true });

function fail(message: string): never {
  throw new Error(`pane-pulse view: ${message}`);
}

/**
 * Every pane state is listed or retired, exactly once. Run at load, so a state added to
 * decision.ts is refused by name the moment this module is imported, rather than drawn later
 * with no place in the order.
 */
function checkEveryStatePlaced(): void {
  const placed: readonly PaneState[] = [...LISTED_STATES, CLOSED_STATE];
  const unplaced = PANE_STATES.filter((state) => !placed.includes(state));
  if (unplaced.length > 0 || placed.length !== PANE_STATES.length) {
    fail(
      `the pane list places ${placed.join(' | ')} but the table's states are ` +
        `${PANE_STATES.join(' | ')}; give every state one place, in the order or retired`,
    );
  }
}

checkEveryStatePlaced();

/**
 * The state a row is listed in. A state outside the table (a row built from a malformed event,
 * say) is refused by name rather than sorted anywhere, since it has no glyph and no place.
 */
function listedState(state: PaneState): ListedState {
  const listed = LISTED_STATES.find((candidate) => candidate === state);
  if (listed === undefined) {
    fail(
      `${JSON.stringify(state)} has no place in the pane list ` +
        `(one of ${LISTED_STATES.join(' | ')}, or ${CLOSED_STATE}, which is not listed)`,
    );
  }
  return listed;
}

/**
 * Why a row is muted, or undefined when it is not. A reason outside the two a writer records is
 * refused by name rather than read as either, since it has no words and no menu of its own.
 */
function muteOf(row: Pick<PaneRow<unknown>, 'muted'>): MuteSource | undefined {
  const { muted } = row;
  if (muted === undefined) return undefined;
  if (!Object.hasOwn(MUTED_WORDS, muted)) {
    fail(
      `${JSON.stringify(muted)} is no reason a pane is muted ` +
        `(one of ${Object.keys(MUTED_WORDS).join(' | ')}, or absent when it is not)`,
    );
  }
  return muted;
}

/** A total order on text: natural order, then code units, so no two strings tie by accident. */
function compareText(a: string, b: string): number {
  return COLLATOR.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The rows the list shows, in the order it shows them. A gone row is dropped (its session ended
 * or its terminal closed, so there is nothing left to click); the rest sort waiting, then
 * unread, then thinking, then idle, every muted row after every row that is not, the muted ones
 * in that same state order, and a tie goes by name and then by id, so the same rows always come
 * back in the same order whatever order they arrived in. A new frozen list; the rows in it are
 * the caller's own objects, untouched.
 */
export function visibleRows<T>(rows: readonly PaneRow<T>[]): readonly PaneRow<T>[] {
  // Ranked once, up front, so every row's state and mute are checked even when there is nothing
  // to sort it against: a comparator is never called for a list of one. A muted row's rank is
  // pushed past every listed state's, so the quietest unmuted pane still sorts above it.
  const ranked = rows
    .filter((row) => row.state !== CLOSED_STATE)
    .map((row) => ({
      row,
      rank:
        LISTED_STATES.indexOf(listedState(row.state)) +
        (muteOf(row) === undefined ? 0 : LISTED_STATES.length),
    }));
  ranked.sort(
    (a, b) =>
      a.rank - b.rank || compareText(a.row.name, b.row.name) || compareText(a.row.id, b.row.id),
  );
  return Object.freeze(ranked.map(({ row }) => row));
}

/**
 * How many rows are in each listed state, and how many are muted. A muted row is counted in no
 * state, whatever its state, and gone rows are not counted at all.
 */
export function countRows(rows: readonly Pick<PaneRow<unknown>, 'state' | 'muted'>[]): PaneCounts {
  // Typed rather than built from LISTED_STATES, so the compiler holds it to PaneCounts' keys.
  const counts: Record<keyof PaneCounts, number> = {
    waiting: 0,
    unread: 0,
    thinking: 0,
    idle: 0,
    muted: 0,
  };
  for (const row of rows) {
    if (row.state === CLOSED_STATE) continue;
    const state = listedState(row.state);
    if (muteOf(row) === undefined) counts[state] += 1;
    else counts.muted += 1;
  }
  return Object.freeze(counts);
}

/**
 * The status-bar item's text and tooltip. The text is codicon references, one per marked state
 * that has any panes, most urgent first (`$(error) 1  $(alert) 2  $(loading~spin) 3`), and the
 * tooltip says the same in words. Idle panes carry no mark, so they are not counted aloud; with
 * no marked pane at all the item falls quiet, the pulse alone. Muted panes are never in the
 * text; when there are any, the tooltip ends with how many (`, 2 muted`), so the words still
 * account for every pane the bar leaves out on purpose.
 */
export function statusSummary(counts: PaneCounts): {
  readonly text: string;
  readonly tooltip: string;
} {
  const tally = counts.muted > 0 ? `, ${counts.muted} ${MUTED_TALLY}` : '';
  const marked = MARKED_STATES.filter((state) => counts[state] > 0);
  if (marked.length === 0) {
    return Object.freeze({ text: `$(${QUIET_ICON})`, tooltip: QUIET_TOOLTIP + tally });
  }
  return Object.freeze({
    text: marked.map((state) => `$(${STATE_ICONS[state]}) ${counts[state]}`).join(MARK_GAP),
    tooltip: marked.map((state) => `${counts[state]} ${STATE_WORDS[state]}`).join(', ') + tally,
  });
}

/**
 * The words for a row's state, as the panel shows them: why it is muted when it is, else its
 * state.
 */
export function rowDescription(row: Pick<PaneRow<unknown>, 'state' | 'muted'>): string {
  const muted = muteOf(row);
  return muted === undefined ? STATE_WORDS[row.state] : MUTED_WORDS[muted];
}

/**
 * Every row's id and name, in the order given, as one string: what the names ticker compares
 * from one tick to the next. VS Code fires no event when a terminal is renamed, so the binding
 * reads the names again on a timer and redraws the list only when this has changed, so a quiet
 * tick redraws nothing under the mouse. A row's state and mute are left out on purpose: each of
 * those changes redraws the list on its own. Written as JSON rather than joined on a separator,
 * so no name, whatever it holds, can pass for the boundary between two rows.
 */
export function rowNamesKey(rows: readonly Pick<PaneRow<unknown>, 'id' | 'name'>[]): string {
  return JSON.stringify(rows.map((row) => [row.id, row.name]));
}
