// The Claude files: where the pane list reads what Claude Code itself keeps on disk about each
// running session, read-only.
//
// Every number a pane's row shows comes from two places Claude Code writes for its own use. The
// session registry, `<config>/sessions/<pid>.json`, holds one small JSON file per running claude,
// removed at its exit: the session id (which follows a /clear), the working folder, when it
// started and whether it is busy, idle or waiting. The transcript,
// `<config>/projects/<slug of the cwd>/<sessionId>.jsonl`, holds one JSON record per line, and its
// last lines carry the model, the effort, the token usage and the last prompt. `<config>` is
// CLAUDE_CONFIG_DIR when it is set, else `~/.claude`. Neither shape is documented by Anthropic, so
// this file reads them tolerantly and answers nothing, never a guess, when a file is not what it
// expects; details.ts makes sense of the lines, and detailsStore.ts decides when to read.
//
// It also reads one thing Claude Code does not write down: the command line a claude was started
// with (processCommand), since a session that has sent nothing yet has no transcript record to
// name its model or effort, and `claude --model fable --effort xhigh` does (F8).
//
// Six rules this file is built around, each load-bearing:
//
//   * READ-ONLY, AND ONLY WHAT IT NAMES. Nothing here writes, renames or deletes, anywhere. The
//     registry folder also holds a `<pid>.<hash>.key` beside each `<pid>.json`, and that is a
//     credential: the listing is filtered to names of digits and `.json` before any file is
//     touched, so a key file is never opened, stat'ed or read, and a registry entry is only ever
//     read from a plain file (a link or a device in its place is refused before it is opened).
//   * A SESSION ID NEVER BECOMES A PATH UNCHECKED. A transcript's file name is built from a session
//     id, so an id that is anything but hex digits and dashes is refused, by name, before any path
//     is made from it: `../` can never walk out of the projects folder.
//   * ONLY COMPLETE LINES. Claude Code appends a record while this reads, and a single record can
//     run past a megabyte, so a line counts only once its newline is on disk. A window that starts
//     inside a line drops that partial first line; a line with no newline yet is left for the next
//     read, and readFrom's `next` stops before it so that read picks it up whole. Blank lines carry
//     no record and are left out; a carriage return before a newline is stripped.
//   * NEVER THE WHOLE FILE. A transcript can grow to tens of megabytes, so the readers open it and
//     read only the byte range they were asked for, at an offset: the tail from its end, the head
//     from its start, and readFrom what was appended since the last read, at most
//     READ_FROM_MAX_BYTES a call (a caller counting a whole transcript reads it window by window);
//     only a single line longer than that is read past it, since a line is whole or not at all.
//   * ABSENT IS AN ANSWER, NOT A FAILURE. No registry file for a pid, no transcript before a
//     session's first message, no subagents folder: each answers undefined or empty, quietly. Only
//     a surprise (a file that cannot be read, a record that is not the shape Claude Code writes) is
//     logged, one line opening with LOG_PREFIX that says what was skipped and why. One pid's
//     registry read tells the two apart (readRegistryEntry), so a file caught mid-rewrite is not
//     taken for a session that ended.
//   * ONE PROCESS, NAMED, BOUNDED AND NEVER A SHELL. processCommand runs `ps` for one pid, and
//     that is the only process this file starts: the pid is checked to be a positive whole number
//     before anything runs, the arguments go to execFile as a list so no shell ever parses them,
//     and PROCESS_COMMAND_TIMEOUT_MS stops a `ps` that hangs. A pid with no process (it has just
//     exited) answers undefined quietly, as an absent file does; Windows has no `ps`, so there it
//     answers undefined without starting anything, and a pane shows dashes until its transcript
//     speaks.
//
// No vscode import, not even a type, so node --test holds every rule above against temp folders.
// Nothing is thrown across the public surface: every function catches, logs through the log it is
// handed (the extension host's own console when none is), and answers undefined or an empty
// result. A throw here would land in the details refresh or in the extension host's event loop.
import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** Every line this module logs opens with this, as the other modules' lines do. */
export const LOG_PREFIX = 'pane-pulse claude files: ';

/** The variable Claude Code reads for its configuration folder, when set. */
export const CONFIG_ENV = 'CLAUDE_CONFIG_DIR';

/** Where the tail read starts: enough for the last few records of a quiet session. */
export const TAIL_START_BYTES = 65_536;

