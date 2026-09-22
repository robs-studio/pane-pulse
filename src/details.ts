// The details layer: what a pane's transcript says about it, and the words and numbers a row and
// its peek show for that.
//
// Claude Code writes every session to a transcript, one JSON record per line, and the panel reads
// a pane's model, effort, context, last prompt, last reply and lines changed from there rather
// than from anything the hook sends (R2: the hook does not change). This file is the pure half of
// that read. Handed lines, it answers facts; handed facts, it answers words and numbers. Finding
// the transcript and reading its head and tail off the disk is claudeFiles.ts's job, and keeping
// each pane's facts current is detailsStore.ts's, so every rule below can be held to the plan by
// node --test with lines built in the test.
//
// Eight rules this file is built around:
//
//   * A LINE THAT DOES NOT PARSE IS SKIPPED, NEVER THROWN. Claude Code appends while we read, so a
//     transcript's last line can be half written; a tail read can begin inside a line; and a later
//     Claude Code can write records this file has never seen. So a line that is not JSON, or not a
//     JSON object, is passed over, and a field of the wrong type reads as absent. Only a caller's
//     own mistake (no array of lines at all, a model id that is not text) is refused, by name.
//   * THE LATEST WORD WINS. The model, effort, usage, last prompt, last reply and marketing name
//     are each the newest the lines hold, read from the end, and a record missing one of them
//     leaves the one before it standing rather than blanking it.
//   * ONLY THE PANE'S OWN THREAD SPEAKS FOR IT. A subagent's records (`isSidechain: true`, in
//     their own files today and inline in older versions) say nothing about the pane's own model
//     or context, so they are passed over for every latest value. A record Claude Code writes in
//     the model's place (`message.model` of `<synthetic>`, or `isApiErrorMessage`: an API error,
//     say) carries zero usage and no effort and is no reply, so it is passed over too, and an
//     error at the end of a turn cannot drop a pane's context to 0%. Lines changed are the
//     exception on purpose: a subagent's edits are this pane's edits, so linesChanged counts
//     every record it is handed, subagent files included.
//   * ONE MESSAGE, MANY RECORDS. Claude Code writes one record per content block, and the blocks
//     of one message share its `message.id` and its usage. So the last reply is every text block
//     of the newest message that has any text, gathered by `message.id` in file order and joined
//     with a blank line, and a later message that only calls a tool does not blank it.
//   * TIMESTAMPS ARE NOT IN FILE ORDER. On Claude Code 2.1.278 about one timestamped record in
//     seven is earlier than a line above it (attachments most of all), and many metadata records
//     carry no timestamp at all. So the first and last timestamps are the earliest and latest
//     among the lines given, never the first and last lines'.
//   * THE CONTEXT WINDOW IS CLAUDE CODE'S DOCUMENTED RULE (R3), AND AN ESTIMATE. 1M for Fable,
//     Sonnet 5 and later, Opus 4.7 and later, and any id tagged `[1m]`; 200K for the rest; and
//     context above 200K tokens proves 1M whatever the id says. A provider whose window differs
//     makes the percentage an estimate, which the README says.
//   * NO NAME IS EVER EMPTIED. stripSpinner removes the glyph Claude Code puts before a terminal's
//     title, but a name that is nothing else keeps its glyph, since a row with no name at all
//     could not be told from any other.
//   * A LAUNCH FLAG IS READ AS THE CLAUDE READ IT, OR NOT AT ALL (F8). Until a pane's transcript
//     names a model or an effort (a session that has sent nothing yet has no assistant record),
//     the claude's own command line is the only word on them. launchChoices reads `--model` and
//     `--effort` the way Claude Code's option parser does: each takes the token after it, or the
//     text after its `=`, as its value; the last one given is the one the claude runs with; and
//     nothing after a bare `--` is an option. A value that is not a model alias (`opus`, `fable`,
//     `sonnet`, `haiku`, perhaps tagged `[1m]`), a Claude model id or one of EFFORT_WORDS' levels
//     answers nothing rather than a guess, because `ps` prints a command line without its quotes,
//     so a prompt that mentions `--model` must never become a model.
//
// No import of any kind, so nothing here can reach VS Code or the disk, and the panel could run
// this in a browser bundle. Every structure returned is frozen, and the caller's lines and facts
// are never touched. Refusals throw by name (`pane-pulse details: ...`); nothing a transcript
// holds is ever a refusal.

