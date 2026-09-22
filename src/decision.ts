// The decision table, typed and loaded once.
//
// hook/decision-table.json is the single source of truth for "(event, matcher, agent_id,
// bg) -> pane state + OSC 9;4 sequence". There is deliberately no focus dimension: the hook
// never decides whether the member was looking at a pane, it always sets the mark, and the
// VS Code extension owns every clear. Three readers share it: hook/hook.js (plain
// CommonJS, zero deps, reads it from beside itself), this module (the extension side:
// model.ts, events.ts, view.ts and installer.ts all take their shared types from here,
// and statusbar.ts and the Panes webview (panel.ts, panelView.ts) take theirs via view.ts), and tests/contract.test.mjs,
// which proves the readers cannot drift apart.
//
// The JSON lives OUTSIDE tsconfig's rootDir (src/), so it is never a TypeScript import:
// that would break `tsc --noEmit`, and esbuild's CJS bundle turns `import.meta.url` into
// `undefined` (measured 2026-09-20), so a module-URL-relative read is not portable either.
// It is read at runtime instead, from a short, explicit candidate list -- see
// decisionTablePath() -- which resolves in the source tree, in the dist/ bundle, and in a
// `node --test` child process started from any working directory.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** What a pane can be. A `type`, never an `enum`: `erasableSyntaxOnly` is on. */
export type PaneState = 'idle' | 'thinking' | 'waiting' | 'unread' | 'gone';

/** The explicit no-op marker. Every event has a row; a row that does nothing says so. */
export const NOOP = 'noop';

/** A row's state: a real pane state, or the explicit no-op. */
export type RowState = PaneState | 'noop';

export const PANE_STATES: readonly PaneState[] = Object.freeze([
  'idle',
  'thinking',
  'waiting',
  'unread',
  'gone',
]);

export type SequenceName = 'spin' | 'alert' | 'blocked' | 'clear';

export const SEQUENCE_NAMES: readonly SequenceName[] = Object.freeze([
  'spin',
  'alert',
  'blocked',
  'clear',
]);

/**
 * The four OSC 9;4 progress sequences, byte for byte: ESC ] 9 ; 4 ; <state> ; <progress> ESC \
 * state 3 = indeterminate (VS Code renders $(loading~spin)), 4 = error ($(alert), a warning
 * triangle), 2 = error carrying a value ($(error)), 0 = off. `blocked` is what makes a
 * waiting pane visibly different from an unread one, and that difference is the feature: only
 * an unread mark is ever cleared by looking, so the two marks must never be the same bytes.
 * The two error states carry a progress of 100 to match the spelling the live hooks already
 * write -- VS Code reads the value for state 1 alone, so it changes nothing on screen, but two
 * spellings of one mark is precisely the drift this table exists to prevent.
 * Spelled out here as well as in the JSON on purpose: the loader compares the two and
 * throws on the smallest drift, and tests/contract.test.mjs asserts the char codes.
 */
export const SEQUENCES: Readonly<Record<SequenceName, string>> = Object.freeze({
  spin: '\u001b]9;4;3;0\u001b\\',
  alert: '\u001b]9;4;4;100\u001b\\',
  blocked: '\u001b]9;4;2;100\u001b\\',
  clear: '\u001b]9;4;0;0\u001b\\',
});

/** `in` matches the listed subjects; `not-in` matches every other subject, including none. */
export type MatcherMode = 'in' | 'not-in';

/** `agent_id` is present only inside a subagent call, so `absent` means the main thread. */
export type AgentConstraint = 'any' | 'absent' | 'present';

/** `bg` is `background_tasks.length`, a field the docs put on Stop and SubagentStop only. */
export type BackgroundConstraint = 'any' | '0' | '>0';

export type DecisionRow = {
  readonly event: string;
  readonly matcher?: string;
  readonly matcher_mode?: MatcherMode;
  readonly agent_id: AgentConstraint;
  readonly bg: BackgroundConstraint;
  readonly state: RowState;
  readonly sequence: SequenceName | null;
  readonly registered: boolean;
};

