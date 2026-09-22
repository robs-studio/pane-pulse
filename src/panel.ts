// The panel: the Panes dashboard as a view model, and that model as the HTML the webview shows.
//
// The panel groups every Claude pane under five status buckets: Needs You, Unseen, Working,
// Idle and Muted. A counts line on top names each bucket that has a pane, `1 unseen · 5 idle`,
// and each bucket drawn is headed by its title and its count, with no icon: only a row carries
// one. A row carries the pane's status icon, its name, then three aligned columns: the model's
// family, the effort word and how full its context is. Hovering a row shows its peek: the name
// with the model and effort as an accent, the state and when the pane last did anything, its last
// prompt, a grid of Model, Effort, Context and Session, and a bar filled to the context percentage.
// Right-clicking a row raises VS Code's own menu, which reads the row's `data-vscode-context`.
//
// buildPanel() turns the controller's rows and each pane's details into that model, and
// renderPanel() turns the model into one string of HTML. The webview script only swaps the
// string in, clones a row's peek out of its <template>, and sets the bar's width from its
// `data-pct`; every word, order, class and attribute is decided here, where node --test holds it
// to the plan.
//
// Six rules this file is built around:
//
//   * NO INLINE STYLE, EVER (P1). The webview's CSP allows styles only from the extension's own
//     files, and Chromium drops every `style="..."` attribute under it. So nothing here writes a
//     `style` attribute: a colour rides a class (`s-<bucket>` for a status, `c-<level>` for a
//     context level), media/panel.css maps each class to its theme colour variable, and the
//     bar's width travels as `data-pct` for the script to set through the CSSOM.
//   * EVERY TEXT AND EVERY ATTRIBUTE IS ESCAPED. A terminal's name and a pane's last prompt are
//     whatever someone typed, and this string becomes live HTML inside the webview. So every
//     piece of text and every attribute value, a class included, goes through escapeHtml(), and
//     every attribute is double-quoted, so nothing a pane holds can open a tag, close the
//     <template> it sits in, or add an attribute of its own.
//   * EVERY BUCKET MODELLED, ONLY A FILLED ONE DRAWN, IN ONE ORDER. The model always holds the
//     five buckets in BUCKETS order, an empty one with a count of 0, since the badge reads them.
//     The render draws only the buckets with a pane in them, under the counts line, which names
//     the same buckets in the same order (panel-v3, replacing v2's rule that an empty Working
//     stays as a header). The order never changes, so a bucket that fills appears in its own
//     place. Only a list with no panes at all says EMPTY_MESSAGE instead.
//   * A ROW'S BUCKET IS bucketOf()'S ANSWER, AND ITS ORDER IS visibleRows()'S. A muted pane goes
//     to Muted whatever its state; the rest go by state. A gone pane has retired its row, so it
//     is never drawn, and asking for its bucket is refused. Inside a bucket the rows keep the
//     order visibleRows() gives the names as the row shows them, spinner stripped, so a pane
//     does not jump about its bucket as Claude Code's title glyph comes and goes.
//   * NO DATA, NO GUESS. A column with nothing to show reads `—`; the peek leaves out a line it
//     has nothing for, and the lines changed join the session only once they have been counted.
//     A details field of the wrong type reads as absent, as details.ts reads a transcript.
//   * A SETTING NEVER BREAKS THE LIST. The peek switch and the two context thresholds come from
//     the member's settings, which can hold anything once hand-edited, so a malformed value falls
//     back to its default (CONTEXT_THRESHOLDS, the peek on) rather than blanking the list. What
//     the wiring itself hands in (the rows, the details lookup, the time, the active pane) is
//     refused by name when it is malformed, since that is a bug to see in the log.
//
// Imports only from view.ts and details.ts, and PaneDetails from detailsStore.ts as a type, so the
// disk-reading store is never loaded from here; nothing from vscode and nothing from node:. It
// still runs in the extension host rather than the webview, since view.ts loads decision.ts,
// which reads the decision table off the disk. Every structure returned is frozen, and the
// caller's rows and details are never touched. Refusals throw by name (`pane-pulse panel: ...`).
import { formatAgo, formatDuration, formatTokens, stripSpinner } from './details.ts';
import type { PaneDetails } from './detailsStore.ts';
import { EMPTY_MESSAGE, STATE_WORDS, rowDescription, visibleRows } from './view.ts';
import type { PaneRow } from './view.ts';