/** How far the tail read may double to (8 MiB): past it, a pane shows what it has. */
export const TAIL_MAX_BYTES = 8_388_608;

/** How much of a transcript's start is read, once, for its first timestamp and model name. */
export const HEAD_BYTES = 65_536;

/**
 * The most readFrom answers in one call unless told otherwise (2 MiB), so the first count of a
 * tens-of-megabytes transcript is read a window at a time, never whole.
 */
export const READ_FROM_MAX_BYTES = 2_097_152;

/**
 * How long `ps` may take to print one process's command line before it is stopped: it answers in
 * milliseconds, and the details refresh waits on it.
 */
export const PROCESS_COMMAND_TIMEOUT_MS = 2_000;

/** The most `ps` may print for one process; a command line is far shorter than this (1 MiB). */
const PROCESS_COMMAND_MAX_BUFFER = 1_048_576;

/**
 * What `ps` is asked for one pid's command line: the full line however wide it runs (`-ww`, so
 * neither a COLUMNS in the environment nor a controlling terminal can cut it), with no header.
 */
const PS_FILE = 'ps';
const PS_COMMAND_ARGS: readonly string[] = Object.freeze(['-ww', '-o', 'command=', '-p']);

/** `ps`'s exit status when it finds no process for the pid, printing nothing. */
const PS_NO_SUCH_PROCESS = 1;

/** `<home>/.claude`, when CONFIG_ENV is not set. */
const CONFIG_BASENAME = '.claude';

/** `<config>/sessions/`: the registry, one `<pid>.json` per running session. */
const SESSIONS_DIRNAME = 'sessions';

/** `<config>/projects/`: one folder per working folder, named by its slug. */
const PROJECTS_DIRNAME = 'projects';

/** `<projects>/<slug>/<sessionId>/subagents/`: the transcripts a session's subagents write. */
const SUBAGENTS_DIRNAME = 'subagents';

const REGISTRY_EXTENSION = '.json';
const TRANSCRIPT_EXTENSION = '.jsonl';

/** The only registry names ever read. A `<pid>.<hash>.key` beside them never matches. */
const REGISTRY_NAME = /^\d+\.json$/;

/** A session id: hex digits and dashes (a UUID), which cannot name a path of its own. */
const SESSION_ID = /^[0-9a-fA-F-]{8,}$/;

/**
 * What Claude Code's slug replaces: every UTF-16 unit that is not an ASCII letter or digit, each
 * with one dash, as its own `replace(/[^a-zA-Z0-9]/g, "-")` does (read in 2.1.278).
 */
const NOT_SLUG = /[^a-zA-Z0-9]/g;

/** Past this many characters Claude Code cuts the slug and appends a hash of the whole path. */
const SLUG_LIMIT = 200;

/** A registry entry is under a kilobyte; one far bigger than this is not what Claude Code wrote. */
const REGISTRY_MAX_BYTES = 1_048_576;

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/** How much of an offending value a log line quotes. */
const QUOTE_LIMIT = 120;

/** What an open or a listing answers when there is nothing there: absent, never a failure. */
const ABSENT_CODES: readonly string[] = Object.freeze(['ENOENT', 'ENOTDIR']);

/**
 * Open for reading, never waiting: a FIFO in a file's place would otherwise hold the open until
 * something writes to it. O_NONBLOCK does not exist on Windows, where the fallback is plain.
 */
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

/** The registry read also refuses a link swapped in after its lstat, where the platform can. */
const REGISTRY_READ_FLAGS = READ_FLAGS | (fs.constants.O_NOFOLLOW ?? 0);

const ABSENT: RegistryRead = Object.freeze({ kind: 'absent' });
const FAILED: RegistryRead = Object.freeze({ kind: 'failed' });

const NO_ENTRIES: readonly RegistryEntry[] = Object.freeze([]);
const NO_PATHS: readonly string[] = Object.freeze([]);
const NO_LINES: readonly string[] = Object.freeze([]);

type Log = (line: string) => void;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** One running session, as its registry file records it. Only these fields are kept. */
export type RegistryEntry = Readonly<{
  pid: number;
  sessionId: string;
  cwd: string;
  /** Epoch milliseconds, when the session started. */
  startedAt?: number;
  /** Claude Code's word: `busy`, `idle` or `waiting`, passed through as written. */
  status?: string;
  /** What a waiting session waits for, when its registry file says. */
  waitingFor?: string;
}>;

