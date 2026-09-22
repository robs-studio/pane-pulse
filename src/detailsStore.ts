// The details store: each pane's details (its model, effort and context, its last prompt and
// reply, how long its session has run and how many lines it has changed), kept current from
// Claude Code's own files and read again only where those files changed.
//
// details.ts turns transcript lines into facts and facts into words; claudeFiles.ts finds and
// reads Claude Code's session registry and transcripts. This file decides when to read, and keeps
// what was read, so the panel can ask for a pane's details on every render without touching the
// disk: get() answers from memory, and refresh(), which the extension calls from its ticker and
// whenever the pane list changes, brings that memory up to date and says whether anything a row
// or a peek shows has changed. Panes are named by their claude pid, as the pane list's rows are,
// and lastReply() reads one pane's newest reply fresh from its transcript, for Copy Last Reply.
//
// Seven rules this file is built around:
//
//   * THE REGISTRY NAMES THE SESSION. A /clear starts a new session, and a new transcript, inside
//     the same claude, and Claude Code's registry entry for that pid follows it. So every refresh
//     reads `sessions/<pid>.json` first and takes its session id over the one the pane's last
//     event carried; only a pane with no entry falls back to the event's. When the session id
//     changes, everything read from the old transcript goes, lines changed included, and the new
//     transcript is looked for at once. An entry that is there but cannot be read (caught
//     mid-rewrite, say) is no news: the session the registry last named stands, with its start,
//     so the pane neither blanks nor counts its lines again from nothing.
//   * READ ONLY WHAT CHANGED. A transcript is read again only when its size or modification time
//     differs from the last read: its tail from TAIL_START_BYTES, doubling until it holds the
//     latest usage or reaches TAIL_MAX_BYTES; its head once, for the first timestamp and the
//     model's marketing name; and its lines changed from where the last count stopped, with
//     readFrom, parsing only the lines that name "structuredPatch" or "create". The subagent
//     files beside it are listed and counted too, on a pass that finds the transcript changed and
//     otherwise every SUBAGENT_LIST_PASSES passes (a subagent writes while its session waits on
//     it). So a quiet pane costs a registry read and a stat a tick, and the whole transcript is
//     read once, at its first count, a READ_FROM_MAX_BYTES window at a time with each read
//     awaited, so a transcript of tens of megabytes never holds the extension host for longer
//     than one window's lines. A transcript that is not there yet (every session before its
//     first message) is looked for again as soon as the pane has news (a new event, session or
//     folder), and otherwise at most once every LOCATE_RETRY_MS, because looking for one can mean
//     a scan of every project folder.
//   * WHAT WAS READ STANDS UNTIL SOMETHING NEWER REPLACES IT. A transcript only grows, so a value
//     an earlier read found is older than anything a later tail holds: a tail that no longer
//     reaches the last prompt (one long turn can push it out) keeps the one found before rather
//     than blanking it. A transcript that got shorter is no longer the file that was read, so all
//     of it is read again from its start.
//   * THE TRANSCRIPT WINS; THE LAUNCH FILLS IN (F8). A session that has sent nothing yet (every
//     one after a restart or a /clear, until its first reply) has no assistant record to name its
//     model or effort, so until the transcript names one, the claude's own command line stands
//     in: `claude --model fable --effort xhigh` reads `Fable`, `Fable` and `XHigh`. The command
//     line is read once for the pid's life (a claude's never changes; forget() drops it), and
//     only when the transcript lacks a model or an effort, through the processCommand option,
//     claudeFiles.ts's `ps` by default. Each field is the transcript's the moment it has one.
//   * WORDS, NOT RAW VALUES. A PaneDetails holds what the panel shows (`Opus`, `Opus 5`, `XHigh`,
//     54), made by details.ts, and it is frozen. refresh answers true only when some pane's
//     details differ field by field from what they were, so the panel renders on news rather than
//     on every tick, and a pane whose details did not change keeps the very object it had.
//   * ONE PASS AT A TIME. refresh is called from a ticker and from every change in the list, so
//     calls overlap. One pass runs; a call made meanwhile queues one more, and every later call
//     joins that queued pass, which runs with the newest targets once the running one ends. So
//     two passes never read one pane at once, and a burst of calls costs at most two passes.
//   * A PROBLEM IS SAID ONCE. claudeFiles.ts logs a broken registry file, or a transcript it
//     cannot read, every time it is asked, and a refresh asks every tick. So each pane remembers
//     what each of its reads has reported, by the words with the numbers left out, and says a
//     line again only after that read has once gone through with nothing to report.
//
// No vscode import, not even a type, no timer and no process of its own: the extension's ticker
// calls refresh, the clock is injected (`now`, read once at the start of each pass), and the one
// process a pane can cost (`ps`, for its command line) is claudeFiles.ts's, reached through an
// injectable option, so node --test holds every rule above against temp folders, a fake clock
// and a stubbed command line. Nothing is thrown across the public surface: every method catches,
// logs one line opening with LOG_PREFIX, and answers undefined, false or nothing. A throw here
// would land in the extension's refresh or its ticker.
import * as fsp from 'node:fs/promises';