/** The five status buckets a pane can be listed under. */
export type Bucket = 'needsYou' | 'unseen' | 'working' | 'idle' | 'muted';

/** Every bucket, in the order the panel draws them: most urgent first, Muted last. */
export const BUCKETS: readonly Bucket[] = Object.freeze([
  'needsYou',
  'unseen',
  'working',
  'idle',
  'muted',
]);

/** Each bucket's title as written; the CSS sets it in capitals. */
export const BUCKET_TITLES: Readonly<Record<Bucket, string>> = Object.freeze({
  needsYou: 'Needs you',
  unseen: 'Unseen',
  working: 'Working',
  idle: 'Idle',
  muted: 'Muted',
});

/**
 * Each bucket's codicon, before each of its rows; a bucket's header carries none. The circled X,
 * the warning triangle and the spinner the tab draws for the three marks, and the hollow ring for
 * the two quiet buckets. The spinner turns only with `codicon-modifier-spin`, which the renderer
 * adds for Working.
 */
export const BUCKET_ICONS: Readonly<Record<Bucket, string>> = Object.freeze({
  needsYou: 'error',
  unseen: 'warning',
  working: 'loading',
  idle: 'circle-outline',
  muted: 'circle-outline',
});

/**
 * Each bucket's theme colour id, contributed by package.json so a member can change it in
 * `workbench.colorCustomizations` (R4). The CSS reads each as cssVarOf(id) through the bucket's
 * `s-<bucket>` class.
 */
export const STATUS_COLOR_IDS: Readonly<Record<Bucket, string>> = Object.freeze({
  needsYou: 'panePulse.needsYouForeground',
  unseen: 'panePulse.unseenForeground',
  working: 'panePulse.workingForeground',
  idle: 'panePulse.idleForeground',
  muted: 'panePulse.mutedForeground',
});

/** The context column's theme colour ids by level, read through each `c-<level>` class. */
export const CONTEXT_COLOR_IDS: Readonly<{ low: string; mid: string; high: string }> =
  Object.freeze({
    low: 'panePulse.contextLowForeground',
    mid: 'panePulse.contextMidForeground',
    high: 'panePulse.contextHighForeground',
  });

/** The peek accent's theme colour id (the model and effort beside the peek's name). */
export const PEEK_ACCENT_COLOR_ID = 'panePulse.peekAccentForeground';

/**
 * Where the context colour steps up (R13): amber from 50%, red from 80%, green below. The
 * defaults of the two settings, and what the panel falls back to when those are malformed.
 */
export const CONTEXT_THRESHOLDS: Readonly<{ mid: 50; high: 80 }> = Object.freeze({
  mid: 50,
  high: 80,
});

/**
 * What buildPanel needs besides the rows. `activeId` is the row whose terminal is the active one
 * (R10); `now` is the time the ages and durations are measured to, in ms; `peek` is whether rows
 * carry a peek at all; `thresholds` are the context percentages where the colour turns amber
 * (`mid`) and red (`high`).
 */
export type PanelOptions = Readonly<{
  activeId?: string;
  now: number;
  peek: boolean;
  thresholds: Readonly<{ mid: number; high: number }>;
}>;

/**
 * A row's `data-vscode-context`, which VS Code hands the `webview/context` menu: every key is a
 * `when` clause key, and the command receives the object. `preventDefaultContextMenuItems` hides
 * Cut, Copy and Paste.
 */
export type MenuContext = Readonly<{
  webviewSection: 'pane';
  paneId: string;
  paneBucket: Bucket;
  paneMute: 'none' | 'marker' | 'env';
  preventDefaultContextMenuItems: true;
}>;