/**
 * How an entry is written: `node` is the exec form that runs hook.js; `shell` is the one-liner
 * PostToolUse takes, because that event fires once per tool call and a node spawn each time
 * costs about a second a turn, measured.
 */
export type RegistrationShape = 'node' | 'shell';

export const REGISTRATION_SHAPES: readonly RegistrationShape[] = Object.freeze(['node', 'shell']);

/**
 * One hook entry the installer writes into Claude Code's settings. The shape is declared in
 * the table rather than chosen at install time: the table says how the entry must be written,
 * the installer writes exactly that, and the contract test holds the two to each other.
 */
export type Registration = {
  readonly event: string;
  readonly matcher?: string;
  readonly shape: RegistrationShape;
};

export type DecisionTable = {
  readonly version: number;
  readonly about: string;
  readonly sequences: Readonly<Record<SequenceName, string>>;
  readonly subject_fields: Readonly<Record<string, string>>;
  readonly normalisation: Normalisation;
  readonly registrations: readonly Registration[];
  readonly rows: readonly DecisionRow[];
};

/**
 * What a reader knows about one event when it consults the table. Every field may be
 * unknown, and what unknown means is NOT decided here: it is declared in the table's own
 * `normalisation` block, which hook.js obeys from the JSON alone.
 */
export type LookupContext = {
  /** `tool_name` for PreToolUse, `notification_type` for Notification; null otherwise. */
  readonly subject?: string | null;
  /** The payload's `agent_id`. Absent is the normal, main-thread case. */
  readonly agentId?: string | null;
  /** `background_tasks.length`; null when the field was absent, NaN when it was unreadable. */
  readonly backgroundTasks?: number | null;
};

/** What `agent_id` reads as once normalised. */
export type AgentReading = 'absent' | 'present';

export type BackgroundNormalisation = {
  readonly payload_field: string;
  readonly derive: 'array_length';
  readonly absent_reads_as: number;
  readonly non_numeric_reads_as: number;
  readonly rule: string;
};

export type AgentNormalisation = {
  readonly payload_field: string;
  readonly absent_reads_as: AgentReading;
  readonly empty_string_reads_as: AgentReading;
  readonly non_string_reads_as: AgentReading;
  readonly rule: string;
};

export type SubjectNormalisation = {
  readonly payload_field_by_event: string;
  readonly absent_reads_as: null;
  readonly non_string_reads_as: null;
  readonly rule: string;
};

/**
 * The coercions a reader applies to an input before comparing it with a row. They are data,
 * not code, on purpose: the rows are not total on their own (a Stop with no
 * `background_tasks` matches no `bg` row until `absent_reads_as` is applied), so a rule that
 * lived only in this file would be a trap for hook.js and for anything else that reads the
 * JSON. This module reads the block rather than hard-coding it, so the two cannot drift.
 */
export type Normalisation = {
  readonly about: string;
  readonly bg: BackgroundNormalisation;
  readonly agent_id: AgentNormalisation;
  readonly subject: SubjectNormalisation;
};

/** One event's input, after the table's own normalisation rules have been applied. */
export type NormalisedInput = {
  readonly backgroundCount: number;
  readonly agent: AgentReading;
  readonly subject: string | null;
};

const TABLE_BASENAME = 'decision-table.json';
const PATH_OVERRIDE_ENV = 'PANE_PULSE_DECISION_TABLE';

function fail(source: string, message: string): never {
  throw new Error(`pane-pulse decision table (${source}): ${message}`);
}

function codesOf(value: string): string {
  return Array.from(value, (c) => c.charCodeAt(0)).join(',');
}

/**
 * Where the JSON is, resolved without `import.meta` so the same code works when Node strips
 * types off this file (tests), when esbuild bundles it into dist/extension.cjs (__dirname is
 * defined there, import.meta is not), and when the extension ships hook/ next to the bundle.
 * PANE_PULSE_DECISION_TABLE overrides the search outright.
 */
