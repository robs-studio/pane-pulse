// The Panes panel's script: it swaps in the list the extension renders, keeps the keyboard focus
// and the scroll where they were, opens a pane on a click or Enter, and floats a row's peek over
// the list while the pointer rests on that row.
//
// Everything the panel shows is decided in the extension host. src/panel.ts renders the whole
// list as one string of HTML, every class and attribute included, and the extension posts it here
// as `{type: 'render', html}`. This script owns only what a string cannot: where the focus and the
// scroll are, which row the pointer rests on, and where the peek card goes (placed by peek.ts,
// where node --test holds the geometry). It posts `{type: 'ready'}` once it can take a render,
// and `{type: 'open', id}` when Rob clicks a row or presses Enter on one.
//
// Six rules this file is built around:
//
//   * THE EXTENSION DECIDES, THIS SCRIPT ONLY SHOWS. No word, class or colour is made here: a
//     render replaces the list whole, and a peek is a clone of its row's own <template>. So what
//     Rob sees can only be what panel.ts's tests hold.
//   * NO INLINE STYLE (P1). The webview's CSP refuses `style` attributes, so nothing here writes
//     one or builds markup holding one. The only styles set are CSSOM properties, which the CSP
//     allows: the card's left and top, and each context bar's width, read from its `data-pct`.
//   * NEVER STEAL THE FOCUS. A render lands every few seconds while Rob types in a terminal, so
//     the focus goes back to a row only when the panel had it before the render. Otherwise only
//     the roving tabindex moves, ready for when Rob tabs in.
//   * THE MENU IS VS CODE'S. This script never listens for `contextmenu`: VS Code's webview host
//     passes over an event whose default was prevented, and the row's native menu would never
//     appear. A right-click never opens a pane either: `click` fires for the primary button only,
//     and a Ctrl-click (macOS's right-click, a multi-select in VS Code's own lists) is passed over.
//   * THE PEEK FLOATS, AND NEVER MOVES THE LIST. It is one fixed overlay beside the list, shown
//     PEEK_DELAY_MS after the pointer stops on a row that has a peek, kept while the pointer is on
//     that row or on the card, and hidden PEEK_HIDE_MS after it has left both; hidden at once on a
//     scroll, a press in the list, Escape, or a render that drops its row; and refreshed in place,
//     content and position, by a render that keeps its row. It carries the list's menu context,
//     so a right-click on it raises no menu either.
//   * ONE ROW TAKES TAB. Exactly one row carries tabindex 0 after every render: the one Rob last
//     focused while it is still listed, else the active terminal's row, else the first. Arrows,
//     Home and End move it through nextRowIndex(), and Enter opens the pane it rests on.
//
// Imports only ./peek.ts, which imports nothing, so the bundle esbuild makes for the browser holds
// no Node and no VS Code; acquireVsCodeApi is declared here, since VS Code puts it on the page. A
// message this script does not know is ignored, never thrown on.
import { PEEK_DELAY_MS, PEEK_HIDE_MS, nextRowIndex, placePeek } from './peek.ts';
import type { Box } from './peek.ts';

/** What VS Code puts on a webview's page: the one way to post back to the extension. */
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

/** A message this script posts to the extension. */
type ToExtension = Readonly<{ type: 'ready' }> | Readonly<{ type: 'open'; id: string }>;

/** The one message this script takes from the extension: the whole list, as HTML. */
type RenderMessage = Readonly<{ type: 'render'; html: string }>;

/** Which side of its row the card went, for the pointer media/panel.css draws on it. */
type Side = 'below' | 'above' | 'over';

/** A pane's row, as panel.ts renders it; its `data-id` is the pane's id. */
const ROW_SELECTOR = '.row';

/** A row's name, whose right edge anchors the peek. */
const NAME_SELECTOR = '.name';

/** A row's peek card, in the <template> the overlay clones it from. */
const TEMPLATE_SELECTOR = 'template[data-peek-for]';

/** A peek's context bar fill, whose width comes from its `data-pct`. */
const FILL_SELECTOR = '.peek-fill[data-pct]';

/** The class of the active terminal's row (R10), which takes Tab until Rob focuses a row. */
const ACTIVE_CLASS = 'active';

/**
 * The keys nextRowIndex() moves the focus on. A press of one is taken from the page, so the page
 * does not scroll on top of the move; tests/peek.test.mjs holds this list to peek.ts's keys.
 */
const NAV_KEYS: ReadonlySet<string> = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

/**
 * The context every spot in the list and the peek card carries, which a row's own context
 * extends: VS Code's Cut, Copy and Paste left off, so a right-click on a header, a gap or the
 * card raises no menu at all.
 */