/**
 * One row as the panel draws it. `name` is the terminal's name with Claude Code's title glyph
 * stripped; `icon` is its bucket's codicon; `stateWord` is its state (or why it is muted) in
 * view.ts's words; `model`, `effort` and `context` are the three columns, each `—` when unknown;
 * `contextLevel` picks the context colour; `active` marks the active terminal's row; `menu` is its
 * right-click context; `peek` is its hover card, absent when the peek is switched off.
 */
export type PanelRow = Readonly<{
  id: string;
  name: string;
  bucket: Bucket;
  icon: string;
  stateWord: string;
  model: string;
  effort: string;
  context: string;
  contextLevel: 'low' | 'mid' | 'high' | 'none';
  active: boolean;
  menu: MenuContext;
  peek?: PeekModel;
}>;

/**
 * One row's peek. `accent` is the model's name and the effort (`Opus 5 · XHigh`); `stateLine` the
 * state and last activity (`Idle · last activity 22m ago`), or why it is muted; `prompt` the last
 * prompt, unquoted; `model`, `effort`, `context` and `session` the grid's four values (`Opus 5`,
 * `XHigh`, `8% · 140k · cache 100%`, `33m · +21/−0`); `contextPct` fills the bar. A text field
 * is empty, and `prompt` and `contextPct` are absent, when there is nothing to show, and the
 * renderer leaves that line out.
 */
export type PeekModel = Readonly<{
  name: string;
  accent: string;
  stateLine: string;
  prompt?: string;
  model: string;
  effort: string;
  context: string;
  session: string;
  contextPct?: number;
}>;

/** One bucket as the panel draws it: its header and its rows. */
type PanelBucket = Readonly<{
  bucket: Bucket;
  title: string;
  count: number;
  rows: readonly PanelRow[];
}>;

/**
 * The whole panel. `empty` is true only when no pane is listed, and then the list shows
 * `emptyMessage` instead of the buckets; `buckets` always holds every bucket in BUCKETS order,
 * and the render draws only those with a pane.
 */
export type PanelModel = Readonly<{
  empty: boolean;
  emptyMessage: string;
  buckets: readonly PanelBucket[];
}>;

/** A pane's state, and why it is muted, as view.ts's rows carry them. */
type PaneState = PaneRow<unknown>['state'];
type MuteSource = NonNullable<PaneRow<unknown>['muted']>;

/** A context level: which colour the context column and the peek bar take. */
type ContextLevel = PanelRow['contextLevel'];

/** The context percentages where the colour turns amber (`mid`) and red (`high`). */
type Thresholds = Readonly<{ mid: number; high: number }>;

/** PanelOptions once checked: the wiring's values as given, the settings' ones defaulted. */
type CheckedOptions = Readonly<{
  activeId: string | undefined;
  now: number;
  peek: boolean;
  thresholds: Thresholds;
}>;

/** The one state that retires a row instead of listing it. */
const GONE = 'gone';

/** The bucket of each listed state, for a pane that is not muted. */
const STATE_BUCKETS: Readonly<Record<Exclude<PaneState, typeof GONE>, Bucket>> = Object.freeze({
  waiting: 'needsYou',
  unread: 'unseen',
  thinking: 'working',
  idle: 'idle',
});

/** The bucket every muted pane goes to, whatever its state. */
const MUTED_BUCKET: Bucket = 'muted';

/** The bucket whose icon spins, and the codicon class that spins it. */
const SPIN_BUCKET: Bucket = 'working';
const SPIN_CLASS = 'codicon-modifier-spin';

/** The bucket the activity-bar badge counts (R13). */
const BADGE_BUCKET: Bucket = 'needsYou';

/** A muted pane's peek state line, by why it is muted. */
const MUTED_STATE_LINES: Readonly<Record<MuteSource, string>> = Object.freeze({
  marker: 'Muted by you',
  env: 'Muted by its environment',
});

/** Every context level a class can name. */
const CONTEXT_LEVELS: readonly ContextLevel[] = Object.freeze(['low', 'mid', 'high', 'none']);

/** What a column shows when there is nothing to show: the dash of U+2014. */
const NO_VALUE = '—';

