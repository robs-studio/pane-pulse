// The peek's geometry and the list's keys: where a row's hover card goes, and which row an arrow
// key moves the focus to.
//
// The Panes panel is a webview, and a webview is an iframe clipped to its view (R1), so the peek
// cannot spill past the pane's edge the way a free-floating card would. It floats
// over the list instead, anchored to the row it describes: beside the end of the row's name when
// the card fits there, else against the pane's right margin; below the row when it fits, else
// above. The right margin, where the contract says the left, keeps the columns whole: the model,
// effort and context columns all sit inside a card's width of the right edge, so a card there
// covers them entirely and leaves the covered rows' icons and names readable beside it, where a
// card at the left margin cut the % column in half down the list (seen at Rob's 300px sidebar).
// main.ts measures the row, its name and the card with getBoundingClientRect and hands the
// numbers here, so every placement rule is held by node --test with boxes built in the test, and
// no browser is needed to prove one.
//
// The list's keyboard lives here for the same reason. A roving tabindex moves one focus through
// the rows, and which row ArrowDown, ArrowUp, Home or End lands on is arithmetic that node --test
// can sweep over every position and every list length, the empty list included.
//
// Four rules this file is built around:
//
//   * THE PEEK NEVER LEAVES THE PANE. Whatever the row and the card, the card lands fully inside
//     the pane, `margin` from its edges when there is room for that, and centred in whatever
//     room there is when there is not. Only a card larger than the pane itself cannot fit, and
//     then it is pinned to the pane's top left corner, so its head (the name, the model and the
//     effort) is the part that shows.
//   * THE ROW STAYS IN SIGHT. The card goes below the row, or above it, a small gap away, and
//     never over it while either side has room. Only a pane too short for both puts it on the
//     side with more room, pulled back inside the pane, overlapping the row as little as it can.
//   * NO WRAP-AROUND. ArrowDown on the last row and ArrowUp on the first stay where they are, as
//     VS Code's own lists do. With no row focused, ArrowDown enters at the first row and ArrowUp
//     at the last; a focus left past the end by a shorter list comes back to the last row. Any
//     other key answers the index it was given, so the caller can tell a move from no move.
//   * NUMBERS OR A REFUSAL. Every box and size is finite, no size is negative, and no box ends
//     before it starts; an index is a whole number and a length a whole number of 0 or more.
//     Anything else is a caller's bug, refused by name, never a card placed at NaN.
//
// No import of any kind: this file runs in the webview's browser bundle and under node --test
// alike, so it may reach neither VS Code nor Node. Every result is frozen, and the caller's boxes
// are never touched. Refusals throw by name (`pane-pulse peek: ...`).

/**
 * A rectangle in the pane's own coordinates, as getBoundingClientRect gives one: `left` and
 * `right` are distances from the pane's left edge, `top` and `bottom` from its top edge.
 */
export type Box = Readonly<{ left: number; top: number; right: number; bottom: number }>;

/** A width and a height, in the same units as a Box. */
type Size = Readonly<{ width: number; height: number }>;

/** Where the card's top left corner goes, in the pane's coordinates. */
type Placement = Readonly<{ left: number; top: number }>;

/** What one key does to a focused row's index, given the last index; see nextRowIndex. */
type Move = (current: number, last: number) => number;

/**
 * How long the pointer rests on a row before its peek shows, in ms: long enough that sweeping
 * across the list shows nothing, short enough to feel like an answer when Rob stops on a row.
 */
export const PEEK_DELAY_MS = 350;

/**
 * How long the peek stays after the pointer has left both its row and the card, in ms: time to
 * cross from the row onto the card without the card vanishing on the way.
 */
export const PEEK_HIDE_MS = 120;

/**
 * The room kept between the card and the pane's edges when placePeek is given no margin, in CSS
 * px. It is half of the 16px media/panel.css takes off the pane's width for the card
 * (`min(260px, calc(100vw - 16px))`), so a card at its widest sits exactly this far from both
 * sides; tests/peek.test.mjs reads the stylesheet to hold the two together.
 */
const PEEK_MARGIN = 8;

/**
 * The gap between the row and the card above or below it, in CSS px: enough to read as a card of
 * its own, small enough that the pointer crosses it well inside PEEK_HIDE_MS, and small enough
 * for the card's pointer (drawn by media/panel.css) to reach back to the row.
 */
const ROW_GAP = 4;

/** The keys that move the focus, and where each moves it. */
const MOVES: Readonly<Record<string, Move>> = Object.freeze({
  ArrowDown: (current: number, last: number) => (current < 0 ? 0 : Math.min(current + 1, last)),
  ArrowUp: (current: number, last: number) =>
    current < 0 ? last : Math.max(0, Math.min(current - 1, last)),
  Home: () => 0,
  End: (_current: number, last: number) => last,
});