const LIST_CONTEXT = JSON.stringify({ preventDefaultContextMenuItems: true });

const vscode = acquireVsCodeApi();
const list = pageElement('list');
const peek = pageElement('peek');

/** The row Rob last focused, which keeps Tab through a render while it is still listed. */
let rememberedId: string | undefined;

/** The row under the pointer, when it is on one. */
let pointerRowId: string | undefined;

/** Whether the pointer is on the card. */
let overPeek = false;

/** The row whose peek is up, and the template HTML it was cloned from. */
let shownId: string | undefined;
let shownHtml: string | undefined;

/** The pending show and the pending hide. */
let showTimer: number | undefined;
let hideTimer: number | undefined;

/** The page's element with this id: the shell's own, else one made so that a render lands. */
function pageElement(id: 'list' | 'peek'): HTMLElement {
  const found = document.getElementById(id);
  if (found !== null) return found;
  const made = document.createElement('div');
  made.id = id;
  if (id === 'peek') {
    made.className = 'peek';
    made.hidden = true;
  }
  document.body.append(made);
  return made;
}

function post(message: ToExtension): void {
  vscode.postMessage(message);
}

function isRender(data: unknown): data is RenderMessage {
  if (typeof data !== 'object' || data === null) return false;
  const message = data as Readonly<Record<string, unknown>>;
  return message.type === 'render' && typeof message.html === 'string';
}

/** Every row in the list, top to bottom. */
function rowsOf(): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(ROW_SELECTOR)];
}

/** The list row an event target sits in, if it sits in one. */
function rowOf(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) return undefined;
  const row = target.closest<HTMLElement>(ROW_SELECTOR);
  return row !== null && list.contains(row) ? row : undefined;
}

function rowById(id: string): HTMLElement | undefined {
  return rowsOf().find((row) => row.dataset.id === id);
}

function templateFor(id: string): HTMLTemplateElement | undefined {
  return [...list.querySelectorAll<HTMLTemplateElement>(TEMPLATE_SELECTOR)].find(
    (template) => template.dataset.peekFor === id,
  );
}

/** Gives Tab to one row, and takes it from every other. */
function setRoving(target: HTMLElement, rows: readonly HTMLElement[]): void {
  for (const row of rows) row.tabIndex = row === target ? 0 : -1;
}

/** Swaps in a render, keeping the scroll, the focused row and the peek where they were. */
function render(html: string): void {
  const scroller = document.scrollingElement ?? document.documentElement;
  const scrollTop = scroller.scrollTop;
  const focused = rowOf(document.activeElement);
  const refocus = focused !== undefined && document.hasFocus();
  const focusedIndex = focused === undefined ? -1 : rowsOf().indexOf(focused);
  list.innerHTML = html;
  scroller.scrollTop = scrollTop;
  const rows = rowsOf();
  const kept =
    rememberedId === undefined ? undefined : rows.find((row) => row.dataset.id === rememberedId);
  // A focused row that left the list hands the focus to whichever row took its place.
  const target =
    kept ??
    (refocus ? rows[Math.min(focusedIndex, rows.length - 1)] : undefined) ??
    rows.find((row) => row.classList.contains(ACTIVE_CLASS)) ??
    rows[0];
  if (target !== undefined) {
    setRoving(target, rows);
    if (refocus) target.focus({ preventScroll: true });
  }
  refreshPeek();
}

function onClick(event: MouseEvent): void {
  if (event.button !== 0 || event.ctrlKey) return;
  const id = rowOf(event.target)?.dataset.id;
  if (id !== undefined) post({ type: 'open', id });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  const row = rowOf(event.target);
  if (event.key === 'Enter') {
    const id = row?.dataset.id;
    if (id === undefined || event.repeat) return;
    event.preventDefault();
    post({ type: 'open', id });
    return;
  }
  if (!NAV_KEYS.has(event.key)) return;
  event.preventDefault();
  const rows = rowsOf();
  const current = row === undefined ? -1 : rows.indexOf(row);
  const next = rows[nextRowIndex(current, rows.length, event.key)];
  if (next === undefined) return;
  setRoving(next, rows);
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: 'nearest' });
}

function onFocusIn(event: FocusEvent): void {
  const row = rowOf(event.target);
  if (row === undefined) return;
  setRoving(row, rowsOf());
  rememberedId = row.dataset.id;
}

/** The pointer is now on this row, or on no row: start its peek, and settle the one that is up. */
function pointerOnRow(id: string | undefined): void {
  if (id === pointerRowId) return;
  pointerRowId = id;
  cancelShow();
  if (id !== undefined && id !== shownId) {
    showTimer = window.setTimeout(() => {
      showTimer = undefined;
      if (pointerRowId === id) showPeek(id);
    }, PEEK_DELAY_MS);
  }
  settleHide();
}