/**
 * What one pid's registry read found: its `entry`; `absent`, no file for the pid (not a Claude
 * Code session, or one that has ended), said nothing; or `failed`, a file that is there but could
 * not be read or is not an entry (caught mid-rewrite, say), already logged. A reader holding an
 * earlier entry takes failed as no news, never as the session's end.
 */
export type RegistryRead =
  | Readonly<{ kind: 'entry'; entry: RegistryEntry }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'failed' }>;

/** Complete lines from one read, with the file's size and modification time at that read. */
export type Chunk = Readonly<{ lines: readonly string[]; size: number; mtimeMs: number }>;

/** A file opened for reading, with what fstat said about it. */
type Opened = Readonly<{ handle: FileHandle; size: number; mtimeMs: number }>;

/** The complete lines of a buffer, and the index just past the last newline it consumed. */
type Split = Readonly<{ lines: string[]; end: number }>;

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

/** One failure, as a line: what could not be done, the code and message, and what follows. */
function failed(report: Log, what: string, error: unknown, consequence: string): void {
  report(
    `${LOG_PREFIX}could not ${what} (${codeOf(error)}): ${messageOf(error)}, so ${consequence}`,
  );
}

/** A process id: a positive whole number. */
function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** A home that cannot be found falls back to the temp folder, where no session keeps its files. */
function homeOrTemp(): string {
  try {
    return homedir();
  } catch {
    return tmpdir();
  }
}

function configuredDir(env: NodeJS.ProcessEnv | undefined): string | undefined {
  try {
    const configured = env?.[CONFIG_ENV];
    return isFilledString(configured) ? configured : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Claude Code's configuration folder: CLAUDE_CONFIG_DIR, resolved, when it is set and not empty;
 * else `<home>/.claude`. Both are injectable, as backup.ts's resolveRoot's are. Never throws.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  const configured = configuredDir(env);
  if (configured !== undefined) return resolve(configured);
  return join(typeof home === 'string' ? home : homeOrTemp(), CONFIG_BASENAME);
}

/**
 * Whether `configDir` is refused, with the line said: a config folder is a non-empty path, and an
 * empty one would be read against wherever the extension host happens to run.
 */
function refusedConfig(configDir: unknown, report: Log): boolean {
  if (isFilledString(configDir)) return false;
  report(
    `${LOG_PREFIX}refused to read under the config folder ${quote(configDir)}, because a config ` +
      'folder is a non-empty path, and anything else would be read against wherever the ' +
      'extension host runs',
  );
  return true;
}

/**
 * A registry file's text, read from a plain file only, capped at REGISTRY_MAX_BYTES. Answers a
 * refusal, in words, for a file that is not a plain file or is too big to be an entry; throws what
 * the file system throws, for the caller to sort into absent and failed.
 */
function readRegistryText(file: string): Readonly<{ text: string } | { refused: string }> {
  if (!fs.lstatSync(file).isFile()) {
    return {
      refused:
        'it is not a plain file (a link, a folder or a device), and only a file Claude Code ' +
        'wrote is read',
    };
  }
  const fd = fs.openSync(file, REGISTRY_READ_FLAGS);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      return { refused: 'it stopped being a plain file between its check and its opening' };
    }
    if (opened.size > REGISTRY_MAX_BYTES) {
      return {
        refused:
          `it is ${opened.size} bytes, far more than a registry entry needs ` +
          `(at most ${REGISTRY_MAX_BYTES} are read)`,
      };
    }
    const buffer = Buffer.alloc(opened.size);
    let filled = 0;
    while (filled < buffer.length) {
      const read = fs.readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    return { text: buffer.toString('utf8', 0, filled) };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // A close that fails has nothing left to lose: the text is already read.
    }
  }
}

/** A parsed registry record as a RegistryEntry, or undefined with the reason logged. */
function entryFrom(
  value: unknown,
  pid: number,
  file: string,
  report: Log,
): RegistryEntry | undefined {
  const skip = (why: string): undefined => {
    report(`${LOG_PREFIX}skipped the session registry file ${file}, because ${why}`);
    return undefined;
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    const kind = value === null ? 'null' : Array.isArray(value) ? 'a list' : `a ${typeof value}`;
    return skip(`it holds ${kind} rather than an object`);
  }
  const record = value as Readonly<Record<string, unknown>>;
  if ('pid' in record && record.pid !== pid) {
    return skip(`it names pid ${quote(record.pid)} while its file name says ${pid}`);
  }
  if (!isFilledString(record.sessionId)) return skip('it names no session id');
  if (!isFilledString(record.cwd)) return skip('it names no working folder');
  const entry: Mutable<RegistryEntry> = { pid, sessionId: record.sessionId, cwd: record.cwd };
  if (isTime(record.startedAt)) entry.startedAt = record.startedAt;
  if (isFilledString(record.status)) entry.status = record.status;
  if (isFilledString(record.waitingFor)) entry.waitingFor = record.waitingFor;
  return Object.freeze(entry);
}