/**
 * A message's input usage: every token it sent the model, which is what fills the context window.
 * `input` is Claude Code's `input_tokens`, `cacheRead` its `cache_read_input_tokens`, and
 * `cacheCreation` its `cache_creation_input_tokens`.
 */
export type Usage = Readonly<{ input: number; cacheRead: number; cacheCreation: number }>;

/**
 * What a run of transcript lines says about its pane. Every field is absent when the lines do not
 * hold it, so a transcript with no reply yet answers no reply, never an empty one.
 */
export type TranscriptFacts = Readonly<{
  /** The newest main-thread assistant message's `message.model` (`claude-opus-5`). */
  modelId?: string;
  /** The newest model attachment's `identity.marketingName` (`Opus 5`), when there is one. */
  marketingName?: string;
  /** The newest main-thread assistant record's `effort`: Claude Code's level, such as `xhigh`. */
  effort?: string;
  /** The newest main-thread assistant message's usage. */
  usage?: Usage;
  /** The newest `last-prompt` record's `lastPrompt` (Claude Code truncates it near 200 characters). */
  lastPrompt?: string;
  /** Every text block of the newest main-thread message that has any text, joined by a blank line. */
  lastReply?: string;
  /** The earliest `timestamp` among the lines given, in ms. */
  firstTimestamp?: number;
  /** The latest `timestamp` among the lines given, in ms. */
  lastTimestamp?: number;
}>;

/** Lines added and removed by a session's edits and new files. */
export type LineCount = Readonly<{ added: number; removed: number }>;

/**
 * What a claude was launched with, read from its command line: its `--model` and `--effort`
 * values as written (`fable`, `xhigh`), each absent when the command line gives none this file
 * trusts.
 */
export type LaunchChoices = Readonly<{ model?: string; effort?: string }>;

/** A launch model in the panel's words: the model column's family and the peek's name. */
export type LaunchModel = Readonly<{ family: string; name: string }>;

/**
 * Claude Code's effort levels in the mockup's words (R5). `max` reads `Ultra` (P3), the mockup's
 * word for Claude Code's highest level; the README says so.
 */
export const EFFORT_WORDS: Readonly<Record<string, string>> = Object.freeze({
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Ultra',
});

/** The window every model has unless R3 gives it the large one. */
const STANDARD_WINDOW = 200_000;

/** The large window R3 gives Fable, Sonnet 5 and later, and Opus 4.7 and later. */
const LARGE_WINDOW = 1_000_000;

/** How Claude Code tags a model id run with the large window. */
const LARGE_WINDOW_TAG = '[1m]';

/** The model Claude Code names on a record it writes in the model's place, such as an API error. */
const SYNTHETIC_MODEL = '<synthetic>';

/** What some marketing names carry after the name itself, which the peek does not repeat. */
const LARGE_WINDOW_SUFFIX = /\s*\(1M context\)\s*$/i;

/**
 * A leading run of the glyphs Claude Code puts before a terminal's title (the spinner's four
 * quarters while it works, the asterisk while it waits), each perhaps followed by the emoji
 * variation selector, and the whitespace after the run.
 */
const SPINNER_PREFIX = /^(?:[◐◑◒◓✳]\uFE0F?)+\s*/u;