function onPointerOver(event: PointerEvent): void {
  if (event.pointerType !== 'touch') pointerOnRow(rowOf(event.target)?.dataset.id);
}

function onPointerOut(event: PointerEvent): void {
  if (event.pointerType !== 'touch') pointerOnRow(rowOf(event.relatedTarget)?.dataset.id);
}

function cancelShow(): void {
  window.clearTimeout(showTimer);
  showTimer = undefined;
}

/** Keeps the peek while the pointer is on its row or on it; else hides it PEEK_HIDE_MS from now. */
function settleHide(): void {
  if (shownId === undefined || overPeek || pointerRowId === shownId) {
    window.clearTimeout(hideTimer);
    hideTimer = undefined;
    return;
  }
  hideTimer ??= window.setTimeout(() => {
    hideTimer = undefined;
    hidePeek();
  }, PEEK_HIDE_MS);
}

/** Puts a template's card in the overlay, with each bar's width set from its data-pct. */
function fillPeek(template: HTMLTemplateElement): void {
  peek.replaceChildren(template.content.cloneNode(true));
  shownHtml = template.innerHTML;
  for (const fill of peek.querySelectorAll<HTMLElement>(FILL_SELECTOR)) {
    const pct = Number(fill.dataset.pct);
    fill.style.width = `${Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0}%`;
  }
}

/** Places the overlay against its row, as peek.ts decides, and marks the side it went. */
function placeCard(row: HTMLElement): void {
  const card = peek.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  const name = row.querySelector(NAME_SELECTOR);
  const anchor: Box = {
    left: rowBox.left,
    top: rowBox.top,
    right: name === null ? rowBox.left : Math.max(rowBox.left, name.getBoundingClientRect().right),
    bottom: rowBox.bottom,
  };
  const pane = {
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  };
  const at = placePeek(anchor, pane, { width: card.width, height: card.height });
  const side: Side =
    at.top >= anchor.bottom ? 'below' : at.top + card.height <= anchor.top ? 'above' : 'over';
  peek.style.left = `${Math.round(at.left)}px`;
  peek.style.top = `${Math.round(at.top)}px`;
  peek.dataset.side = side;
}

/** Shows a row's peek, when the row is still listed and carries one. */
function showPeek(id: string): void {
  const template = templateFor(id);
  const row = rowById(id);
  if (template === undefined || row === undefined) return;
  fillPeek(template);
  shownId = id;
  peek.hidden = false;
  placeCard(row);
  settleHide();
}

/** After a render: the peek follows its row, with the row's new card; it goes when the row goes. */
function refreshPeek(): void {
  if (shownId === undefined) return;
  const template = templateFor(shownId);
  const row = rowById(shownId);
  if (template === undefined || row === undefined) {
    hidePeek();
    return;
  }
  if (template.innerHTML !== shownHtml) fillPeek(template);
  placeCard(row);
}

function hidePeek(): void {
  window.clearTimeout(hideTimer);
  hideTimer = undefined;
  shownId = undefined;
  shownHtml = undefined;
  overPeek = false;
  peek.hidden = true;
  peek.replaceChildren();
  delete peek.dataset.side;
}

/** A scroll, a press or Escape: the peek goes now, and one still pending never comes. */
function dismissPeek(): void {
  cancelShow();
  hidePeek();
}

function onScroll(event: Event): void {
  if (event.target instanceof Node && peek.contains(event.target)) return;
  // The rows have moved under the pointer; the next row it reports starts a peek afresh.
  pointerRowId = undefined;
  dismissPeek();
}

function start(): void {
  list.dataset.vscodeContext = LIST_CONTEXT;
  // The card sits outside the list, so it carries the same context. A press on it keeps it up,
  // so its text can still be read and selected; only a press in the list dismisses it.
  peek.dataset.vscodeContext = LIST_CONTEXT;
  peek.setAttribute('aria-hidden', 'true');
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (isRender(event.data)) render(event.data.html);
  });
  list.addEventListener('click', onClick);
  list.addEventListener('keydown', onKeydown);
  list.addEventListener('focusin', onFocusIn);
  list.addEventListener('pointerover', onPointerOver);
  list.addEventListener('pointerout', onPointerOut);
  list.addEventListener('pointerdown', dismissPeek);
  peek.addEventListener('pointerenter', () => {
    overPeek = true;
    settleHide();
  });
  peek.addEventListener('pointerleave', () => {
    overPeek = false;
    settleHide();
  });
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') dismissPeek();
  });
  post({ type: 'ready' });
}

start();