/** Between two parts of one line (`Opus 5 · XHigh`): a middle dot, U+00B7, spaced. */
const PART_GAP = ' · ';

/** The minus sign in a session's lines changed (`+21/−0`): U+2212, as the mockup writes it. */
const MINUS = '−';

/** The curly quotes around the peek's last prompt, U+201C and U+201D. */
const OPEN_QUOTE = '“';
const CLOSE_QUOTE = '”';

/** The list's accessible name. */
const PANEL_LABEL = 'Panes';

/** A codicon name: what may follow `codicon-` in a class. */
const CODICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A theme colour id, as VS Code's colour registry accepts one. */
const COLOR_ID = /^\w+(?:\.\w+)*$/;

/** The peek on, when its setting holds something other than true or false. */
const PEEK_DEFAULT = true;

/** The five characters HTML gives meaning to, and what each is written as. */
const HTML_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

function fail(message: string): never {
  throw new Error(`pane-pulse panel: ${message}`);
}

/** What a refused argument was, for the refusal's words. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/** A plain object, or undefined for anything else. */
function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * Text with a character in it besides whitespace, trimmed, or undefined: a details field that is
 * missing, empty or of the wrong type reads as absent.
 */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** A finite number, or undefined. */
function finiteOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A finite count of 0 or more, or undefined. */
function countOf(value: unknown): number | undefined {
  const n = finiteOf(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

/** A percentage as the panel writes it: rounded and held to 0-100, or undefined. */
function percentOf(value: unknown): number | undefined {
  const n = finiteOf(value);
  return n === undefined ? undefined : Math.min(100, Math.max(0, Math.round(n)));
}

/** The parts that are present, joined by PART_GAP. */
function joinParts(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined).join(PART_GAP);
}

/** Text with its first letter in capitals: `idle` reads `Idle`. */
function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The bucket a pane is listed under. A muted pane goes to Muted whatever its state; otherwise
 * waiting is Needs you, unread Unseen, thinking Working and idle Idle. A gone pane has no bucket
 * (its row is retired, never drawn), so asking is refused by name, as is a state or a reason for
 * a mute outside the ones a row can carry.
 */
export function bucketOf(row: Pick<PaneRow<unknown>, 'state' | 'muted'>): Bucket {
  if (objectOf(row) === undefined) fail(`bucketOf takes a pane row, not ${kindOf(row)}`);
  const { state, muted } = row;
  if (state === GONE) {
    fail('bucketOf was asked about a gone pane, which has no bucket: its row is retired');
  }
  if (!Object.hasOwn(STATE_BUCKETS, state)) {
    fail(
      `${JSON.stringify(state)} is no state the panel lists ` +
        `(one of ${Object.keys(STATE_BUCKETS).join(' | ')}, or ${GONE}, which is never listed)`,
    );
  }
  if (muted === undefined) return STATE_BUCKETS[state];
  if (!Object.hasOwn(MUTED_STATE_LINES, muted)) {
    fail(
      `${JSON.stringify(muted)} is no reason a pane is muted ` +
        `(one of ${Object.keys(MUTED_STATE_LINES).join(' | ')}, or absent when it is not)`,
    );
  }
  return MUTED_BUCKET;
}

/**
 * The CSS variable a webview reads a theme colour from: `--vscode-` and the id with only its first
 * dot turned into `-` (`panePulse.needsYouForeground` reads
 * `--vscode-panePulse-needsYouForeground`, `terminal.ansiBlue` reads
 * `--vscode-terminal-ansiBlue`). An id VS Code would not register is refused by name.
 */
export function cssVarOf(colorId: string): string {
  if (typeof colorId !== 'string' || !COLOR_ID.test(colorId)) {
    fail(
      'cssVarOf takes a theme colour id such as panePulse.idleForeground, ' +
        `not ${JSON.stringify(colorId)}`,
    );
  }
  return `--vscode-${colorId.replace('.', '-')}`;
}

/**
 * Text made safe to put anywhere in the panel's HTML, between tags or inside a double-quoted
 * attribute: `&`, `<`, `>`, `"` and `'` are written as entities, and nothing else is touched.
 */
export function escapeHtml(text: string): string {
  if (typeof text !== 'string') fail(`escapeHtml takes text, not ${kindOf(text)}`);
  return text.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);
}