export function decisionTablePath(): string {
  const override = process.env[PATH_OVERRIDE_ENV];
  if (override !== undefined && override !== '') {
    if (!existsSync(override)) {
      fail(PATH_OVERRIDE_ENV, `no file at ${override}`);
    }
    return override;
  }

  const anchors: string[] = [];
  // Defined in the CommonJS bundle (dist/extension.cjs) and nowhere else; `typeof` keeps
  // this from throwing under ESM, where the identifier does not exist at all.
  if (typeof __dirname === 'string' && __dirname !== '') {
    anchors.push(__dirname);
  }
  // Inside `node --test`, argv[1] is the test file itself, so this anchors on tests/.
  const entry = process.argv[1];
  if (typeof entry === 'string' && entry !== '') {
    anchors.push(dirname(entry));
  }
  anchors.push(process.cwd());

  const tried: string[] = [];
  for (const anchor of anchors) {
    for (const candidate of [
      join(anchor, 'hook', TABLE_BASENAME),
      join(anchor, '..', 'hook', TABLE_BASENAME),
      join(anchor, TABLE_BASENAME),
    ]) {
      if (tried.includes(candidate)) continue;
      tried.push(candidate);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    `pane-pulse: ${TABLE_BASENAME} not found. Tried:\n  ${tried.join('\n  ')}\n` +
      `Set ${PATH_OVERRIDE_ENV} to its absolute path.`,
  );
}

function asRecord(value: unknown, source: string, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(source, `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, source: string, what: string): string {
  if (typeof value !== 'string' || value === '') {
    fail(source, `${what} must be a non-empty string`);
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  source: string,
  what: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(source, `${what} must be one of ${allowed.join(' | ')}, got ${JSON.stringify(value)}`);
  }
  return value as T;
}

/** The key a row and a registration share: the hook entry that produces this event. */
export function registrationKey(event: string, matcher?: string | null): string {
  return matcher !== undefined && matcher !== null && matcher !== ''
    ? `${event}::${matcher}`
    : event;
}

/**
 * A row's hook entry. A `not-in` row covers the subjects nobody registered, so it keys on
 * the bare event and is never registered; an `in` row keys on its matcher.
 */
export function rowRegistrationKey(row: DecisionRow): string {
  return registrationKey(row.event, row.matcher_mode === 'in' ? row.matcher : undefined);
}

function parseRegistration(value: unknown, source: string, index: number): Registration {
  const raw = asRecord(value, source, `registrations[${index}]`);
  const event = asString(raw['event'], source, `registrations[${index}].event`);
  const shape = oneOf<RegistrationShape>(
    raw['shape'],
    REGISTRATION_SHAPES,
    source,
    `registrations[${index}].shape`,
  );
  const matcher = raw['matcher'];
  if (matcher === undefined) return Object.freeze({ event, shape });
  return Object.freeze({
    event,
    shape,
    matcher: asString(matcher, source, `registrations[${index}].matcher`),
  });
}

function parseRow(value: unknown, source: string, index: number): DecisionRow {
  const raw = asRecord(value, source, `rows[${index}]`);
  const where = `rows[${index}]`;
  const event = asString(raw['event'], source, `${where}.event`);
  const state = oneOf<RowState>(
    raw['state'],
    [...PANE_STATES, NOOP] as readonly RowState[],
    source,
    `${where}.state`,
  );
  const sequenceRaw = raw['sequence'];
  const sequence =
    sequenceRaw === null ? null : oneOf<SequenceName>(sequenceRaw, SEQUENCE_NAMES, source, `${where}.sequence`);
  if (state === NOOP && sequence !== null) {
    fail(source, `${where} is a no-op but carries the ${sequence} sequence`);
  }
  const registered = raw['registered'];
  if (typeof registered !== 'boolean') {
    fail(source, `${where}.registered must be a boolean`);
  }
  const hasMatcher = raw['matcher'] !== undefined;
  const hasMode = raw['matcher_mode'] !== undefined;
  if (hasMatcher !== hasMode) {
    fail(source, `${where} must carry matcher and matcher_mode together, or neither`);
  }
  const row: DecisionRow = {
    event,
    ...(hasMatcher
      ? {
          matcher: asString(raw['matcher'], source, `${where}.matcher`),
          matcher_mode: oneOf<MatcherMode>(
            raw['matcher_mode'],
            ['in', 'not-in'],
            source,
            `${where}.matcher_mode`,
          ),
        }
      : {}),
    agent_id: oneOf<AgentConstraint>(
      raw['agent_id'],
      ['any', 'absent', 'present'],
      source,
      `${where}.agent_id`,
    ),
    bg: oneOf<BackgroundConstraint>(raw['bg'], ['any', '0', '>0'], source, `${where}.bg`),
    state,
    sequence,
    registered,
  };
  if (row.matcher !== undefined && row.matcher.split('|').some((part) => part === '')) {
    fail(source, `${where}.matcher has an empty alternative: ${JSON.stringify(row.matcher)}`);
  }
  return Object.freeze(row);
}

function parseNormalisation(value: unknown, source: string): Normalisation {
  const raw = asRecord(value, source, 'normalisation');
  const about = asString(raw['about'], source, 'normalisation.about');

  const bgRaw = asRecord(raw['bg'], source, 'normalisation.bg');
  const absentBg = bgRaw['absent_reads_as'];
  const invalidBg = bgRaw['non_numeric_reads_as'];
  if (typeof absentBg !== 'number' || !Number.isFinite(absentBg)) {
    fail(source, 'normalisation.bg.absent_reads_as must be a finite number');
  }
  if (typeof invalidBg !== 'number' || !Number.isFinite(invalidBg)) {
    fail(source, 'normalisation.bg.non_numeric_reads_as must be a finite number');
  }
  const bg: BackgroundNormalisation = Object.freeze({
    payload_field: asString(bgRaw['payload_field'], source, 'normalisation.bg.payload_field'),
    derive: oneOf<'array_length'>(
      bgRaw['derive'],
      ['array_length'],
      source,
      'normalisation.bg.derive',
    ),
    absent_reads_as: absentBg,
    non_numeric_reads_as: invalidBg,
    rule: asString(bgRaw['rule'], source, 'normalisation.bg.rule'),
  });

  const agentRaw = asRecord(raw['agent_id'], source, 'normalisation.agent_id');
  const readings: readonly AgentReading[] = ['absent', 'present'];
  const agent_id: AgentNormalisation = Object.freeze({
    payload_field: asString(
      agentRaw['payload_field'],
      source,
      'normalisation.agent_id.payload_field',
    ),
    absent_reads_as: oneOf<AgentReading>(
      agentRaw['absent_reads_as'],
      readings,
      source,
      'normalisation.agent_id.absent_reads_as',
    ),
    empty_string_reads_as: oneOf<AgentReading>(
      agentRaw['empty_string_reads_as'],
      readings,
      source,
      'normalisation.agent_id.empty_string_reads_as',
    ),
    non_string_reads_as: oneOf<AgentReading>(
      agentRaw['non_string_reads_as'],
      readings,
      source,
      'normalisation.agent_id.non_string_reads_as',
    ),
    rule: asString(agentRaw['rule'], source, 'normalisation.agent_id.rule'),
  });
  // contextFromPayload reads a present-but-non-string `agent_id` as the same null it gives an
  // absent one, so this module can only ever resolve both through absent_reads_as, while
  // hook/hook.js reads the payload directly and routes the non-string through
  // non_string_reads_as. That conflation is invisible only while the two knobs agree, so the
  // loader refuses a table where it would start to matter rather than let the readers diverge.
  if (agent_id.non_string_reads_as !== agent_id.absent_reads_as) {
    fail(
      source,
      `normalisation.agent_id.non_string_reads_as is ` +
        `${JSON.stringify(agent_id.non_string_reads_as)} but ` +
        `normalisation.agent_id.absent_reads_as is ` +
        `${JSON.stringify(agent_id.absent_reads_as)}: contextFromPayload conflates a ` +
        `present-but-non-string agent_id with an absent one (both become null), so this ` +
        `module would resolve it through absent_reads_as while hook/hook.js obeys ` +
        `non_string_reads_as, and the two readers would disagree. Honouring the two ` +
        `separately means giving LookupContext.agentId a third state for ` +
        `present-but-unreadable, mirroring how backgroundTasks already keeps absent (null) ` +
        `and unreadable (NaN) apart.`,
    );
  }

  const subjectRaw = asRecord(raw['subject'], source, 'normalisation.subject');
  if (subjectRaw['absent_reads_as'] !== null || subjectRaw['non_string_reads_as'] !== null) {
    fail(source, 'normalisation.subject reads absent and non-string subjects as null, both');
  }
  const subject: SubjectNormalisation = Object.freeze({
    payload_field_by_event: asString(
      subjectRaw['payload_field_by_event'],
      source,
      'normalisation.subject.payload_field_by_event',
    ),
    absent_reads_as: null,
    non_string_reads_as: null,
    rule: asString(subjectRaw['rule'], source, 'normalisation.subject.rule'),
  });

  return Object.freeze({ about, bg, agent_id, subject });
}

/**
 * Turns parsed JSON into a typed table, refusing anything that would make the three readers
 * disagree: an unknown state or sequence name, a matcher without its mode, a sequence on a
 * no-op, a `registered` flag that does not match the registrations list, a matcher on an
 * event with no subject field, a registration declaring a shape no installer can write, byte
 * drift in the four sequences, or a missing or incomplete `normalisation` block -- without
 * that block the rows are not total and a reader that has only the JSON cannot resolve every
 * input.
 */
export function validateDecisionTable(value: unknown, source: string): DecisionTable {
  const raw = asRecord(value, source, 'the table');
  const version = raw['version'];
  if (typeof version !== 'number') fail(source, 'version must be a number');
  const about = asString(raw['about'], source, 'about');

  const sequencesRaw = asRecord(raw['sequences'], source, 'sequences');
  const sequences: Record<SequenceName, string> = { ...SEQUENCES };
  for (const name of SEQUENCE_NAMES) {
    const got = sequencesRaw[name];
    if (got !== SEQUENCES[name]) {
      fail(
        source,
        `sequences.${name} is ${codesOf(String(got))} but this module carries ${codesOf(SEQUENCES[name])}`,
      );
    }
    sequences[name] = SEQUENCES[name];
  }

  const normalisationBlock = parseNormalisation(raw['normalisation'], source);
  if (normalisationBlock.subject.payload_field_by_event !== 'subject_fields') {
    fail(
      source,
      `normalisation.subject.payload_field_by_event names ` +
        `${JSON.stringify(normalisationBlock.subject.payload_field_by_event)}, but the table's ` +
        `per-event subject map is called subject_fields`,
    );
  }

  const subjectFieldsRaw = asRecord(raw['subject_fields'], source, 'subject_fields');
  const subjectFields: Record<string, string> = {};
  for (const [event, field] of Object.entries(subjectFieldsRaw)) {
    subjectFields[event] = asString(field, source, `subject_fields.${event}`);
  }

  const registrationsRaw = raw['registrations'];
  if (!Array.isArray(registrationsRaw) || registrationsRaw.length === 0) {
    fail(source, 'registrations must be a non-empty array');
  }
  const registrationList = registrationsRaw.map((entry, i) => parseRegistration(entry, source, i));
  const registrationKeys = new Set(registrationList.map((r) => registrationKey(r.event, r.matcher)));
  if (registrationKeys.size !== registrationList.length) {
    fail(source, 'registrations contains a duplicate entry');
  }

  const rowsRaw = raw['rows'];
  if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) {
    fail(source, 'rows must be a non-empty array');
  }
  const rows = rowsRaw.map((entry, i) => parseRow(entry, source, i));

  const claimedKeys = new Set<string>();
  rows.forEach((row, i) => {
    const key = rowRegistrationKey(row);
    if (row.registered !== registrationKeys.has(key)) {
      fail(
        source,
        `rows[${i}] says registered=${row.registered} but ${JSON.stringify(key)} is ` +
          `${registrationKeys.has(key) ? '' : 'not '}in registrations`,
      );
    }
    if (row.registered) claimedKeys.add(key);
    if (row.matcher !== undefined && subjectFields[row.event] === undefined) {
      fail(source, `rows[${i}] matches on a subject but subject_fields has no ${row.event}`);
    }
  });
  for (const key of registrationKeys) {
    if (!claimedKeys.has(key)) fail(source, `registration ${JSON.stringify(key)} has no row`);
  }

  return Object.freeze({
    version,
    about,
    sequences: Object.freeze(sequences),
    subject_fields: Object.freeze(subjectFields),
    normalisation: normalisationBlock,
    registrations: Object.freeze(registrationList),
    rows: Object.freeze(rows),
  });
}