/**
 * A model id's two shapes, today's (`claude-opus-4-7`, `claude-haiku-4-5-20251001`) and the older
 * one (`claude-3-5-sonnet-20241022`), each allowing a provider's prefix (`us.anthropic.`), a
 * release date after `-` or `@`, a provider's version suffix (`-v1:0`) and the `[1m]` tag. A minor
 * version is one or two digits, so an eight-digit date can never pass for one.
 */
const MODEL_PREFIX = String.raw`^(?:[a-z0-9-]+\.)*claude-`;
const MODEL_SUFFIX = String.raw`(?:[-@]\d{8})?(?:-v\d+(?::\d+)?)?(?:\[1m\])?$`;
const CURRENT_MODEL_SHAPE = new RegExp(
  String.raw`${MODEL_PREFIX}([a-z]+)-(\d+)(?:-(\d{1,2}))?${MODEL_SUFFIX}`,
  'i',
);
const LEGACY_MODEL_SHAPE = new RegExp(
  String.raw`${MODEL_PREFIX}(\d+)(?:-(\d{1,2}))?-([a-z]+)${MODEL_SUFFIX}`,
  'i',
);

/**
 * A model alias Claude Code's `--model` takes, in any case, perhaps tagged `[1m]`. It names a
 * family and no version, so the version is not known until the transcript says it.
 */
const MODEL_ALIAS = /^(opus|fable|sonnet|haiku)(?:\[1m\])?$/i;

/** The two options launchChoices reads, spelt as Claude Code spells them. */
const MODEL_OPTION = '--model';
const EFFORT_OPTION = '--effort';

/** Where a command line's options end: every token after it is the claude's prompt. */
const END_OF_OPTIONS = '--';

/** Quotes at either end of a token or a value, which launchChoices tolerates and drops. */
const EDGE_QUOTES = /^["']+|["']+$/g;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** One transcript record, as parsed. Nothing in it is trusted until a reader checks its type. */
type JsonObject = Readonly<Record<string, unknown>>;

/** A model id taken apart: its family in lower case, and its version. */
type ModelParts = Readonly<{ family: string; major: number; minor?: number }>;

/** TranscriptFacts with every key present, so a builder cannot forget one; undefined is dropped. */
type AllFacts = { readonly [K in keyof Required<TranscriptFacts>]: TranscriptFacts[K] | undefined };

function fail(message: string): never {
  throw new Error(`pane-pulse details: ${message}`);
}

/** What a refused argument was, for the refusal's words. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

function requireLines(fn: string, lines: unknown): asserts lines is readonly unknown[] {
  if (!Array.isArray(lines)) fail(`${fn} takes an array of transcript lines, not ${kindOf(lines)}`);
}

function requireText(fn: string, what: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') fail(`${fn} takes ${what} as text, not ${kindOf(value)}`);
}

/** A count the caller computed: refused by name unless it is a finite number, 0 or more. */
function requireCount(fn: string, what: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${fn} takes ${what} as a finite number of 0 or more, not ${String(value)}`);
  }
}

/** A span of time the caller computed: refused by name unless it is a finite number. */
function requireSpan(fn: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${fn} takes a span in ms as a finite number, not ${String(value)}`);
  }
}

function requireUsage(fn: string, usage: Usage): void {
  if (typeof usage !== 'object' || usage === null) fail(`${fn} takes a Usage, not ${kindOf(usage)}`);
  requireCount(fn, 'usage.input', usage.input);
  requireCount(fn, 'usage.cacheRead', usage.cacheRead);
  requireCount(fn, 'usage.cacheCreation', usage.cacheCreation);
}