/**
 * What `<sessions>/<name>` holds, where `name` has already passed REGISTRY_NAME: its entry;
 * absent, quietly, when the file is gone (its session just ended); or failed, logged, for anything
 * else that stops it (a file that cannot be read, or one caught mid-rewrite and not yet an entry).
 */
function entryAt(sessions: string, name: string, report: Log): RegistryRead {
  const file = join(sessions, name);
  const stem = name.slice(0, -REGISTRY_EXTENSION.length);
  const pid = Number(stem);
  if (!isPid(pid) || String(pid) !== stem) {
    report(
      `${LOG_PREFIX}skipped the session registry file ${file}, because its name is not a ` +
        'process id written plainly, as Claude Code names each entry',
    );
    return FAILED;
  }
  let text: string;
  try {
    const read = readRegistryText(file);
    if ('refused' in read) {
      report(`${LOG_PREFIX}skipped the session registry file ${file}, because ${read.refused}`);
      return FAILED;
    }
    text = read.text;
  } catch (error) {
    if (isAbsent(error)) return ABSENT;
    failed(
      report,
      `read the session registry file ${file}`,
      error,
      'that session is not listed from it',
    );
    return FAILED;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    report(
      `${LOG_PREFIX}skipped the session registry file ${file}, because it is not valid JSON ` +
        `(${messageOf(error)})`,
    );
    return FAILED;
  }
  const entry = entryFrom(value, pid, file, report);
  return entry === undefined ? FAILED : Object.freeze({ kind: 'entry', entry });
}

/**
 * Every running session in `<configDir>/sessions/`, by pid ascending. Only names of digits and
 * `.json` are read, so the `.key` files beside them are never touched; an entry that is not valid
 * JSON, or names no session id or working folder, is skipped with a log line. No registry folder
 * at all answers none, quietly. Never throws.
 */
export function readRegistry(
  configDir: string,
  log: (line: string) => void,
): readonly RegistryEntry[] {
  const report = quiet(log);
  const none = 'no running session was read from it';
  try {
    if (refusedConfig(configDir, report)) return NO_ENTRIES;
    const sessions = join(configDir, SESSIONS_DIRNAME);
    let names: readonly string[];
    try {
      names = fs.readdirSync(sessions);
    } catch (error) {
      if (isAbsent(error)) return NO_ENTRIES;
      failed(report, `list the session registry at ${sessions}`, error, none);
      return NO_ENTRIES;
    }
    const entries: RegistryEntry[] = [];
    for (const name of names) {
      if (!REGISTRY_NAME.test(name)) continue;
      const read = entryAt(sessions, name, report);
      if (read.kind === 'entry') entries.push(read.entry);
    }
    entries.sort((a, b) => a.pid - b.pid);
    return Object.freeze(entries);
  } catch (error) {
    failed(report, `read the session registry under ${quote(configDir)}`, error, none);
    return NO_ENTRIES;
  }
}

/**
 * What the registry says of one pid, reading `<configDir>/sessions/<pid>.json` and no other file:
 * `entry`; `absent`, quietly, when there is no file for the pid (it is not a Claude Code session,
 * or it has ended); or `failed`, with a log line, when the file is there but cannot be read or is
 * not an entry (caught mid-rewrite, say), or the pid or config folder is refused before any path
 * is made (a pid is a positive whole number). The answer is frozen. Never throws.
 */
export function readRegistryEntry(
  configDir: string,
  pid: number,
  log: (line: string) => void,
): RegistryRead {
  const report = quiet(log);
  try {
    if (!isPid(pid)) {
      report(
        `${LOG_PREFIX}refused to read a registry entry for ${quote(pid)}, because a process id ` +
          'is a positive whole number, and anything else could name some other file',
      );
      return FAILED;
    }
    if (refusedConfig(configDir, report)) return FAILED;
    return entryAt(join(configDir, SESSIONS_DIRNAME), `${pid}${REGISTRY_EXTENSION}`, report);
  } catch (error) {
    failed(report, `read the registry entry for pid ${quote(pid)}`, error, 'it is not known');
    return FAILED;
  }
}