/** Reads and validates one table file. Injected path: no globals, so tests can use a fixture. */
export function loadDecisionTable(filePath: string): DecisionTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`pane-pulse: could not read ${filePath}: ${(error as Error).message}`);
  }
  return validateDecisionTable(parsed, filePath);
}

let cached: DecisionTable | undefined;

/** The shipped table, read once per process. */
export function decisionTable(): DecisionTable {
  if (cached === undefined) cached = loadDecisionTable(decisionTablePath());
  return cached;
}

/**
 * Every hook entry the installer writes into Claude Code's settings, each carrying the shape
 * to write it in. How many there are belongs to the table, not to this comment: a number
 * restated here is drift the moment a registration is added.
 */
export function registrations(): readonly Registration[] {
  return decisionTable().registrations;
}

/** Which payload field carries the matcher subject for this event, if any. */
export function subjectFieldFor(event: string, table: DecisionTable = decisionTable()): string | undefined {
  return table.subject_fields[event];
}

/** Every event the table speaks for. */
export function tableEvents(table: DecisionTable = decisionTable()): string[] {
  return [...new Set(table.rows.map((row) => row.event))];
}

/** The bytes this row writes to the pane, or null when it writes nothing. */
export function sequenceFor(row: DecisionRow): string | null {
  return row.sequence === null ? null : SEQUENCES[row.sequence];
}