/**
 * The thresholds to colour by: the settings' pair when it is valid (two whole percentages from 1
 * to 100, the amber one below the red one), else CONTEXT_THRESHOLDS.
 */
function thresholdsOf(value: unknown): Thresholds {
  const pair = objectOf(value);
  const isPercent = (n: unknown): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 100;
  if (pair !== undefined && isPercent(pair.mid) && isPercent(pair.high) && pair.mid < pair.high) {
    return Object.freeze({ mid: pair.mid, high: pair.high });
  }
  return CONTEXT_THRESHOLDS;
}

/** The colour a context percentage takes: below `mid` low, below `high` mid, else high. */
function levelOf(pct: number | undefined, thresholds: Thresholds): ContextLevel {
  if (pct === undefined) return 'none';
  if (pct < thresholds.mid) return 'low';
  if (pct < thresholds.high) return 'mid';
  return 'high';
}

/** The options, checked: the wiring's values refused by name, the settings' ones defaulted. */
function optionsOf(options: PanelOptions): CheckedOptions {
  if (objectOf(options) === undefined) {
    fail(`buildPanel takes PanelOptions, not ${kindOf(options)}`);
  }
  const { activeId, now, peek, thresholds } = options;
  if (finiteOf(now) === undefined) {
    fail(`buildPanel takes options.now as a finite time in ms, not ${String(now)}`);
  }
  if (activeId !== undefined && typeof activeId !== 'string') {
    fail(`buildPanel takes options.activeId as a pane id or nothing, not ${kindOf(activeId)}`);
  }
  return Object.freeze({
    activeId,
    now,
    peek: typeof peek === 'boolean' ? peek : PEEK_DEFAULT,
    thresholds: thresholdsOf(thresholds),
  });
}

/** Each row checked before anything is drawn from it, so a refusal names the row. */
function checkRows(rows: readonly PaneRow<unknown>[]): void {
  if (!Array.isArray(rows)) fail(`buildPanel takes an array of pane rows, not ${kindOf(rows)}`);
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (objectOf(row) === undefined) fail(`row ${index} is ${kindOf(row)}, not a pane row`);
    if (typeof row.id !== 'string' || row.id === '') {
      fail(`row ${index} has no pane id (${JSON.stringify(row.id)}), so nothing could name it`);
    }
    if (seen.has(row.id)) fail(`two rows share the pane id ${JSON.stringify(row.id)}`);
    seen.add(row.id);
    if (typeof row.name !== 'string') {
      fail(`row ${index} (pane ${row.id}) has a name that is ${kindOf(row.name)}, not text`);
    }
    if (row.state !== GONE) bucketOf(row);
  });
}

/** A pane's details, asked once, or undefined when the lookup has none or answers a non-object. */
function detailsOf(
  details: (id: string) => PaneDetails | undefined,
  id: string,
): PaneDetails | undefined {
  const found = details(id);
  return objectOf(found) === undefined ? undefined : found;
}

/** The peek's state line: the state and when the pane last did anything, or why it is muted. */
function stateLineOf(
  row: PaneRow<unknown>,
  lastActivity: number | undefined,
  now: number,
): string {
  if (row.muted !== undefined) return MUTED_STATE_LINES[row.muted];
  const state = capitalised(STATE_WORDS[row.state]);
  return lastActivity === undefined
    ? state
    : joinParts([state, `last activity ${formatAgo(now - lastActivity)}`]);
}

/** The peek's session line: how long it has run, then its lines changed once they are counted. */
function sessionOf(d: PaneDetails | undefined, now: number): string {
  const start = finiteOf(d?.sessionStart);
  const added = countOf(d?.linesAdded);
  const removed = countOf(d?.linesRemoved);
  return joinParts([
    start === undefined ? undefined : formatDuration(now - start),
    added === undefined || removed === undefined ? undefined : `+${added}/${MINUS}${removed}`,
  ]);
}