function fail(message: string): never {
  throw new Error(`pane-pulse peek: ${message}`);
}

/** What a refused argument was, for the refusal's words. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/** The field of an object argument, or a refusal naming the argument when it is no object. */
function fieldOf(what: string, value: unknown, field: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`placePeek takes ${what} as an object, not ${kindOf(value)}`);
  }
  return (value as Readonly<Record<string, unknown>>)[field];
}

function requireFinite(what: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`placePeek takes ${what} as a finite number, not ${String(value)}`);
  }
  return value;
}

function requireBox(row: unknown): void {
  const [left, top, right, bottom] = ['left', 'top', 'right', 'bottom'].map((side) =>
    requireFinite(`the row's ${side}`, fieldOf('the row', row, side)),
  );
  if (right < left) {
    fail(`placePeek takes a row that ends at or after its start, not left ${left} right ${right}`);
  }
  if (bottom < top) {
    fail(`placePeek takes a row that ends at or after its start, not top ${top} bottom ${bottom}`);
  }
}

function requireSize(what: string, size: unknown): void {
  for (const side of ['width', 'height']) {
    const value = requireFinite(`the ${what}'s ${side}`, fieldOf(`the ${what}`, size, side));
    if (value < 0) fail(`placePeek takes the ${what}'s ${side} as 0 or more, not ${value}`);
  }
}

/**
 * The room kept from the pane's edges along one axis: the margin when the card leaves that much
 * on both sides, else whatever centres the card, else none (a card larger than the pane).
 */
function edgeRoom(pane: number, card: number, margin: number): number {
  return Math.min(margin, Math.max(0, (pane - card) / 2));
}

/** The card's left: beside the end of the row's name when it fits there, else the right margin. */
function placeAcross(row: Box, pane: number, card: number, margin: number): number {
  if (card > pane) return 0;
  const low = edgeRoom(pane, card, margin);
  const high = pane - card - low;
  return row.right <= high ? Math.max(low, row.right) : high;
}

/**
 * The card's top: below the row when it fits, else above it; when neither side holds it, the side
 * with more room, pulled back inside the pane.
 */
function placeDown(row: Box, pane: number, card: number, margin: number): number {
  if (card > pane) return 0;
  const low = edgeRoom(pane, card, margin);
  const high = pane - card - low;
  const below = row.bottom + ROW_GAP;
  const above = row.top - ROW_GAP - card;
  if (below >= low && below <= high) return below;
  if (above >= low && above <= high) return above;
  const side = pane - row.bottom >= row.top ? below : above;
  return Math.min(high, Math.max(low, side));
}

/**
 * Where a row's peek goes: its top left corner, in the pane's coordinates.
 *
 * `row` is the row's box with its `right` set to where the row's name ends (main.ts passes the
 * name's right edge, since the name column always runs to the model column, far too far right
 * for the card to fit beside it). The card goes right of that end when it fits inside the pane,
 * else `margin` from the pane's right edge; below the row when it fits, else above; and always
 * fully inside the pane, as this file's rules say. `margin` defaults to 8px, half of what
 * media/panel.css keeps free beside a card at its widest.
 */
export function placePeek(
  row: Box,
  pane: Size,
  peek: Size,
  margin: number = PEEK_MARGIN,
): Placement {
  requireBox(row);
  requireSize('pane', pane);
  requireSize('peek', peek);
  if (requireFinite('the margin', margin) < 0) {
    fail(`placePeek takes the margin as 0 or more, not ${margin}`);
  }
  return Object.freeze({
    left: placeAcross(row, pane.width, peek.width, margin),
    top: placeDown(row, pane.height, peek.height, margin),
  });
}

/**
 * The index of the row the focus moves to when `key` is pressed on the row at `current`, in a
 * list of `count` rows: ArrowDown and ArrowUp one row (no wrap-around), Home the first, End the
 * last. `current` below 0 means no row has the focus; at or past `count`, a list that shrank.
 * An empty list answers -1 for those four keys, and any other key answers `current` unchanged.
 */
export function nextRowIndex(current: number, count: number, key: string): number {
  if (!Number.isInteger(current)) {
    fail(`nextRowIndex takes the current index as a whole number, not ${String(current)}`);
  }
  if (!Number.isInteger(count) || count < 0) {
    fail(`nextRowIndex takes the row count as a whole number of 0 or more, not ${String(count)}`);
  }
  if (typeof key !== 'string') fail(`nextRowIndex takes the key as text, not ${kindOf(key)}`);
  if (!Object.hasOwn(MOVES, key)) return current;
  if (count === 0) return -1;
  return MOVES[key](current, count - 1);
}