export function isPaneState(value: unknown): value is PaneState {
  return typeof value === 'string' && (PANE_STATES as readonly string[]).includes(value);
}

export function isNoop(row: DecisionRow): boolean {
  return row.state === NOOP;
}

/**
 * Whether looking at this pane clears its mark. Only `unread` is, and that asymmetry is the
 * whole feature: focus is a guess -- VS Code exposes no true terminal focus, and
 * onDidChangeActiveTerminal dedupes on object identity -- so a wrong guess must only ever be
 * able to drop a mark that means "finished, not yet read". A `waiting` pane is genuinely
 * blocked on Rob, and its mark is how he knows; it goes when the state goes, by answering,
 * and by nothing else. Answered here once so no consumer re-derives it and gets it backwards.
 * A pane can be asked the same question: only the `state` a row and a pane share is read.
 */
export function clearsOnFocus(rowOrPane: Pick<DecisionRow, 'state'>): boolean {
  return rowOrPane.state === 'unread';
}

/** The declared coercions, as data. Every value below comes from the JSON, none from here. */
export function normalisation(table: DecisionTable = decisionTable()): Normalisation {
  return table.normalisation;
}

/**
 * Applies the table's own normalisation block to one input. This is the step that makes the
 * rows total: without it a Stop carrying no `background_tasks` matches no `bg` row at all.
 */