/** One row's peek. */
function peekOf(
  name: string,
  row: PaneRow<unknown>,
  d: PaneDetails | undefined,
  now: number,
): PeekModel {
  const model = textOf(d?.modelName) ?? textOf(d?.model);
  const effort = textOf(d?.effort);
  const pct = percentOf(d?.contextPct);
  const tokens = countOf(d?.contextTokens);
  const cache = percentOf(d?.cachePct);
  const prompt = textOf(d?.lastPrompt);
  const lastActivity = finiteOf(d?.lastActivity) ?? finiteOf(row.lastEvent);
  return Object.freeze({
    name,
    accent: joinParts([model, effort]),
    stateLine: stateLineOf(row, lastActivity, now),
    ...(prompt === undefined ? {} : { prompt }),
    model: model ?? '',
    effort: effort ?? '',
    context: joinParts([
      pct === undefined ? undefined : `${pct}%`,
      tokens === undefined ? undefined : formatTokens(tokens),
      cache === undefined ? undefined : `cache ${cache}%`,
    ]),
    session: sessionOf(d, now),
    ...(pct === undefined ? {} : { contextPct: pct }),
  });
}

/** One row as the panel draws it. `row.name` is already stripped of its title glyph. */
function panelRowOf(
  row: PaneRow<unknown>,
  d: PaneDetails | undefined,
  options: CheckedOptions,
): PanelRow {
  const bucket = bucketOf(row);
  const pct = percentOf(d?.contextPct);
  const menu: MenuContext = Object.freeze({
    webviewSection: 'pane',
    paneId: row.id,
    paneBucket: bucket,
    paneMute: row.muted ?? 'none',
    preventDefaultContextMenuItems: true,
  });
  return Object.freeze({
    id: row.id,
    name: row.name,
    bucket,
    icon: BUCKET_ICONS[bucket],
    stateWord: rowDescription(row),
    model: textOf(d?.model) ?? NO_VALUE,
    effort: textOf(d?.effort) ?? NO_VALUE,
    context: pct === undefined ? NO_VALUE : `${pct}%`,
    contextLevel: levelOf(pct, options.thresholds),
    active: row.id === options.activeId,
    menu,
    ...(options.peek ? { peek: peekOf(row.name, row, d, options.now) } : {}),
  });
}

/**
 * The panel's model: every visible row under its bucket, every bucket in BUCKETS order (an empty
 * one with a count of 0), rows inside a bucket in visibleRows() order of their shown names, gone
 * rows left out. `details` is asked once per visible row by its id; `options` says which row is
 * active, what time it is, whether rows carry a peek and where the context colour steps up. A new
 * frozen model; the rows and details handed in are never touched.
 */
export function buildPanel(
  rows: readonly PaneRow<unknown>[],
  details: (id: string) => PaneDetails | undefined,
  options: PanelOptions,
): PanelModel {
  checkRows(rows);
  if (typeof details !== 'function') {
    fail(`buildPanel takes a details lookup as a function, not ${kindOf(details)}`);
  }
  const checked = optionsOf(options);
  // Sorted by the name the row shows, so a title glyph Claude Code adds and drops as a pane works
  // and waits never moves the row; each copy carries the caller's fields, and the caller's row is
  // left as it was.
  const shown = visibleRows(rows.map((row) => ({ ...row, name: stripSpinner(row.name) })));
  const byBucket = new Map<Bucket, PanelRow[]>(BUCKETS.map((bucket) => [bucket, []]));
  for (const row of shown) {
    const panelRow = panelRowOf(row, detailsOf(details, row.id), checked);
    byBucket.get(panelRow.bucket)?.push(panelRow);
  }
  const buckets = BUCKETS.map((bucket) => {
    const bucketRows = Object.freeze([...(byBucket.get(bucket) ?? [])]);
    return Object.freeze({
      bucket,
      title: BUCKET_TITLES[bucket],
      count: bucketRows.length,
      rows: bucketRows,
    });
  });
  return Object.freeze({
    empty: shown.length === 0,
    emptyMessage: EMPTY_MESSAGE,
    buckets: Object.freeze(buckets),
  });
}