/**
 * The registry entry of one pid, or undefined both when there is none and when it could not be
 * read: readRegistryEntry, for a caller with nothing earlier to keep. Never throws.
 */
export function registryEntryFor(
  configDir: string,
  pid: number,
  log: (line: string) => void,
): RegistryEntry | undefined {
  const read = readRegistryEntry(configDir, pid, log);
  return read.kind === 'entry' ? read.entry : undefined;
}

/** Claude Code's own string hash (`(h << 5) - h + unit`, kept to 32 bits), for a long slug. */
function slugHash(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return hash;
}

/**
 * The name of a working folder's folder under `<config>/projects/`, as Claude Code makes it: every
 * character that is not an ASCII letter or digit becomes `-` (`/Users/x/my app` →
 * `-Users-x-my-app`). A slug over 200 characters is cut there and given `-<hash in base 36>`, as
 * Claude Code 2.1.278 does; where that differs, locateTranscript's scan still finds the file.
 * Anything but a string answers the empty slug. Never throws.
 */
export function projectSlug(cwd: string): string {
  if (typeof cwd !== 'string') return '';
  const slug = cwd.replace(NOT_SLUG, '-');
  if (slug.length <= SLUG_LIMIT) return slug;
  return `${slug.slice(0, SLUG_LIMIT)}-${Math.abs(slugHash(cwd)).toString(36)}`;
}

/** `path`'s stat when it is a file now; absent is a quiet no, any other failure a logged no. */
function statFile(path: string, report: Log): fs.Stats | undefined {
  try {
    const info = fs.statSync(path);
    return info.isFile() ? info : undefined;
  } catch (error) {
    if (!isAbsent(error)) failed(report, `look at ${path}`, error, 'it is passed over');
    return undefined;
  }
}

/**
 * `<projects>/<folder>/<file>` for every folder: the most recently written match, the first by
 * name on a tie, or undefined when no folder holds one.
 */
function scanProjects(projects: string, file: string, report: Log): string | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(projects);
  } catch (error) {
    if (!isAbsent(error)) {
      failed(report, `list the projects folder ${projects}`, error, 'no transcript was found in it');
    }
    return undefined;
  }
  let best: Readonly<{ path: string; mtimeMs: number }> | undefined;
  for (const name of names.sort()) {
    const candidate = join(projects, name, file);
    const info = statFile(candidate, report);
    if (info !== undefined && (best === undefined || info.mtimeMs > best.mtimeMs)) {
      best = { path: candidate, mtimeMs: info.mtimeMs };
    }
  }
  return best?.path;
}

/**
 * The path of a session's transcript: `<configDir>/projects/<projectSlug(cwd)>/<sessionId>.jsonl`
 * when that file exists, else the same file name found by scanning every folder under
 * `projects/` (the newest, if two folders hold one). No transcript yet, which is every session
 * before its first message, answers undefined quietly. A session id that is not hex digits and
 * dashes is refused with a log line before any path is made, so it can never walk out of the
 * projects folder. Never throws.
 */
export function locateTranscript(
  configDir: string,
  sessionId: string,
  cwd: string | undefined,
  log: (line: string) => void,
): string | undefined {
  const report = quiet(log);
  try {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
      report(
        `${LOG_PREFIX}refused to look for a transcript for session id ${quote(sessionId)}, ` +
          'because a session id is hex digits and dashes, and anything else could name a path ' +
          'outside the projects folder',
      );
      return undefined;
    }
    if (refusedConfig(configDir, report)) return undefined;
    const projects = join(configDir, PROJECTS_DIRNAME);
    const file = `${sessionId}${TRANSCRIPT_EXTENSION}`;
    if (isFilledString(cwd)) {
      const direct = join(projects, projectSlug(cwd), file);
      if (statFile(direct, report) !== undefined) return direct;
    }
    return scanProjects(projects, file, report);
  } catch (error) {
    failed(report, `look for the transcript of session ${quote(sessionId)}`, error, 'none is known');
    return undefined;
  }
}