export function normaliseContext(
  event: string,
  ctx: LookupContext,
  table: DecisionTable = decisionTable(),
): NormalisedInput {
  const rules = table.normalisation;

  const bg = ctx.backgroundTasks;
  const backgroundCount =
    bg === undefined || bg === null
      ? rules.bg.absent_reads_as
      : Number.isFinite(bg)
        ? bg
        : rules.bg.non_numeric_reads_as;

  const agentId = ctx.agentId;
  const agent: AgentReading =
    agentId === undefined || agentId === null
      ? rules.agent_id.absent_reads_as
      : typeof agentId !== 'string'
        ? rules.agent_id.non_string_reads_as
        : agentId === ''
          ? rules.agent_id.empty_string_reads_as
          : 'present';

  const subjectRaw = ctx.subject;
  const subject =
    subjectRaw === undefined || subjectRaw === null
      ? rules.subject.absent_reads_as
      : typeof subjectRaw === 'string'
        ? subjectRaw
        : rules.subject.non_string_reads_as;

  // `event` is not coerced; it is here so a reader can log what was normalised for what.
  void event;
  return { backgroundCount, agent, subject };
}

function agentMatches(constraint: AgentConstraint, agent: AgentReading): boolean {
  return constraint === 'any' || constraint === agent;
}