/** A status colour's class, `s-<bucket>`; a bucket outside BUCKETS is refused by name. */
function bucketClass(bucket: Bucket): string {
  if (!BUCKETS.includes(bucket)) {
    fail(`${JSON.stringify(bucket)} is no bucket (one of ${BUCKETS.join(' | ')})`);
  }
  return `s-${bucket}`;
}

/** A context colour's class, `c-<level>`; a level outside the four is refused by name. */
function levelClass(level: ContextLevel): string {
  if (!CONTEXT_LEVELS.includes(level)) {
    fail(`${JSON.stringify(level)} is no context level (one of ${CONTEXT_LEVELS.join(' | ')})`);
  }
  return `c-${level}`;
}

/** One attribute, its value escaped and double-quoted. */
function attr(name: string, value: string): string {
  return ` ${name}="${escapeHtml(value)}"`;
}

/**
 * A status icon: the bucket's codicon in the bucket's colour, turning when `spin` is set. Hidden
 * from screen readers, since the row's label already says the state.
 */
function statusIcon(bucket: Bucket, icon: string, spin: boolean): string {
  if (typeof icon !== 'string' || !CODICON_NAME.test(icon)) {
    fail(`${JSON.stringify(icon)} is no codicon name`);
  }
  const classes = ['codicon', `codicon-${icon}`];
  if (spin) classes.push(SPIN_CLASS);
  classes.push('status', bucketClass(bucket));
  return `<span${attr('class', classes.join(' '))}${attr('aria-hidden', 'true')}></span>`;
}

/** A span of text with one class. */
function span(className: string, text: string): string {
  return `<span${attr('class', className)}>${escapeHtml(text)}</span>`;
}

/** A div of text with one class. */
function div(className: string, text: string): string {
  return `<div${attr('class', className)}>${escapeHtml(text)}</div>`;
}

/**
 * What a screen reader says for a row: `Implement 2, waiting for you, Opus, XHigh, 54% context`,
 * each column left out when it is unknown rather than read as a dash.
 */
function rowLabel(row: PanelRow): string {
  const parts = [row.name, row.stateWord];
  if (row.model !== NO_VALUE) parts.push(row.model);
  if (row.effort !== NO_VALUE) parts.push(row.effort);
  if (row.context !== NO_VALUE) parts.push(`${row.context} context`);
  return parts.filter((part) => part !== '').join(', ');
}

/** One row's HTML. Its icon always turns in Working, since the row is a pane at work. */
function renderRow(row: PanelRow): string {
  const classes = row.active ? 'row active' : 'row';
  return (
    `<div${attr('class', classes)}${attr('role', 'treeitem')}${attr('tabindex', '-1')}` +
    `${attr('data-id', row.id)}${attr('data-vscode-context', JSON.stringify(row.menu))}` +
    `${attr('aria-label', rowLabel(row))}>` +
    statusIcon(row.bucket, row.icon, row.bucket === SPIN_BUCKET) +
    span('name', row.name) +
    span('col model', row.model) +
    span('col effort', row.effort) +
    span(`col ctx ${levelClass(row.contextLevel)}`, row.context) +
    '</div>'
  );
}

/** One row's peek card, inside the <template> the webview clones it from. */
function renderPeek(id: string, peek: PeekModel, level: ContextLevel): string {
  const head =
    `<div${attr('class', 'peek-head')}>${span('peek-name', peek.name)}` +
    `${peek.accent === '' ? '' : span('peek-accent', peek.accent)}</div>`;
  const grid = [
    ['Model', peek.model],
    ['Effort', peek.effort],
    ['Context', peek.context],
    ['Session', peek.session],
  ]
    .filter(([, value]) => value !== '')
    .map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join('');
  const pct = percentOf(peek.contextPct);
  const prompt =
    peek.prompt === undefined ? undefined : `${OPEN_QUOTE}${peek.prompt}${CLOSE_QUOTE}`;
  const bar =
    `<div${attr('class', 'peek-bar')}><div${attr('class', `peek-fill ${levelClass(level)}`)}` +
    `${attr('data-pct', String(pct))}></div></div>`;
  const parts = [
    head,
    peek.stateLine === '' ? '' : div('peek-state', peek.stateLine),
    prompt === undefined ? '' : div('peek-prompt', prompt),
    grid === '' ? '' : `<dl${attr('class', 'peek-grid')}>${grid}</dl>`,
    pct === undefined ? '' : bar,
  ];
  return (
    `<template${attr('data-peek-for', id)}><div${attr('class', 'peek-card')}>` +
    `${parts.join('')}</div></template>`
  );
}