import {
  HEAD_BYTES,
  TAIL_MAX_BYTES,
  TAIL_START_BYTES,
  locateTranscript,
  processCommand,
  readFrom,
  readHead,
  readRegistryEntry,
  readTail,
  registryEntryFor,
  subagentTranscripts,
} from './claudeFiles.ts';
import {
  cachePercent,
  contextPercent,
  contextTokens,
  contextWindowOf,
  effortWord,
  factsFromLines,
  hasLatestUsage,
  launchChoices,
  linesChanged,
  mergeFacts,
  modelFamily,
  modelFromLaunch,
  modelName,
} from './details.ts';
import type { LaunchChoices, TranscriptFacts } from './details.ts';

/** Every line this module logs opens with this; the lines claudeFiles.ts logs keep their own. */
export const LOG_PREFIX = 'pane-pulse details: ';

/**
 * How long a pane whose transcript was not found waits before it is looked for again, unless the
 * pane has news first (a new event, session or folder). Looking can mean a scan of every folder
 * under `projects/`, and a session has no transcript at all before its first message.
 */
export const LOCATE_RETRY_MS = 5_000;

/**
 * How many passes a pane's subagent files go unlisted while its transcript stands still: the
 * listing and a stat of every file are what a quiet pane would otherwise pay each tick, and a
 * subagent can still be writing while its session's own transcript waits on it.
 */
const SUBAGENT_LIST_PASSES = 15;

/** A pane's details, in the words and numbers the panel shows. Each is absent until known. */
export type PaneDetails = Readonly<{
  /** The model column's word, the family: `Opus` (details.ts modelFamily). */
  model?: string;
  /** The peek's model name: `Opus 5` (details.ts modelName, the marketing name where it agrees). */
  modelName?: string;
  /** The effort column's word: `XHigh` (details.ts effortWord). */
  effort?: string;
  /** How full the context window is, as a whole percentage (R3's window, so an estimate). */
  contextPct?: number;
  /** How many tokens fill the context. */
  contextTokens?: number;
  /** How much of the context was read from the cache, as a whole percentage. */
  cachePct?: number;
  /**
   * When the session began, in ms: the later of its transcript's first timestamp and the claude's
   * start in the registry, so a /resume'd session counts from its resume, not its first record.
   */
  sessionStart?: number;
  /** When the pane last did something, in ms: the later of its last event and its transcript. */
  lastActivity?: number;
  /** The member's last prompt, as Claude Code keeps it (cut near 200 characters). */
  lastPrompt?: string;
  /** The newest reply with any text, its text blocks joined by a blank line. */
  lastReply?: string;
  /** Lines the session's edits and new files added, subagents' included; absent until counted. */
  linesAdded?: number;
  /** Lines the session's edits removed, subagents' included; absent until counted. */
  linesRemoved?: number;
}>;

/** One pane to refresh: its claude pid, and what the pane list's row knows from its events. */
export type DetailsTarget = Readonly<{
  pid: number;
  /** The session id its last event carried; the registry's wins when it has one. */
  sessionId?: string;
  /** The working folder its last event carried; the registry's wins when it has one. */
  cwd?: string;
  /** When its last event was written, in ms. */
  lastEvent?: number;
}>;

/** What a store is built with. */
export type DetailsStoreOptions = Readonly<{
  /** Claude Code's configuration folder, as claudeFiles.ts claudeConfigDir() answers it. */
  configDir: string;
  /** One line per problem, each said once. The wiring passes the output channel. */
  log: (line: string) => void;
  /** Epoch ms, read once at the start of each pass. Injected in tests; defaults to Date.now. */
  now?: () => number;
  /**
   * A claude's command line by its pid, or undefined when it cannot be known; asked at most once
   * per pid. Injected in tests; defaults to claudeFiles.ts processCommand, which runs `ps`.
   */
  processCommand?: (pid: number, log: (line: string) => void) => Promise<string | undefined>;
}>;

/** Every field of PaneDetails, in the order two of them are compared. */
const DETAIL_FIELDS: readonly (keyof PaneDetails)[] = Object.freeze([
  'model',
  'modelName',
  'effort',
  'contextPct',
  'contextTokens',
  'cachePct',
  'sessionStart',
  'lastActivity',
  'lastPrompt',
  'lastReply',
  'linesAdded',
  'linesRemoved',
]);

/**
 * A line that can hold an edit names one of these, as JSON writes them: a tool result's patch,
 * or a Write's new file. Any other line is passed over without being parsed.
 */
const EDIT_MARKS: readonly string[] = Object.freeze(['"structuredPatch"', '"create"']);

/** How many different lines one read of one pane says before it waits for a clean read. */
const SAID_LIMIT = 8;