function backgroundMatches(constraint: BackgroundConstraint, count: number): boolean {
  if (constraint === 'any') return true;
  return constraint === '>0' ? count > 0 : count <= 0;
}

/** Exact match against one alternative of the matcher, which is the doc's own matcher path. */
function subjectMatches(row: DecisionRow, subject: string | null): boolean {
  if (row.matcher === undefined) return true;
  const hit = subject !== null && row.matcher.split('|').includes(subject);
  return row.matcher_mode === 'not-in' ? !hit : hit;
}

export function rowMatches(
  row: DecisionRow,
  event: string,
  ctx: LookupContext,
  table: DecisionTable = decisionTable(),
): boolean {
  if (row.event !== event) return false;
  const input = normaliseContext(event, ctx, table);
  return (
    agentMatches(row.agent_id, input.agent) &&
    backgroundMatches(row.bg, input.backgroundCount) &&
    subjectMatches(row, input.subject)
  );
}

/** Every row this input matches. The contract test proves the answer is always 0 or 1 rows. */
export function matchAll(
  event: string,
  ctx: LookupContext,
  table: DecisionTable = decisionTable(),
): DecisionRow[] {
  const input = normaliseContext(event, ctx, table);
  return table.rows.filter(
    (row) =>
      row.event === event &&
      agentMatches(row.agent_id, input.agent) &&
      backgroundMatches(row.bg, input.backgroundCount) &&
      subjectMatches(row, input.subject),
  );
}

/**
 * The row for this event, or undefined when the event is outside the table entirely (not a
 * fallthrough: every event the table names has explicit rows, no-ops included). Two matching
 * rows is a table bug, so it throws rather than silently picking one.
 */
export function lookup(
  event: string,
  ctx: LookupContext,
  table: DecisionTable = decisionTable(),
): DecisionRow | undefined {
  const matches = matchAll(event, ctx, table);
  if (matches.length > 1) {
    throw new Error(
      `pane-pulse: ${matches.length} decision rows match ${event} ` +
        `${JSON.stringify(ctx)}: ${JSON.stringify(matches)}`,
    );
  }
  return matches[0];
}

/**
 * Builds a LookupContext from a raw hook payload. The field names come from the table's
 * normalisation block, not from this file: `agent_id` (present only inside a subagent call),
 * `background_tasks` (Stop and SubagentStop only), and the per-event subject field named by
 * `subject_fields` -- `tool_name` or `notification_type`.
 */
export function contextFromPayload(
  event: string,
  payload: Readonly<Record<string, unknown>>,
  table: DecisionTable = decisionTable(),
): LookupContext {
  const rules = table.normalisation;
  const field = subjectFieldFor(event, table);
  const subject = field === undefined ? undefined : payload[field];
  const agentId = payload[rules.agent_id.payload_field];
  const backgroundTasks = payload[rules.bg.payload_field];
  return {
    subject: typeof subject === 'string' ? subject : null,
    // Absent and present-but-not-a-string both become null here, so normaliseContext resolves
    // both through absent_reads_as. parseNormalisation refuses any table where that differs
    // from non_string_reads_as, which is what keeps this line and hook.js in agreement.
    agentId: typeof agentId === 'string' ? agentId : null,
    // Absent stays absent (null); present-but-unreadable becomes NaN, so the two land on the
    // block's absent_reads_as and non_numeric_reads_as separately instead of being conflated.
    backgroundTasks: Array.isArray(backgroundTasks)
      ? backgroundTasks.length
      : backgroundTasks === undefined || backgroundTasks === null
        ? null
        : Number.NaN,
  };
}