/** One row's HTML followed by its peek template, when it carries a peek. */
function renderRowAndPeek(row: PanelRow): string {
  const peek = row.peek === undefined ? '' : renderPeek(row.id, row.peek, row.contextLevel);
  return renderRow(row) + peek;
}

/** One bucket's HTML: its header, its title and count with no icon, then each row and its peek. */
function renderBucket(bucket: PanelBucket): string {
  const head =
    `<header${attr('class', 'bucket-head')}>` +
    `${span('bucket-title', bucket.title)}${span('bucket-count', String(bucket.count))}</header>`;
  return (
    `<section${attr('class', 'bucket')}${attr('data-bucket', bucket.bucket)}>` +
    `${head}${bucket.rows.map(renderRowAndPeek).join('')}</section>`
  );
}

/**
 * The counts line above the buckets: each bucket drawn, in BUCKETS order, as its count and its
 * title in lower case, `1 unseen · 5 idle · 1 muted`. Each dot is hidden from screen readers,
 * which hear the counts and the words alone; the spaces round it stay, so no two items run on.
 */
function renderCounts(buckets: readonly PanelBucket[]): string {
  const items = buckets.map(
    (bucket) =>
      `<span${attr('class', 'counts-item')}>${span('counts-number', String(bucket.count))} ` +
      `${escapeHtml(bucket.title.toLowerCase())}</span>`,
  );
  const dot = `<span${attr('class', 'counts-dot')}${attr('aria-hidden', 'true')}>·</span>`;
  return `<div${attr('class', 'counts')}>${items.join(` ${dot} `)}</div>`;
}

/**
 * The list's HTML, as the webview's `#list` holds it: the counts line, then a `.panel` tree of a
 * section for each bucket with a pane in it, each row with its `data-vscode-context` and, when
 * the peek is on, its peek card in a `<template data-peek-for="<id>">`; or, with no panes at all,
 * only the empty message. Every text and attribute is escaped, and no element carries a `style`
 * attribute (P1).
 */
export function renderPanel(model: PanelModel): string {
  if (objectOf(model) === undefined || !Array.isArray(model.buckets)) {
    fail(`renderPanel takes the model buildPanel made, not ${kindOf(model)}`);
  }
  if (model.empty) return div('empty', model.emptyMessage);
  const filled = model.buckets.filter((bucket) => bucket.rows.length > 0);
  return (
    renderCounts(filled) +
    `<div${attr('class', 'panel')}${attr('role', 'tree')}${attr('aria-label', PANEL_LABEL)}>` +
    `${filled.map(renderBucket).join('')}</div>`
  );
}

/**
 * The activity-bar badge (R13): how many panes need Rob, with a tooltip saying so, or undefined
 * when none do, which removes the badge.
 */
export function badgeOf(
  model: PanelModel,
): Readonly<{ value: number; tooltip: string }> | undefined {
  const bucket =
    objectOf(model) === undefined || !Array.isArray(model.buckets)
      ? undefined
      : model.buckets.find((candidate) => candidate.bucket === BADGE_BUCKET);
  if (bucket === undefined) {
    fail(`badgeOf takes the model buildPanel made, with a ${BADGE_BUCKET} bucket`);
  }
  const count = bucket.count;
  if (count === 0) return undefined;
  const tooltip = count === 1 ? '1 pane needs you' : `${count} panes need you`;
  return Object.freeze({ value: count, tooltip });
}