/**
 * The transcripts a session's subagents wrote beside its own:
 * `<dir>/<sessionId>/subagents/*.jsonl` for a transcript at `<dir>/<sessionId>.jsonl`, sorted by
 * name. No subagents folder answers none, quietly. A path whose name is not a session id and
 * `.jsonl` is refused with a log line. Never throws.
 */
export function subagentTranscripts(
  transcriptPath: string,
  log?: (line: string) => void,
): readonly string[] {
  const report = quiet(log);
  try {
    const name = basename(transcriptPath);
    const sessionId = name.endsWith(TRANSCRIPT_EXTENSION)
      ? name.slice(0, -TRANSCRIPT_EXTENSION.length)
      : '';
    if (!SESSION_ID.test(sessionId)) {
      report(
        `${LOG_PREFIX}refused to look for subagent transcripts beside ${quote(transcriptPath)}, ` +
          'because its name is not a session id and .jsonl, as a transcript is named',
      );
      return NO_PATHS;
    }
    const folder = join(dirname(transcriptPath), sessionId, SUBAGENTS_DIRNAME);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch (error) {
      if (!isAbsent(error)) {
        failed(report, `list the subagents folder ${folder}`, error, 'no subagent transcript was read');
      }
      return NO_PATHS;
    }
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(TRANSCRIPT_EXTENSION))
      .map((entry) => entry.name)
      .sort();
    return Object.freeze(names.map((file) => join(folder, file)));
  } catch (error) {
    failed(report, `list the subagents beside ${quote(transcriptPath)}`, error, 'none were read');
    return NO_PATHS;
  }
}

/** A window size for readTail or readHead: a positive whole number of bytes. */
function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** A readFrom offset: a whole number of bytes, zero or more. */
function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // A close that fails has nothing left to lose: the bytes are already read.
  }
}

/**
 * Open `path`, check it is a plain file, and hand it to `body`; closed afterwards whatever
 * happens. No file there answers undefined quietly; a folder or a device is refused with a line.
 */
async function withFile<R>(
  path: string,
  report: Log,
  body: (file: Opened) => Promise<R | undefined>,
): Promise<R | undefined> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(path, READ_FLAGS);
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      report(
        `${LOG_PREFIX}did not read ${path}, because it is not a plain file (a folder or a ` +
          'device), and only a transcript file is read',
      );
      return undefined;
    }
    return await body({ handle, size: info.size, mtimeMs: info.mtimeMs });
  } finally {
    await closeQuietly(handle);
  }
}

/** `length` bytes from `position`, or fewer if the file ends first. Never more than asked. */
async function readRange(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}

/**
 * The complete lines in `buffer`: each ends at a newline, a carriage return before it stripped,
 * blank ones left out, bytes after the last newline left out. When `atLineStart` is false the
 * buffer may open mid-line, so everything through its first newline is dropped (a buffer that
 * opens right after a newline loses only that newline), and a buffer with no newline at all
 * answers undefined: no line in it is known to be whole.
 */
function completeLines(buffer: Buffer, atLineStart: boolean): Split | undefined {
  let cursor = 0;
  if (!atLineStart) {
    const first = buffer.indexOf(NEWLINE);
    if (first < 0) return undefined;
    cursor = first + 1;
  }
  const lines: string[] = [];
  let newline = buffer.indexOf(NEWLINE, cursor);
  while (newline >= 0) {
    const crlf = newline > cursor && buffer[newline - 1] === CARRIAGE_RETURN;
    const stop = crlf ? newline - 1 : newline;
    if (stop > cursor) lines.push(buffer.toString('utf8', cursor, stop));
    cursor = newline + 1;
    newline = buffer.indexOf(NEWLINE, cursor);
  }
  return { lines, end: cursor };
}

function chunkOf(lines: readonly string[], size: number, mtimeMs: number): Chunk {
  return Object.freeze({ lines: Object.freeze([...lines]), size, mtimeMs });
}

/**
 * The complete lines inside the last `bytes` of a file, with its size and modification time. A
 * partial first line is dropped unless the window reached the file's start; a line that starts
 * exactly where the window does is whole, and kept (one byte before the window is read to tell).
 * A trailing line with no newline yet is left out. Reads at most `bytes + 1` bytes, at an offset.
 * No file answers undefined quietly; anything else that stops it is logged. Never rejects.
 */