/** The numbers in a line (a size, a position) move from tick to tick; its reason does not. */
const DIGITS = /\d+/g;

/** What a stat answers when there is nothing there: absent, never a failure. */
const ABSENT_CODES: readonly string[] = Object.freeze(['ENOENT', 'ENOTDIR']);

/** How much of an offending value a log line quotes. */
const QUOTE_LIMIT = 120;

const NO_FACTS: TranscriptFacts = Object.freeze({});
const NO_DETAILS: PaneDetails = Object.freeze({});
const NO_LAUNCH: LaunchChoices = Object.freeze({});

type Log = (line: string) => void;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** How the store asks for a claude's command line (DetailsStoreOptions.processCommand). */
type CommandReader = (pid: number, log: Log) => Promise<string | undefined>;

/** The reads of one pane that each remember what they have said. */
type Site = 'pane' | 'registry' | 'locate' | 'transcript' | 'lines' | 'subagents' | 'launch';

/** What each read of one pane has said since it last went through clean. */
type Said = Map<Site, Set<string>>;

/** A log for one read, and `settle`, called when the read is over. */
type Speaker = Readonly<{ log: Log; settle: () => void }>;

/** A file's size and modification time at one look. */
type FileMark = Readonly<{ size: number; mtimeMs: number }>;

/** What a look at a file found: the file, nothing there, or a problem (already said). */
type Looked =
  | Readonly<{ kind: 'file'; mark: FileMark }>
  | Readonly<{ kind: 'gone' }>
  | Readonly<{ kind: 'failed' }>;

/** One file's count of lines changed: where it stopped, what it found, the file as it was. */
type Tally = Readonly<{ next: number; added: number; removed: number; mark: FileMark }>;

/** Everything the store keeps about one pane. */
type Track = {
  readonly pid: number;
  /** The newest target refresh was handed for this pane. */
  target: DetailsTarget;
  /** Set when the pane is forgotten or the store disposed: a pass reading it keeps nothing. */
  dropped: boolean;
  readonly said: Said;
  /** What get() answers; undefined until the pane's first pass ends. */
  details?: PaneDetails;
  /** The session in effect: the registry's, else the target's. */
  sessionId?: string;
  /** Whether that session came from a registry entry, so a failed read of the entry keeps it. */
  registered: boolean;
  cwd?: string;
  /** The registry's startedAt, kept from the last entry read. */
  startedAt?: number;
  /** The session's transcript, once found. */
  path?: string;
  /** When the transcript was last looked for, and with what: a miss is not repeated each tick. */
  lookedAt?: number;
  lookedWith?: string;
  /** The transcript's size and mtime when its facts were last read. */
  mark?: FileMark;
  /** What the transcript's head said, read once. */
  head?: TranscriptFacts;
  /** Everything read from the transcript so far, the newest winning. */
  facts?: TranscriptFacts;
  /** Lines changed, per file: the transcript and each subagent file. */
  readonly tallies: Map<string, Tally>;
  /** Whether the transcript's lines changed have been counted once, so the counts can be shown. */
  counted: boolean;
  /** The transcript's size and mtime when its subagent files were last listed. */
  listedWith?: FileMark;
  /** Passes since the subagent files were last listed, the transcript standing still. */
  quietPasses: number;
  /**
   * What the claude's command line says it was launched with: undefined until it is read, which
   * is once for the pid's life, and only when the transcript lacks a model or an effort.
   */
  launch?: LaunchChoices;
};

/** The one pass that waits behind the running one, shared by every call made meanwhile. */
type Queued = {
  targets: readonly DetailsTarget[];
  readonly promise: Promise<boolean>;
  readonly resolve: (changed: boolean) => void;
};

/** Only reached when the caller wired no log: the extension host's own log, not silence. */
function defaultLog(line: string): void {
  console.error(line);
}

/** A log that throws, a disposed output channel say, must not turn an answer into a throw. */
function quiet(log: Log | undefined): Log {
  const target = log ?? defaultLog;
  return (line: string): void => {
    try {
      target(line);
    } catch {
      // Nowhere left to report it, and nothing here throws.
    }
  };
}

function codeOf(error: unknown): string {
  try {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { readonly code?: unknown }).code;
      if (typeof code === 'string' && code !== '') return code;
    }
  } catch {
    // A hostile error object still gets reported, as having no code.
  }
  return 'no error code';
}

function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'an error that could not be printed';
  }
}

function isAbsent(error: unknown): boolean {
  return ABSENT_CODES.includes(codeOf(error));
}