/** A plain JSON object, or undefined for anything else (null, an array, a string, a number). */
function objectOf(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/** One line as a record, or undefined when it is not text, not JSON, or not a JSON object. */
function recordOf(line: unknown): JsonObject | undefined {
  if (typeof line !== 'string') return undefined;
  try {
    return objectOf(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** Text with something in it besides whitespace, or undefined. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A token count as a transcript writes it: a finite number, 0 or more, else undefined. */
function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A cache count, which an older transcript leaves out when nothing was cached: absent reads 0. */
function cacheCountOf(value: unknown): number | undefined {
  return value === undefined || value === null ? 0 : countOf(value);
}

/** A record's `timestamp` in ms, when it has one Date can read. */
function timestampOf(record: JsonObject): number | undefined {
  if (typeof record.timestamp !== 'string') return undefined;
  const ms = Date.parse(record.timestamp);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The message of an assistant record the model wrote, or undefined for anything else: another
 * type, a record with no message, or one Claude Code wrote in the model's place. Which thread a
 * record is on is factsFromLines's filter, applied once before any of these readers is asked.
 */
function modelMessageOf(record: JsonObject): JsonObject | undefined {
  if (record.type !== 'assistant' || record.isApiErrorMessage === true) return undefined;
  const message = objectOf(record.message);
  if (message === undefined || message.model === SYNTHETIC_MODEL) return undefined;
  return message;
}

/** A message's usage, or undefined when it is missing or any count in it is malformed. */
function usageOf(value: unknown): Usage | undefined {
  const usage = objectOf(value);
  if (usage === undefined) return undefined;
  const input = countOf(usage.input_tokens);
  const cacheRead = cacheCountOf(usage.cache_read_input_tokens);
  const cacheCreation = cacheCountOf(usage.cache_creation_input_tokens);
  if (input === undefined || cacheRead === undefined || cacheCreation === undefined) {
    return undefined;
  }
  return Object.freeze({ input, cacheRead, cacheCreation });
}

/** A message's text blocks that say something, each trimmed, in the order the message has them. */
function textsOf(message: JsonObject): string[] {
  if (!Array.isArray(message.content)) return [];
  const texts: string[] = [];
  for (const item of message.content) {
    const block = objectOf(item);
    if (block?.type !== 'text') continue;
    const text = textOf(block.text);
    if (text !== undefined) texts.push(text.trim());
  }
  return texts;
}

/** A model attachment's marketing name. */
function marketingNameOf(record: JsonObject): string | undefined {
  if (record.type !== 'attachment') return undefined;
  const attachment = objectOf(record.attachment);
  if (attachment?.type !== 'model') return undefined;
  return textOf(objectOf(attachment.identity)?.marketingName);
}

/** The newest value `pick` finds, reading from the last record back. */
function latest<V>(
  records: readonly JsonObject[],
  pick: (record: JsonObject) => V | undefined,
): V | undefined {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const value = pick(records[i]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Every text block of the newest main-thread message that has any, gathered from each record
 * sharing its `message.id`, in file order, joined by a blank line. A message with no id is only
 * the record found.
 */
function lastReplyOf(records: readonly JsonObject[]): string | undefined {
  let found = -1;
  for (let i = records.length - 1; i >= 0 && found < 0; i -= 1) {
    const message = modelMessageOf(records[i]);
    if (message !== undefined && textsOf(message).length > 0) found = i;
  }
  if (found < 0) return undefined;
  const id = modelMessageOf(records[found])?.id;
  const texts: string[] = [];
  records.forEach((record, i) => {
    const message = modelMessageOf(record);
    if (message === undefined) return;
    if (typeof id === 'string' ? message.id === id : i === found) texts.push(...textsOf(message));
  });
  return texts.join('\n\n');
}

/** A frozen TranscriptFacts holding only the fields that are defined. */
function frozenFacts(fields: AllFacts): TranscriptFacts {
  const facts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) facts[key] = value;
  }
  return Object.freeze(facts) as TranscriptFacts;
}

/**
 * What the lines say about their pane. Each latest value is the newest the lines hold on the
 * pane's own thread; the timestamps are the earliest and latest among every line given. A line
 * that is not JSON, or not a JSON object, is skipped, so a half-written last line and a tail read
 * that began inside a line are both harmless.
 */
export function factsFromLines(lines: readonly string[]): TranscriptFacts {
  requireLines('factsFromLines', lines);
  const records: JsonObject[] = [];
  let firstTimestamp: number | undefined;
  let lastTimestamp: number | undefined;
  for (const line of lines) {
    const record = recordOf(line);
    if (record === undefined) continue;
    records.push(record);
    const ms = timestampOf(record);
    if (ms === undefined) continue;
    firstTimestamp = firstTimestamp === undefined ? ms : Math.min(firstTimestamp, ms);
    lastTimestamp = lastTimestamp === undefined ? ms : Math.max(lastTimestamp, ms);
  }
  const main = records.filter((record) => record.isSidechain !== true);
  return frozenFacts({
    modelId: latest(main, (record) => textOf(modelMessageOf(record)?.model)),
    marketingName: latest(main, marketingNameOf),
    effort: latest(main, (record) =>
      modelMessageOf(record) === undefined ? undefined : textOf(record.effort),
    ),
    usage: latest(main, (record) => {
      const message = modelMessageOf(record);
      return message === undefined ? undefined : usageOf(message.usage);
    }),
    lastPrompt: latest(main, (record) =>
      record.type === 'last-prompt' ? textOf(record.lastPrompt) : undefined,
    ),
    lastReply: lastReplyOf(main),
    firstTimestamp,
    lastTimestamp,
  });
}

/**
 * A transcript's head and tail read as one: the tail's value wins for every latest value, since
 * the tail is the newer end, and the first timestamp is the head's whenever it has one. Either may
 * be empty. A new frozen object; neither argument is touched.
 */
export function mergeFacts(head: TranscriptFacts, tail: TranscriptFacts): TranscriptFacts {
  return frozenFacts({
    modelId: tail.modelId ?? head.modelId,
    marketingName: tail.marketingName ?? head.marketingName,
    effort: tail.effort ?? head.effort,
    usage: tail.usage ?? head.usage,
    lastPrompt: tail.lastPrompt ?? head.lastPrompt,
    lastReply: tail.lastReply ?? head.lastReply,
    firstTimestamp: head.firstTimestamp ?? tail.firstTimestamp,
    lastTimestamp: tail.lastTimestamp ?? head.lastTimestamp,
  });
}

/**
 * Whether the facts hold a usage, which is what the tail read grows for: a tail too short to
 * reach the newest assistant message (one long tool result can fill it) says nothing about the
 * pane's context, so the store doubles the read until this is true or its cap is hit.
 */
export function hasLatestUsage(facts: TranscriptFacts): boolean {
  return facts.usage !== undefined;
}

/** How many lines a text has: a final line break ends the last line rather than starting one. */
function lineCountOf(text: string): number {
  if (text === '') return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

/** The `+` and `-` lines of a structuredPatch's hunks; context lines and anything else pass. */
function patchCountOf(value: unknown): { added: number; removed: number } {
  const count = { added: 0, removed: 0 };
  if (!Array.isArray(value)) return count;
  for (const item of value) {
    const hunk = objectOf(item);
    if (hunk === undefined || !Array.isArray(hunk.lines)) continue;
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) count.added += 1;
      else if (line.startsWith('-')) count.removed += 1;
    }
  }
  return count;
}

/**
 * Lines added and removed by the edits the lines record: each tool result's structuredPatch,
 * counting its `+` lines as added and its `-` lines as removed, and each new file a Write created
 * (`toolUseResult.type` of `create`), counting its content's lines as added. A create's own patch
 * is empty on Claude Code 2.1.278; were one ever to carry the file's lines, they are counted once,
 * from the patch. Every record is counted, a subagent's included, and a line that does not parse
 * is skipped.
 */
export function linesChanged(lines: readonly string[]): LineCount {
  requireLines('linesChanged', lines);
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    // Only a tool result's record can hold an edit, and JSON writes its key verbatim, so a line
    // without it (a long reply, say) is passed over without being parsed.
    if (typeof line !== 'string' || !line.includes('"toolUseResult"')) continue;
    const result = objectOf(recordOf(line)?.toolUseResult);
    if (result === undefined) continue;
    const patch = patchCountOf(result.structuredPatch);
    added += patch.added;
    removed += patch.removed;
    const counted = patch.added + patch.removed > 0;
    if (result.type === 'create' && !counted && typeof result.content === 'string') {
      added += lineCountOf(result.content);
    }
  }
  return Object.freeze({ added, removed });
}

/** A model id taken apart, or undefined when it has neither shape a Claude id has. */
function modelPartsOf(modelId: string): ModelParts | undefined {
  const current = CURRENT_MODEL_SHAPE.exec(modelId);
  if (current !== null) return partsOf(current[1], current[2], current[3]);
  const legacy = LEGACY_MODEL_SHAPE.exec(modelId);
  if (legacy !== null) return partsOf(legacy[3], legacy[1], legacy[2]);
  return undefined;
}

function partsOf(family: string, major: string, minor: string | undefined): ModelParts {
  const parts = { family: family.toLowerCase(), major: Number(major) };
  return Object.freeze(minor === undefined ? parts : { ...parts, minor: Number(minor) });
}

/** A family as the model column writes it: `opus` reads `Opus`. */
function familyWord(parts: ModelParts): string {
  return parts.family.charAt(0).toUpperCase() + parts.family.slice(1);
}

/** A version as a name writes it: `5`, or `4.7`. */
function versionWord(parts: ModelParts): string {
  return parts.minor === undefined ? String(parts.major) : `${parts.major}.${parts.minor}`;
}

/**
 * The model column's word: the family (`claude-opus-5` reads `Opus`, `claude-fable-5-1` reads
 * `Fable`, `claude-haiku-4-5-20251001` reads `Haiku`), or the id itself when it has no shape a
 * Claude id has (R6).
 */
export function modelFamily(modelId: string): string {
  requireText('modelFamily', 'a model id', modelId);
  const parts = modelPartsOf(modelId);
  return parts === undefined ? modelId : familyWord(parts);
}

/**
 * The peek's model name. The marketing name wins, a trailing ` (1M context)` removed, when it
 * names the id's own family and version, or when the id has no shape to check it against; one
 * naming another model is passed over, since it came from an older part of the transcript than a
 * later `/model` switch. Otherwise the name is built from the id (`Opus 5`, `Fable 5.1`,
 * `Haiku 4.5`), or is the id itself when it has no shape a Claude id has.
 */
export function modelName(modelId: string, marketingName?: string): string {
  requireText('modelName', 'a model id', modelId);
  if (marketingName !== undefined) requireText('modelName', 'a marketing name', marketingName);
  const parts = modelPartsOf(modelId);
  const named = marketingName?.replace(LARGE_WINDOW_SUFFIX, '').trim();
  if (named !== undefined && named !== '' && (parts === undefined || namesModel(named, parts))) {
    return named;
  }
  return parts === undefined ? modelId : `${familyWord(parts)} ${versionWord(parts)}`;
}

/** Whether a marketing name says the id's family and version as words of its own. */
function namesModel(name: string, parts: ModelParts): boolean {
  const words = name.toLowerCase().split(/[\s()]+/);
  return words.includes(parts.family) && words.includes(versionWord(parts));
}

/**
 * The effort column's word for one of Claude Code's levels, from EFFORT_WORDS (in any case, so
 * `XHIGH` reads `XHigh`); a level it does not know is shown with its first letter capitalised.
 */
export function effortWord(level: string): string {
  requireText('effortWord', 'an effort level', level);
  const trimmed = level.trim();
  const key = trimmed.toLowerCase();
  if (Object.hasOwn(EFFORT_WORDS, key)) return EFFORT_WORDS[key];
  return capitalised(trimmed);
}

/** A word with its first letter capitalised and the rest as written. */
function capitalised(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A token or a value with the quotes at either end dropped. */
function unquoted(text: string): string {
  return text.replace(EDGE_QUOTES, '');
}

/** Whether a `--model` value is one this file trusts: an alias, or an id with a Claude shape. */
function isLaunchModel(value: string): boolean {
  return MODEL_ALIAS.test(value) || modelPartsOf(value) !== undefined;
}

/** Whether an `--effort` value is one of Claude Code's levels, in any case. */
function isLaunchEffort(value: string): boolean {
  return Object.hasOwn(EFFORT_WORDS, value.toLowerCase());
}

/**
 * The `--model` and `--effort` a claude was launched with, from its command line as `ps` prints
 * it: tokens split on whitespace, quotes at either end of a token or a value dropped. Each option
 * takes its value from after its `=` (`--model=fable`) or from the next token (`--model fable`),
 * as Claude Code's own parser does, even a token that starts with a dash; the last one given is
 * the one the claude runs with, so it wins; and a bare `--` ends the options. A value that is not
 * a model alias (`opus`, `fable`, `sonnet`, `haiku`, perhaps tagged `[1m]`) or a Claude model id,
 * or not one of EFFORT_WORDS' levels, answers none for that option rather than a guess, the last
 * one given included. Values come back as written, frozen; modelFromLaunch and effortWord turn
 * them into words.
 */
export function launchChoices(command: string): LaunchChoices {
  requireText('launchChoices', 'a command line', command);
  const tokens = command
    .split(/\s+/)
    .filter((token) => token !== '')
    .map(unquoted);
  let model: string | undefined;
  let effort: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === END_OF_OPTIONS) break;
    const equals = token.indexOf('=');
    const option = equals < 0 ? token : token.slice(0, equals);
    if (option !== MODEL_OPTION && option !== EFFORT_OPTION) continue;
    let value: string | undefined;
    if (equals < 0) {
      index += 1;
      value = tokens[index];
    } else {
      value = unquoted(token.slice(equals + 1));
    }
    if (option === MODEL_OPTION) {
      model = value !== undefined && isLaunchModel(value) ? value : undefined;
    } else {
      effort = value !== undefined && isLaunchEffort(value) ? value : undefined;
    }
  }
  const choices: { model?: string; effort?: string } = {};
  if (model !== undefined) choices.model = model;
  if (effort !== undefined) choices.effort = effort;
  return Object.freeze(choices);
}

/**
 * A launch model in the panel's words. An alias (`opus`, `fable`, `sonnet`, `haiku`, in any case,
 * perhaps tagged `[1m]`) names a family and no version, so it reads as its family word for the
 * column and the peek alike (`fable` reads `Fable` and `Fable`); a full id reads as modelFamily
 * and modelName read it (`claude-opus-5` reads `Opus` and `Opus 5`). Frozen.
 */
export function modelFromLaunch(value: string): LaunchModel {
  requireText('modelFromLaunch', 'a launch model', value);
  const trimmed = value.trim();
  const alias = MODEL_ALIAS.exec(trimmed);
  if (alias !== null) {
    const word = capitalised(alias[1].toLowerCase());
    return Object.freeze({ family: word, name: word });
  }
  return Object.freeze({ family: modelFamily(trimmed), name: modelName(trimmed) });
}

/**
 * The context window a pane's model runs with, by Claude Code's documented rule (R3): 1M when the
 * context already holds more than 200K tokens, when the id is tagged `[1m]`, or for Fable, Sonnet
 * 5 and later, and Opus 4.7 and later; 200K for every other model, an id with no Claude shape, and
 * no id at all. An estimate where a provider differs.
 */
export function contextWindowOf(modelId: string | undefined, tokens: number): number {
  requireCount('contextWindowOf', 'the context tokens', tokens);
  if (tokens > STANDARD_WINDOW) return LARGE_WINDOW;
  if (modelId === undefined) return STANDARD_WINDOW;
  requireText('contextWindowOf', 'a model id', modelId);
  if (modelId.toLowerCase().includes(LARGE_WINDOW_TAG)) return LARGE_WINDOW;
  const parts = modelPartsOf(modelId);
  return parts !== undefined && runsLargeWindow(parts) ? LARGE_WINDOW : STANDARD_WINDOW;
}

function runsLargeWindow(parts: ModelParts): boolean {
  const minor = parts.minor ?? 0;
  switch (parts.family) {
    case 'fable':
      return true;
    case 'sonnet':
      return parts.major >= 5;
    case 'opus':
      return parts.major > 4 || (parts.major === 4 && minor >= 7);
    default:
      return false;
  }
}

/** How many tokens fill the context: every input token the message sent, cached or not. */
export function contextTokens(usage: Usage): number {
  requireUsage('contextTokens', usage);
  return totalOf(usage);
}

function totalOf(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheCreation;
}

/** How full the window is, as a whole percentage: rounded, and never below 0 or above 100. */
export function contextPercent(tokens: number, window: number): number {
  requireCount('contextPercent', 'the context tokens', tokens);
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) {
    fail(`contextPercent takes a window of more than 0 tokens, not ${String(window)}`);
  }
  return percentOf(tokens, window);
}

/** How much of the context was read from the cache, as a whole percentage; undefined with none. */
export function cachePercent(usage: Usage): number | undefined {
  requireUsage('cachePercent', usage);
  const total = totalOf(usage);
  return total === 0 ? undefined : percentOf(usage.cacheRead, total);
}

/**
 * A part of a whole as a whole percentage, rounded and clamped to 0-100. Multiplied before it is
 * divided, so a part that is exactly half a percent (1,000 of 200,000) rounds up as it should.
 */
function percentOf(part: number, whole: number): number {
  return Math.min(100, Math.max(0, Math.round((part * 100) / whole)));
}

/**
 * A token count as the peek writes it: whole below a thousand (`850`), whole thousands below a
 * million (`140k`), and millions to one decimal (`1.3M`). A count that rounds up to the next unit
 * is written in it, so 999,600 reads `1.0M`, never `1000k`.
 */
export function formatTokens(n: number): string {
  requireCount('formatTokens', 'a token count', n);
  if (Math.round(n) < 1_000) return String(Math.round(n));
  if (Math.round(n / 1_000) < 1_000) return `${Math.round(n / 1_000)}k`;
  return `${(Math.round(n / 100_000) / 10).toFixed(1)}M`;
}

/**
 * How long a session has run, in the status line's shape: `<1m` under a minute, then whole
 * minutes (`33m`), then hours and minutes (`1h 5m`). A span a moment below 0 (the transcript's
 * clock and the caller's can disagree) reads `<1m`.
 */
export function formatDuration(ms: number): string {
  requireSpan('formatDuration', ms);
  const minutes = Math.floor(Math.max(0, ms) / MINUTE_MS);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * How long ago something happened: `just now` under a minute, then whole minutes (`22m ago`),
 * hours (`3h ago`) and days (`2d ago`). A span a moment below 0 reads `just now`.
 */
export function formatAgo(ms: number): string {
  requireSpan('formatAgo', ms);
  const span = Math.max(0, ms);
  if (span < MINUTE_MS) return 'just now';
  if (span < HOUR_MS) return `${Math.floor(span / MINUTE_MS)}m ago`;
  if (span < DAY_MS) return `${Math.floor(span / HOUR_MS)}h ago`;
  return `${Math.floor(span / DAY_MS)}d ago`;
}

/**
 * A terminal name without the glyphs Claude Code puts before its title (R12): a leading run of
 * ◐ ◑ ◒ ◓ ✳ and the whitespace after it. A name that is nothing but those comes back as it was,
 * so a row never loses its name.
 */
export function stripSpinner(name: string): string {
  requireText('stripSpinner', 'a terminal name', name);
  const stripped = name.replace(SPINNER_PREFIX, '');
  return stripped === '' ? name : stripped;
}