export async function readTail(
  path: string,
  bytes: number,
  log?: (line: string) => void,
): Promise<Chunk | undefined> {
  const report = quiet(log);
  try {
    if (!isByteCount(bytes)) {
      report(
        `${LOG_PREFIX}refused to read the last ${quote(bytes)} bytes of ${quote(path)}, ` +
          'because a window is a positive whole number of bytes',
      );
      return undefined;
    }
    return await withFile(path, report, async ({ handle, size, mtimeMs }) => {
      const start = Math.max(0, size - bytes);
      const from = start === 0 ? 0 : start - 1;
      const buffer = await readRange(handle, from, size - from);
      return chunkOf(completeLines(buffer, start === 0)?.lines ?? NO_LINES, size, mtimeMs);
    });
  } catch (error) {
    failed(report, `read the end of ${quote(path)}`, error, 'nothing was read from it');
    return undefined;
  }
}

/**
 * The complete lines inside the first `bytes` of a file, with its size and modification time. A
 * line cut by the window's end, or with no newline yet, is left out. Reads at most `bytes` bytes.
 * No file answers undefined quietly; anything else that stops it is logged. Never rejects.
 */
export async function readHead(
  path: string,
  bytes: number,
  log?: (line: string) => void,
): Promise<Chunk | undefined> {
  const report = quiet(log);
  try {
    if (!isByteCount(bytes)) {
      report(
        `${LOG_PREFIX}refused to read the first ${quote(bytes)} bytes of ${quote(path)}, ` +
          'because a window is a positive whole number of bytes',
      );
      return undefined;
    }
    return await withFile(path, report, async ({ handle, size, mtimeMs }) => {
      const buffer = await readRange(handle, 0, Math.min(bytes, size));
      return chunkOf(completeLines(buffer, true)?.lines ?? NO_LINES, size, mtimeMs);
    });
  } catch (error) {
    failed(report, `read the start of ${quote(path)}`, error, 'nothing was read from it');
    return undefined;
  }
}

/**
 * The bytes a readFrom window splits, from `from` (`offset`, or the byte before it) to `end`. When
 * no newline at or after `offset` lies inside them, one line runs past the window, so the read
 * goes on, `step` bytes at a time, until a newline arrives or the file's `size` at its opening is
 * reached: a line is answered whole or not at all, and that one line may exceed the window.
 */
async function lineWindow(
  handle: FileHandle,
  from: number,
  offset: number,
  end: number,
  size: number,
  step: number,
): Promise<Buffer> {
  const first = await readRange(handle, from, end - from);
  const ended = first.length < end - from || end >= size;
  if (ended || first.includes(NEWLINE, offset - from)) return first;
  const parts = [first];
  let reached = end;
  while (reached < size) {
    const part = await readRange(handle, reached, Math.min(step, size - reached));
    if (part.length === 0) break;
    parts.push(part);
    reached += part.length;
    if (part.includes(NEWLINE)) break;
  }
  return Buffer.concat(parts);
}

/**
 * The complete lines appended since `offset`, at most `maxBytes` of them a call, and `next`: the
 * offset to hand the following call, just past the last complete line answered. A caller wanting
 * everything up to some size calls again from `next` until it gets there, and a trailing line with
 * no newline yet is read again, whole, once it has one. `offset` is a previous `next`, or 0.
 * Reads the byte before `offset` (to tell whether a line starts there) and at most `maxBytes`
 * from `offset`, never past the file's size when it is opened; only a single line longer than
 * `maxBytes` is read past the window, on to its end. An offset that lands inside a line (the file
 * was rewritten) drops that partial line; a file now shorter than `offset` answers undefined with
 * a log line, because it is no longer the file that offset was a position in. No file answers
 * undefined quietly; a `maxBytes` that is not a positive whole number is refused. Never rejects.
 */