/** A value as a log line shows it, capped; never a throw, whatever the value is. */
function quote(value: unknown): string {
  try {
    // JSON would print NaN and Infinity as null, and throws on a bigint.
    if (typeof value === 'number') return String(value);
    if (typeof value === 'bigint') return `${String(value)}n`;
    const text = JSON.stringify(value) ?? String(value);
    return text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}...` : text;
  } catch {
    return 'a value that could not be printed';
  }
}

/** What a refused argument was, for the refusal's words. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return `a ${typeof value}`;
}

/** A claude pid: a positive whole number. */
function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** A target as the store keeps it: a pid, and only the fields that have the right type. */
function targetOf(value: unknown): DetailsTarget | undefined {
  try {
    if (typeof value !== 'object' || value === null) return undefined;
    const given = value as Readonly<Record<string, unknown>>;
    const { pid, sessionId, cwd, lastEvent } = given;
    if (!isPid(pid)) return undefined;
    const target: Mutable<DetailsTarget> = { pid };
    if (isFilledString(sessionId)) target.sessionId = sessionId;
    if (isFilledString(cwd)) target.cwd = cwd;
    if (isTime(lastEvent)) target.lastEvent = lastEvent;
    return Object.freeze(target);
  } catch {
    return undefined;
  }
}

function newTrack(target: DetailsTarget): Track {
  return {
    pid: target.pid,
    target,
    dropped: false,
    said: new Map(),
    registered: false,
    tallies: new Map(),
    counted: false,
    quietPasses: 0,
  };
}

/** Everything read from the transcript goes, its path kept: it is read again from its start. */
function restartTranscript(track: Track): void {
  track.mark = undefined;
  track.head = undefined;
  track.facts = undefined;
  track.tallies.clear();
  track.counted = false;
  track.listedWith = undefined;
  track.quietPasses = 0;
}

/** Everything read from the transcript goes, its path too, and it is looked for again at once. */
function loseTranscript(track: Track): void {
  restartTranscript(track);
  track.path = undefined;
  track.lookedAt = undefined;
  track.lookedWith = undefined;
}

function sameMark(a: FileMark, b: FileMark): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Whether this pass lists the pane's subagent files: when they have not been listed since the
 * transcript last changed (its `mark` now), and otherwise on every SUBAGENT_LIST_PASSES-th pass.
 */
function subagentsDue(track: Track, mark: FileMark): boolean {
  const listed = track.listedWith;
  if (listed !== undefined && sameMark(listed, mark)) {
    track.quietPasses += 1;
    if (track.quietPasses < SUBAGENT_LIST_PASSES) return false;
  }
  track.listedWith = mark;
  track.quietPasses = 0;
  return true;
}

/** A file's size and mtime, by stat, never an open. Nothing there is `gone`, quietly. */
async function lookAt(path: string, log: Log): Promise<Looked> {
  try {
    const info = await fsp.stat(path);
    if (info.isFile()) return { kind: 'file', mark: { size: info.size, mtimeMs: info.mtimeMs } };
    log(
      `${LOG_PREFIX}did not read ${path}, because it is not a plain file, and only a transcript ` +
        'file is read',
    );
    return { kind: 'failed' };
  } catch (error) {
    if (isAbsent(error)) return { kind: 'gone' };
    log(
      `${LOG_PREFIX}could not look at ${path} (${codeOf(error)}): ${messageOf(error)}, so it is ` +
        'not read this time',
    );
    return { kind: 'failed' };
  }
}

/**
 * What the end of a transcript says: the last TAIL_START_BYTES, doubled until `enough` holds, the
 * read reached the file's start, or TAIL_MAX_BYTES was read. Undefined when it could not be read
 * (claudeFiles.ts has said why, or it is not there).
 */
async function grownTail(
  path: string,
  enough: (facts: TranscriptFacts) => boolean,
  log: Log,
): Promise<TranscriptFacts | undefined> {
  let bytes = TAIL_START_BYTES;
  for (;;) {
    const chunk = await readTail(path, bytes, log);
    if (chunk === undefined) return undefined;
    const facts = factsFromLines(chunk.lines);
    if (enough(facts) || bytes >= TAIL_MAX_BYTES || bytes >= chunk.size) return facts;
    bytes = Math.min(bytes * 2, TAIL_MAX_BYTES);
  }
}

function isEditLine(line: string): boolean {
  return EDIT_MARKS.some((mark) => line.includes(mark));
}

/** The later of two times, either of which may be unknown. */
function laterOf(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * Whether this pass reads the claude's command line: never read for this pid yet, and the
 * transcript still lacks a model or an effort, which is all the command line can stand in for.
 */
function launchWanted(track: Track): boolean {
  if (track.launch !== undefined) return false;
  const facts = track.facts ?? NO_FACTS;
  return facts.modelId === undefined || facts.effort === undefined;
}

/**
 * A pane's details in the panel's words, from everything the store has read about it. The model
 * and the effort are each the transcript's when it names one, else the launch's (F8). Frozen.
 */
function detailsOf(track: Track): PaneDetails {
  const facts = track.facts ?? NO_FACTS;
  const launch = track.launch ?? NO_LAUNCH;
  const details: Mutable<PaneDetails> = {};
  if (facts.modelId !== undefined) {
    details.model = modelFamily(facts.modelId);
    details.modelName = modelName(facts.modelId, facts.marketingName);
  } else if (launch.model !== undefined) {
    const launched = modelFromLaunch(launch.model);
    details.model = launched.family;
    details.modelName = launched.name;
  }
  const effort = facts.effort ?? launch.effort;
  if (effort !== undefined) details.effort = effortWord(effort);
  if (facts.usage !== undefined) {
    const tokens = contextTokens(facts.usage);
    details.contextTokens = tokens;
    details.contextPct = contextPercent(tokens, contextWindowOf(facts.modelId, tokens));
    const cache = cachePercent(facts.usage);
    if (cache !== undefined) details.cachePct = cache;
  }
  // A /resume'd session's transcript opens days before this claude started: the later one wins.
  const start = laterOf(facts.firstTimestamp, track.startedAt);
  if (start !== undefined) details.sessionStart = start;
  const written =
    track.mark === undefined ? undefined : (facts.lastTimestamp ?? Math.floor(track.mark.mtimeMs));
  const activity = laterOf(track.target.lastEvent, written);
  if (activity !== undefined) details.lastActivity = activity;
  if (facts.lastPrompt !== undefined) details.lastPrompt = facts.lastPrompt;
  if (facts.lastReply !== undefined) details.lastReply = facts.lastReply;
  if (track.counted) {
    let added = 0;
    let removed = 0;
    for (const tally of track.tallies.values()) {
      added += tally.added;
      removed += tally.removed;
    }
    details.linesAdded = added;
    details.linesRemoved = removed;
  }
  return Object.freeze(details);
}

function sameDetails(a: PaneDetails, b: PaneDetails): boolean {
  return DETAIL_FIELDS.every((field) => Object.is(a[field], b[field]));
}

function queuedPass(targets: readonly DetailsTarget[]): Queued {
  let resolve: (changed: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  return { targets, promise, resolve };
}

/**
 * Each pane's details, kept current by refresh() and answered from memory by get(). Construct it
 * with Claude Code's config folder and the output channel's log; call refresh() with the live
 * rows' targets whenever they may have news, forget() a pane when it goes, and dispose() at
 * deactivation. Every method answers and none throws.
 */
export class DetailsStore {
  readonly #configDir: string;
  readonly #log: Log;
  readonly #now: () => number;
  readonly #processCommand: CommandReader;
  readonly #tracks = new Map<number, Track>();
  /** What the store itself has said about its callers' mistakes, each once. */
  readonly #said: Said = new Map();
  #running: Promise<boolean> | undefined;
  #queued: Queued | undefined;
  #disposed = false;

  constructor(options: DetailsStoreOptions) {
    let log: Log | undefined;
    let configDir = '';
    let now: () => number = Date.now;
    let command: CommandReader = processCommand;
    try {
      if (typeof options === 'object' && options !== null) {
        if (typeof options.log === 'function') log = options.log;
        if (typeof options.configDir === 'string') configDir = options.configDir;
        if (typeof options.now === 'function') now = options.now;
        if (typeof options.processCommand === 'function') command = options.processCommand;
      }
    } catch {
      // Options that cannot be read leave the defaults; claudeFiles.ts refuses an empty folder.
    }
    this.#log = quiet(log);
    this.#configDir = configDir;
    this.#now = now;
    this.#processCommand = command;
  }

  /** The pane's details from the last refresh that read it, or undefined if none has. */
  get(pid: number): PaneDetails | undefined {
    if (this.#disposed) return undefined;
    return this.#tracks.get(pid)?.details;
  }

  /**
   * Bring the targets' details up to date, and answer whether any pane's changed. A call made
   * while a pass runs waits for one more pass, which every later call joins and which reads the
   * newest targets; a store that is disposed answers false and reads nothing. Panes left out of
   * the targets keep what they have until forget(). Never rejects.
   */
  refresh(targets: readonly DetailsTarget[]): Promise<boolean> {
    try {
      if (this.#disposed) return Promise.resolve(false);
      if (!Array.isArray(targets)) {
        this.#say(
          `${LOG_PREFIX}refresh was handed ${kindOf(targets)} rather than a list of panes, so ` +
            'nothing was read',
        );
        return Promise.resolve(false);
      }
      const panes = this.#targetsOf(targets);
      if (this.#running === undefined) return this.#begin(panes);
      if (this.#queued === undefined) this.#queued = queuedPass(panes);
      else this.#queued.targets = panes;
      return this.#queued.promise;
    } catch (error) {
      this.#fail('start a details refresh', error, 'nothing was read this time');
      return Promise.resolve(false);
    }
  }

  /**
   * The newest reply of the pane's session, read fresh from its transcript's tail (grown as far
   * as TAIL_MAX_BYTES until it holds one), for Copy Last Reply; undefined when the session has
   * no transcript or no reply yet. The session is the registry's, else the one the last refresh
   * used. Never rejects.
   */
  async lastReply(pid: number): Promise<string | undefined> {
    try {
      if (this.#disposed) return undefined;
      if (!isPid(pid)) {
        this.#say(
          `${LOG_PREFIX}refused to read the last reply of ${quote(pid)}, because a pane is named ` +
            'by its claude pid, a positive whole number',
        );
        return undefined;
      }
      const track = this.#tracks.get(pid);
      const said: Said = track?.said ?? new Map();
      const registry = this.#speaker(said, 'registry');
      const entry = registryEntryFor(this.#configDir, pid, registry.log);
      registry.settle();
      const sessionId = entry?.sessionId ?? track?.sessionId;
      if (sessionId === undefined) return undefined;
      let path = track !== undefined && track.sessionId === sessionId ? track.path : undefined;
      if (path === undefined) {
        const locate = this.#speaker(said, 'locate');
        path = locateTranscript(this.#configDir, sessionId, entry?.cwd ?? track?.cwd, locate.log);
        locate.settle();
      }
      if (path === undefined) return undefined;
      const transcript = this.#speaker(said, 'transcript');
      const facts = await grownTail(path, (read) => read.lastReply !== undefined, transcript.log);
      transcript.settle();
      return this.#disposed ? undefined : facts?.lastReply;
    } catch (error) {
      this.#fail(`read the last reply of pane ${quote(pid)}`, error, 'there is none to copy');
      return undefined;
    }
  }

  /** Drop everything kept about the pane; a pass still reading it keeps nothing it finds. */
  forget(pid: number): void {
    try {
      const track = this.#tracks.get(pid);
      if (track === undefined) return;
      track.dropped = true;
      this.#tracks.delete(pid);
    } catch (error) {
      this.#fail(`forget pane ${quote(pid)}`, error, 'its details may linger until refreshed');
    }
  }

  /**
   * Drop every pane, answer false to a pass still waiting, and refuse every later call. A pass
   * already running finishes its reads and keeps nothing. A second dispose does nothing.
   */
  dispose(): void {
    try {
      if (this.#disposed) return;
      this.#disposed = true;
      for (const track of this.#tracks.values()) track.dropped = true;
      this.#tracks.clear();
      const queued = this.#queued;
      this.#queued = undefined;
      queued?.resolve(false);
    } catch (error) {
      this.#fail('dispose of the details store', error, 'it may keep some details in memory');
    }
  }

  /** The targets as the store keeps them: one per pid (the last one given), the invalid said. */
  #targetsOf(targets: readonly unknown[]): readonly DetailsTarget[] {
    const byPid = new Map<number, DetailsTarget>();
    for (const value of targets) {
      const target = targetOf(value);
      if (target === undefined) {
        this.#say(
          `${LOG_PREFIX}skipped a pane handed to refresh (${quote(value)}), because a pane is ` +
            'named by its claude pid, a positive whole number',
        );
        continue;
      }
      byPid.set(target.pid, target);
    }
    return Object.freeze([...byPid.values()]);
  }

  #begin(targets: readonly DetailsTarget[]): Promise<boolean> {
    const pass = this.#pass(targets);
    this.#running = pass;
    void pass.then(() => this.#next());
    return pass;
  }

  /** The running pass ended: start the queued one, if there is one and the store still runs. */
  #next(): void {
    this.#running = undefined;
    const queued = this.#queued;
    this.#queued = undefined;
    if (queued === undefined) return;
    try {
      if (this.#disposed) {
        queued.resolve(false);
        return;
      }
      void this.#begin(queued.targets).then(queued.resolve);
    } catch (error) {
      this.#fail('start the queued details refresh', error, 'it answered no change');
      queued.resolve(false);
    }
  }

  async #pass(targets: readonly DetailsTarget[]): Promise<boolean> {
    try {
      const now = this.#clock();
      let changed = false;
      for (const target of targets) {
        if (this.#disposed) return false;
        if (await this.#refreshPane(target, now)) changed = true;
      }
      return changed && !this.#disposed;
    } catch (error) {
      this.#fail("refresh the panes' details", error, 'they stay as they were until the next one');
      return false;
    }
  }

  /** One pane's part of a pass: the registry, the transcript, the launch when due, the details. */
  async #refreshPane(target: DetailsTarget, now: number): Promise<boolean> {
    let track = this.#tracks.get(target.pid);
    if (track === undefined) {
      track = newTrack(target);
      this.#tracks.set(target.pid, track);
    }
    track.target = target;
    const pane = this.#speaker(track.said, 'pane');
    try {
      this.#readRegistry(track);
      if (track.sessionId !== undefined) await this.#readTranscript(track, now);
      if (!track.dropped && launchWanted(track)) await this.#readLaunch(track);
      return !track.dropped && this.#commit(track);
    } catch (error) {
      pane.log(
        `${LOG_PREFIX}could not refresh the details of pane ${target.pid} (${codeOf(error)}): ` +
          `${messageOf(error)}, so they stay as they were until the next refresh`,
      );
      return false;
    } finally {
      pane.settle();
    }
  }

  /**
   * The session in effect: the registry's (it follows /clear), else the target's. A registry read
   * that failed (claudeFiles.ts has said why, once a spell through this read's speaker) is no
   * news: a session an earlier entry named stands, start and folder too, rather than the pane
   * dropping it and counting its lines again from nothing when the entry reads cleanly again.
   */
  #readRegistry(track: Track): void {
    const registry = this.#speaker(track.said, 'registry');
    const read = readRegistryEntry(this.#configDir, track.pid, registry.log);
    registry.settle();
    if (read.kind === 'failed' && track.registered) return;
    const entry = read.kind === 'entry' ? read.entry : undefined;
    track.registered = entry !== undefined;
    const sessionId = entry?.sessionId ?? track.target.sessionId;
    if (entry !== undefined) track.startedAt = entry.startedAt;
    if (sessionId !== track.sessionId) {
      loseTranscript(track);
      track.sessionId = sessionId;
    }
    track.cwd = entry?.cwd ?? track.target.cwd;
  }

  /** The transcript's path, looked for unless it was missed a moment ago with nothing new since. */
  #locate(track: Track, now: number): string | undefined {
    const sessionId = track.sessionId;
    if (sessionId === undefined) return undefined;
    const { cwd, target } = track;
    const lookingWith = JSON.stringify([sessionId, cwd ?? null, target.lastEvent ?? null]);
    const lookedAt = track.lookedAt;
    const recent = lookedAt !== undefined && now >= lookedAt && now - lookedAt < LOCATE_RETRY_MS;
    if (recent && lookingWith === track.lookedWith) return undefined;
    track.lookedAt = now;
    track.lookedWith = lookingWith;
    const locate = this.#speaker(track.said, 'locate');
    track.path = locateTranscript(this.#configDir, sessionId, track.cwd, locate.log);
    locate.settle();
    return track.path;
  }

  /** The transcript's facts when it changed, then its lines changed and its subagents'. */
  async #readTranscript(track: Track, now: number): Promise<void> {
    const path = track.path ?? this.#locate(track, now);
    if (path === undefined) return;
    const transcript = this.#speaker(track.said, 'transcript');
    try {
      const looked = await lookAt(path, transcript.log);
      if (track.dropped || looked.kind === 'failed') return;
      if (looked.kind === 'gone') {
        loseTranscript(track);
        return;
      }
      const mark = looked.mark;
      if (track.mark !== undefined && mark.size < track.mark.size) {
        transcript.log(
          `${LOG_PREFIX}the transcript of pane ${track.pid} at ${path} is ${mark.size} bytes, ` +
            `fewer than the ${track.mark.size} it had when last read, so it was rewritten and ` +
            'is read again from its start',
        );
        restartTranscript(track);
      }
      if (track.mark === undefined || !sameMark(track.mark, mark)) {
        await this.#readFacts(track, path, mark, transcript.log);
      }
      if (!track.dropped) await this.#countLines(track, path, mark);
    } finally {
      transcript.settle();
    }
  }

  /** The head once, then the tail grown to the latest usage, merged over what was read before. */
  async #readFacts(track: Track, path: string, mark: FileMark, log: Log): Promise<void> {
    if (track.head === undefined) {
      const head = await readHead(path, HEAD_BYTES, log);
      if (track.dropped) return;
      // A head with no complete line yet is read again, unless its window is already full.
      if (head !== undefined && (head.lines.length > 0 || head.size >= HEAD_BYTES)) {
        track.head = factsFromLines(head.lines);
      }
    }
    const tail = await grownTail(path, hasLatestUsage, log);
    if (track.dropped || tail === undefined) return;
    const known = mergeFacts(track.head ?? NO_FACTS, track.facts ?? NO_FACTS);
    track.facts = mergeFacts(known, tail);
    track.mark = mark;
  }

  /**
   * Lines changed in the transcript, from where its count stopped, then in every subagent file
   * beside it when they are due a listing (subagentsDue); between listings their counts stand.
   * The subagents say their problems through a speaker of their own, settled only on a pass that
   * reads them, so a quiet pass between listings never makes a standing problem be said again.
   */
  async #countLines(track: Track, path: string, mark: FileMark): Promise<void> {
    const lines = this.#speaker(track.said, 'lines');
    try {
      if (await this.#tally(track, path, mark, lines.log)) track.counted = true;
    } finally {
      lines.settle();
    }
    if (track.dropped || !subagentsDue(track, mark)) return;
    const subagents = this.#speaker(track.said, 'subagents');
    try {
      for (const file of subagentTranscripts(path, subagents.log)) {
        if (track.dropped) return;
        await this.#tally(track, file, undefined, subagents.log);
      }
    } finally {
      subagents.settle();
    }
  }

  /**
   * One file's count brought up to date: the lines appended since its last count, when its size
   * or mtime changed, and only those naming an edit parsed. They are read one readFrom window at
   * a time (READ_FROM_MAX_BYTES), each read awaited, up to the size the file had at the start of
   * this pass, so a first count of tens of megabytes holds neither the extension host nor more
   * than one window in memory at once. A window that cannot be read keeps nothing of this count,
   * and the next pass counts again from where the last one finished. Answers whether the count is
   * current.
   */
  async #tally(
    track: Track,
    file: string,
    known: FileMark | undefined,
    log: Log,
  ): Promise<boolean> {
    let mark = known;
    if (mark === undefined) {
      const looked = await lookAt(file, log);
      if (looked.kind !== 'file') return false;
      mark = looked.mark;
    }
    let tally = track.tallies.get(file);
    if (tally !== undefined && sameMark(tally.mark, mark)) return true;
    if (tally !== undefined && mark.size < tally.next) {
      log(
        `${LOG_PREFIX}${file} is ${mark.size} bytes, fewer than the ${tally.next} already ` +
          'counted, so it was rewritten and its lines changed are counted again from its start',
      );
      tally = undefined;
    }
    let next = tally?.next ?? 0;
    let added = tally?.added ?? 0;
    let removed = tally?.removed ?? 0;
    while (next < mark.size) {
      const read = await readFrom(file, next, log);
      if (read === undefined || track.dropped) return false;
      const count = linesChanged(read.lines.filter(isEditLine));
      added += count.added;
      removed += count.removed;
      // Nothing whole past `next`: what is left is a line still being written, read once it ends.
      if (read.next <= next) break;
      next = read.next;
    }
    track.tallies.set(file, Object.freeze({ next, added, removed, mark }));
    return true;
  }

  /**
   * What the claude's command line says it was launched with, read once for the pid's life: the
   * answer is kept whatever it is (none included), so a claude whose command line cannot be read
   * never costs a `ps` a tick. A reader that throws, rejects or answers something other than text
   * is said once and read as no command line. A pane forgotten meanwhile keeps nothing.
   */
  async #readLaunch(track: Track): Promise<void> {
    const launch = this.#speaker(track.said, 'launch');
    let command: unknown;
    try {
      command = await this.#processCommand(track.pid, launch.log);
    } catch (error) {
      launch.log(
        `${LOG_PREFIX}could not read the command line of pane ${track.pid} (${codeOf(error)}): ` +
          `${messageOf(error)}, so its launch model and effort are not shown`,
      );
    }
    if (command !== undefined && typeof command !== 'string') {
      launch.log(
        `${LOG_PREFIX}the command line of pane ${track.pid} came back as ${quote(command)} ` +
          'rather than text, so its launch model and effort are not shown',
      );
    }
    launch.settle();
    if (track.dropped) return;
    track.launch = typeof command === 'string' ? launchChoices(command) : NO_LAUNCH;
  }

  /** The pane's new details, kept only when some field differs; answers whether one did. */
  #commit(track: Track): boolean {
    const next = detailsOf(track);
    if (sameDetails(track.details ?? NO_DETAILS, next)) {
      track.details ??= next;
      return false;
    }
    track.details = next;
    return true;
  }

  /**
   * A log for one read: a line is said only when this read has not said it (numbers aside) since
   * it last went through clean, and at most SAID_LIMIT different lines are said meanwhile.
   * `settle` forgets what the read said when it said nothing this time.
   */
  #speaker(said: Said, site: Site): Speaker {
    let spoke = false;
    return Object.freeze({
      log: (line: string): void => {
        spoke = true;
        const key = String(line).replace(DIGITS, '#');
        let seen = said.get(site);
        if (seen === undefined) {
          seen = new Set();
          said.set(site, seen);
        }
        if (seen.has(key) || seen.size >= SAID_LIMIT) return;
        seen.add(key);
        this.#log(line);
      },
      settle: (): void => {
        if (!spoke) said.delete(site);
      },
    });
  }

  /** A caller's mistake, said once. */
  #say(line: string): void {
    this.#speaker(this.#said, 'pane').log(line);
  }

  /** The injected clock, once per pass; one that throws or answers nonsense gives way to Date. */
  #clock(): number {
    try {
      const now = this.#now();
      if (isTime(now)) return now;
      this.#say(
        `${LOG_PREFIX}the clock answered ${quote(now)} rather than a time in ms, so the system ` +
          'clock was read instead',
      );
    } catch (error) {
      this.#say(
        `${LOG_PREFIX}could not read the clock (${codeOf(error)}): ${messageOf(error)}, so the ` +
          'system clock was read instead',
      );
    }
    return Date.now();
  }

  #fail(what: string, error: unknown, consequence: string): void {
    this.#log(
      `${LOG_PREFIX}could not ${what} (${codeOf(error)}): ${messageOf(error)}, so ${consequence}`,
    );
  }
}