export async function readFrom(
  path: string,
  offset: number,
  log?: (line: string) => void,
  maxBytes: number = READ_FROM_MAX_BYTES,
): Promise<Readonly<{ lines: readonly string[]; next: number }> | undefined> {
  const report = quiet(log);
  try {
    if (!isOffset(offset)) {
      report(
        `${LOG_PREFIX}refused to read ${quote(path)} from offset ${quote(offset)}, because an ` +
          'offset is a whole number of bytes, zero or more',
      );
      return undefined;
    }
    if (!isByteCount(maxBytes)) {
      report(
        `${LOG_PREFIX}refused to read ${quote(path)} ${quote(maxBytes)} bytes at a time, ` +
          'because a window is a positive whole number of bytes',
      );
      return undefined;
    }
    return await withFile(path, report, async ({ handle, size }) => {
      if (offset > size) {
        report(
          `${LOG_PREFIX}did not read ${path} from offset ${offset}, because it is now ${size} ` +
            'bytes, so it was cut or rewritten since that offset was handed out',
        );
        return undefined;
      }
      if (offset === size) return Object.freeze({ lines: NO_LINES, next: offset });
      const from = offset === 0 ? 0 : offset - 1;
      const end = Math.min(size, offset + maxBytes);
      const buffer = await lineWindow(handle, from, offset, end, size, maxBytes);
      const split = completeLines(buffer, offset === 0);
      if (split === undefined) return Object.freeze({ lines: NO_LINES, next: offset });
      return Object.freeze({ lines: Object.freeze(split.lines), next: from + split.end });
    });
  } catch (error) {
    const what = `read ${quote(path)} from offset ${quote(offset)}`;
    failed(report, what, error, 'nothing was read from it');
    return undefined;
  }
}

/** An error's message on one line: execFile's carries the command and `ps`'s stderr after it. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** How a `ps` run failed, in words: its error code, the timeout that stopped it, or its status. */
function endedAs(error: ExecFileException): string {
  try {
    const { code, signal, killed } = error;
    if (typeof code === 'string' && code !== '') return code;
    if (killed === true) return `stopped after ${PROCESS_COMMAND_TIMEOUT_MS} ms`;
    if (typeof signal === 'string') return `ended by ${signal}`;
    if (typeof code === 'number') return `exit status ${code}`;
  } catch {
    // A hostile error object still gets reported, as having no code.
  }
  return 'no error code';
}

/**
 * What `ps` said about one pid: its command line, trimmed; undefined, quietly, when it found no
 * process for the pid (exit status 1 with nothing printed) or printed nothing; undefined, with a
 * line, for any other failure. Never throws: it runs inside execFile's callback.
 */
function commandFrom(
  pid: number,
  error: ExecFileException | null,
  stdout: unknown,
  report: Log,
): string | undefined {
  const unknown = 'its launch model and effort are not known';
  try {
    const text = typeof stdout === 'string' ? stdout.trim() : '';
    if (error === null || error === undefined) return text === '' ? undefined : text;
    if (error.code === PS_NO_SUCH_PROCESS && text === '') return undefined;
    report(
      `${LOG_PREFIX}could not read the command line of pid ${pid} with ps ` +
        `(${endedAs(error)}): ${oneLine(messageOf(error))}, so ${unknown}`,
    );
    return undefined;
  } catch (error) {
    failed(report, `read what ps said about pid ${pid}`, error, unknown);
    return undefined;
  }
}

/**
 * The command line a running process was started with, as `ps -ww -o command= -p <pid>` prints
 * it, trimmed: how the details store learns a claude's `--model` and `--effort` before its
 * transcript names them (F8). Undefined, quietly, for a pid with no process, and on Windows,
 * where nothing is started (`platform` defaults to this process's, and is injectable for the
 * tests). Undefined, with a line, for a pid that is not a positive whole number (refused before
 * anything runs) and for a `ps` that fails, cannot be found, or runs past
 * PROCESS_COMMAND_TIMEOUT_MS. No shell is involved. Never rejects.
 */
export async function processCommand(
  pid: number,
  log: (line: string) => void,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const report = quiet(log);
  const unknown = 'its launch model and effort are not known';
  try {
    if (!isPid(pid)) {
      report(
        `${LOG_PREFIX}refused to read the command line of ${quote(pid)}, because a process id ` +
          'is a positive whole number, and nothing else is handed to ps',
      );
      return undefined;
    }
    if (platform === 'win32') return undefined;
    return await new Promise<string | undefined>((settle) => {
      try {
        execFile(
          PS_FILE,
          [...PS_COMMAND_ARGS, String(pid)],
          {
            encoding: 'utf8',
            timeout: PROCESS_COMMAND_TIMEOUT_MS,
            maxBuffer: PROCESS_COMMAND_MAX_BUFFER,
            windowsHide: true,
          },
          (error, stdout) => settle(commandFrom(pid, error, stdout, report)),
        );
      } catch (error) {
        failed(report, `start ps for the command line of pid ${pid}`, error, unknown);
        settle(undefined);
      }
    });
  } catch (error) {
    failed(report, `read the command line of pid ${quote(pid)}`, error, unknown);
    return undefined;
  }
}
