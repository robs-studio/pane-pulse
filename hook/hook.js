'use strict';

// pane-pulse hook — the synchronous half of the feature.
//
// Claude Code runs this once per registered hook event, hands it the event payload on stdin,
// and reads one JSON object back on stdout. Two things happen here and nothing else:
//
//   1. the member's terminal tab gets its mark, by printing {"terminalSequence":"<bytes>"};
//   2. the VS Code extension gets one small JSON event file, so the pane list can follow along.
//
// Five rules this file is built around, each load-bearing:
//
//   * FULLY SYNCHRONOUS. A hook returning `terminalSequence` is only honoured on the
//     synchronous path; the deferred path delivers `additionalContext` and `systemMessage`
//     alone. So: no deferred work of any kind, no timers, no thenables. Plain CommonJS.
//   * ZERO DEPENDENCIES, and never an import of src/decision.ts. hook.js and decision.ts are
//     two independent readers of one file, hook/decision-table.json, which is the contract
//     between them. tests/drift.test.mjs proves they still agree.
//   * THE NORMALISATION BLOCK IS PART OF THE CONTRACT. The rows are not total on their own —
//     a Stop whose payload carries no background_tasks matches no bg row until
//     `absent_reads_as` is applied. Apply the block and every input matches exactly one row.
//   * EXIT 0 ALWAYS, AND NEVER PRINT ON ANY ERROR. A hook that throws must not garble the
//     member's terminal, and a mark we cannot record is a mark the extension could never
//     clear, so silence is the better failure. Everything below runs inside one try.
//   * MUTED MEANS NO SEQUENCE BUT CLEAR. A pane is muted when PANE_PULSE_IGNORE is set in its
//     environment or a marker sits at <root>/mute/<claude_pid>. Then every mark is suppressed
//     and only a clear, which draws nothing, still goes out; the event file lands as always,
//     its `sequence` naming what actually reached the tab and its `muted` naming why. The
//     marker is only ever stat'ed, never opened, so a FIFO there cannot hang a pane. The one
//     write this file makes outside its event file is here: a main-thread SessionStart with
//     source `startup` deletes its own pid's marker before reading it. A process that has only
//     just started cannot have been muted yet (the extension writes a marker only after it has
//     seen the pid's first event, which is this one), so a marker already there was left on a
//     reused pid and is stale by definition. Never on any other source or event: a resume, a
//     clear, a compact or a fork can be the same live process, whose marker is legitimate.
//
// The hook never decides whether the member was looking at a pane. It reads no focus of any
// kind, spawns nothing and walks no process tree: it always sets the mark unless the pane is
// muted, and the extension owns every clear.

/*
 * CommonJS on purpose, so the rule below is disabled for these three lines alone: Claude Code
 * runs this file as a bare `node hook.js`, with no bundler and no dependencies, and
 * hook/package.json classifies this folder commonjs so it parses that way.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
/* eslint-enable @typescript-eslint/no-require-imports */

/** The contract, resolved from beside this file — never from the workspace root. */
const TABLE_FILENAME = 'decision-table.json';

const EVENTS_DIRNAME = 'events';

/** `<root>/mute/<claude_pid>`: a pane's skip marker, the extension's to write, stat'ed here. */
const MUTE_DIRNAME = 'mute';

/** Any value but empty or exactly `0` mutes, compared untrimmed, as the shell one-liner does. */
const IGNORE_ENV = 'PANE_PULSE_IGNORE';

/** The one SessionStart source that is always a brand-new process. */
const STARTUP_SOURCE = 'startup';

/** A half-written file must never be globbed as `*.json`, so it is born with this suffix. */
const TMP_SUFFIX = '.tmp';

/** Two events in one millisecond for one pid get different counters; 1000 is far past real. */
const MAX_COUNTER = 1000;

/** A bounded retry for a non-blocking stdin. Bounded, because a hook must never hang a pane. */
const MAX_STDIN_SPINS = 10000;

/**
 * The event-file shape, declared as data so the other writer can be checked against it.
 *
 * `session_id` and `bg` are OPTIONAL on purpose. scripts/install-hooks.mjs registers
 * PostToolUse in a shell shape, because it fires once per tool call and a node spawn per call
 * would cost about a second a turn; that one-liner's subagent guard consumes stdin, so it can
 * emit an event from the environment alone and has neither field to give. Their absence is a
 * valid event, never a malformed one, and src/events.ts must read it as such.
 *
 * `muted` is OPTIONAL for a different reason: it is there only when the pane is muted, as
 * `env` or `marker` (env wins when both hold), and absent is the normal, unmuted case. A muted
 * event still carries its row's `state`, so the pane list keeps following the pane, while its
 * `sequence` is what reached the tab: null for a suppressed mark, `clear` when a clear went out.
 */
const EVENT_SCHEMA = Object.freeze({
  required: Object.freeze([
    'ts',
    'event',
    'matcher',
    'notification_type',
    'claude_pid',
    'cwd',
    'state',
    'sequence',
  ]),
  optional: Object.freeze(['session_id', 'bg', 'muted']),
});

/** `<root>` — the member's pane-pulse directory. The env override is what the tests point away. */
function resolveRoot(env, home) {
  const configured = env.PANE_PULSE_HOME;
  if (typeof configured === 'string' && configured !== '') return configured;
  return path.join(home, '.pane-pulse');
}

/**
 * CLAUDE_PID is set from Claude Code v2.1.214. Older builds do not set it, so fall back to the
 * parent pid, which for a hook is the claude process itself. Digits only: this value becomes
 * part of a filename on three operating systems.
 */
function resolveClaudePid(env, parentPid) {
  const declared = typeof env.CLAUDE_PID === 'string' ? env.CLAUDE_PID.trim() : '';
  if (/^[0-9]+$/.test(declared)) {
    const value = Number(declared);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return parentPid;
}

/**
 * Whether the pane's own environment asks for silence. No trim, on purpose: the shell one-liner
 * tests `[ "${PANE_PULSE_IGNORE:-0}" != 0 ]`, which cannot trim, and two readers of one variable
 * must agree on every value, so ` 0 ` mutes here exactly as it does there.
 */
function ignoredByEnv(env) {
  const value = env[IGNORE_ENV];
  return typeof value === 'string' && value !== '' && value !== '0';
}

/** Where the extension leaves a pane's skip marker. The digits-only pid keeps it a plain name. */
function markerPath(root, claudePid) {
  return path.join(root, MUTE_DIRNAME, String(claudePid));
}

/**
 * Why this pane is muted, or null when it is not. The marker is asked for by existsSync alone,
 * a stat, and never opened: a FIFO or a device in its place must not hang the hook. existsSync
 * answers false rather than throwing, so a root with no mute/ folder, or one where mute is a
 * plain file, reads as not muted.
 */
function muteReason(env, root, claudePid) {
  if (ignoredByEnv(env)) return 'env';
  if (fs.existsSync(markerPath(root, claudePid))) return 'marker';
  return null;
}

function readTable(tablePath) {
  return JSON.parse(fs.readFileSync(tablePath, 'utf8'));
}

/**
 * Read one payload into the three dimensions a row compares against, obeying the table's own
 * `normalisation` block. A table with no block can only be taken literally, which is the state
 * the block exists to prevent; the literal reading is returned so such an input falls through
 * to no row rather than to the wrong one.
 */
function normalise(table, event, payload) {
  const rules = table.normalisation;
  if (rules === undefined) {
    const field = table.subject_fields === undefined ? undefined : table.subject_fields[event];
    const bgRaw = payload.background_tasks;
    const agentRaw = payload.agent_id;
    const subjectRaw = field === undefined ? undefined : payload[field];
    return {
      backgroundCount: Array.isArray(bgRaw) ? bgRaw.length : undefined,
      agent: typeof agentRaw === 'string' && agentRaw !== '' ? 'present' : 'absent',
      subject: typeof subjectRaw === 'string' ? subjectRaw : null,
    };
  }

  const bgRaw = payload[rules.bg.payload_field];
  let backgroundCount;
  if (bgRaw === undefined || bgRaw === null) backgroundCount = rules.bg.absent_reads_as;
  else if (rules.bg.derive === 'array_length' && Array.isArray(bgRaw)) backgroundCount = bgRaw.length;
  else backgroundCount = rules.bg.non_numeric_reads_as;

  const agentRaw = payload[rules.agent_id.payload_field];
  let agent;
  if (agentRaw === undefined || agentRaw === null) agent = rules.agent_id.absent_reads_as;
  else if (typeof agentRaw !== 'string') agent = rules.agent_id.non_string_reads_as;
  else if (agentRaw === '') agent = rules.agent_id.empty_string_reads_as;
  else agent = 'present';

  const subjectField = table[rules.subject.payload_field_by_event][event];
  const subjectRaw = subjectField === undefined ? undefined : payload[subjectField];
  let subject;
  if (subjectRaw === undefined || subjectRaw === null) subject = rules.subject.absent_reads_as;
  else if (typeof subjectRaw !== 'string') subject = rules.subject.non_string_reads_as;
  else subject = subjectRaw;

  return { backgroundCount, agent, subject };
}

/**
 * One row against one normalised reading. A matcher is a '|'-separated list of exact, whole
 * alternatives — the documented exact-match matcher path — never a prefix and never a regexp.
 */
function rowMatches(row, event, reading) {
  if (row.event !== event) return false;
  if (row.agent_id !== 'any' && row.agent_id !== reading.agent) return false;
  if (row.bg === '0' && !(reading.backgroundCount <= 0)) return false;
  if (row.bg === '>0' && !(reading.backgroundCount > 0)) return false;
  if (row.matcher !== undefined) {
    const hit =
      typeof reading.subject === 'string' && row.matcher.split('|').includes(reading.subject);
    if (row.matcher_mode === 'not-in' ? hit : !hit) return false;
  }
  return true;
}

/** The regions are disjoint and total, so the first match is the match. */
function findRow(table, event, reading) {
  if (!Array.isArray(table.rows)) return undefined;
  return table.rows.find((row) => rowMatches(row, event, reading));
}

/** The record the extension reads. Key order mirrors EVENT_SCHEMA for a readable file. */
function buildEvent(context) {
  const { ts, event, row, payload, reading, claudePid, cwd, state, sequence, muted } = context;
  const record = {
    ts,
    event,
    matcher: typeof row.matcher === 'string' ? row.matcher : null,
    notification_type:
      typeof payload.notification_type === 'string' ? payload.notification_type : null,
  };
  if (typeof payload.session_id === 'string' && payload.session_id !== '') {
    record.session_id = payload.session_id;
  }
  record.claude_pid = claudePid;
  record.cwd = cwd;
  record.state = state;
  record.sequence = sequence;
  const bg = reading === undefined || reading === null ? undefined : reading.backgroundCount;
  if (typeof bg === 'number' && Number.isFinite(bg)) record.bg = bg;
  if (typeof muted === 'string') record.muted = muted;
  return record;
}

/**
 * `<root>/events/<epoch_ms>-<claude_pid>-<counter>.json`, written temp-then-renamed.
 *
 * Epoch milliseconds, never an ISO stamp: a colon is illegal in a Windows filename. The
 * counter breaks ties inside one millisecond and is claimed with an exclusive create, so two
 * hooks racing in the same millisecond take different counters rather than one overwriting the
 * other. The rename is what makes the file appear whole: the extension globs `*.json`, and a
 * `.tmp` suffix is never in that set.
 *
 * `io` is injected so a test can watch the order; production gets the node:fs singleton.
 */
function writeEventFile(root, record, io) {
  const nodeFs = io === undefined ? fs : io;
  const dir = path.join(root, EVENTS_DIRNAME);
  nodeFs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(record);

  for (let counter = 0; counter < MAX_COUNTER; counter += 1) {
    const finalPath = path.join(dir, `${record.ts}-${record.claude_pid}-${counter}.json`);
    if (nodeFs.existsSync(finalPath)) continue;
    const tmpPath = finalPath + TMP_SUFFIX;
    let fd;
    try {
      fd = nodeFs.openSync(tmpPath, 'wx', 0o600);
    } catch (error) {
      if (error !== null && error !== undefined && error.code === 'EEXIST') continue;
      throw error;
    }
    try {
      nodeFs.writeFileSync(fd, body);
    } finally {
      nodeFs.closeSync(fd);
    }
    nodeFs.renameSync(tmpPath, finalPath);
    return finalPath;
  }
  throw new Error(`pane-pulse hook: no free event filename for ${record.ts}-${record.claude_pid}`);
}

/**
 * stdin, read whole and in one go. A pipe answers the first call; a non-blocking stdin answers
 * EAGAIN, and only then does the bounded loop below run.
 */
function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (error) {
    const code = error === null || error === undefined ? '' : error.code;
    if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') return '';
  }

  const chunks = [];
  const buffer = Buffer.alloc(65536);
  let spins = 0;
  for (;;) {
    let read;
    try {
      read = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      const code = error === null || error === undefined ? '' : error.code;
      if ((code === 'EAGAIN' || code === 'EWOULDBLOCK') && spins < MAX_STDIN_SPINS) {
        spins += 1;
        continue;
      }
      break;
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
    spins = 0;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** fd 1, written for real rather than queued: nothing here may outlive the call that made it. */
function writeStdout(text) {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  let spins = 0;
  while (offset < buffer.length) {
    let written;
    try {
      written = fs.writeSync(1, buffer, offset, buffer.length - offset);
    } catch (error) {
      const code = error === null || error === undefined ? '' : error.code;
      if ((code === 'EAGAIN' || code === 'EWOULDBLOCK') && spins < MAX_STDIN_SPINS) {
        spins += 1;
        continue;
      }
      throw error;
    }
    offset += written;
    spins = 0;
  }
}

/** The event name the payload carries. `hook_event_name` is the documented field. */
function eventNameOf(payload) {
  if (typeof payload.hook_event_name === 'string' && payload.hook_event_name !== '') {
    return payload.hook_event_name;
  }
  if (typeof payload.event === 'string' && payload.event !== '') return payload.event;
  return '';
}

function main() {
  try {
    const text = readStdin();
    if (text.trim() === '') return;

    const payload = JSON.parse(text);
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return;

    const event = eventNameOf(payload);
    if (event === '') return;

    const table = readTable(path.join(__dirname, TABLE_FILENAME));
    const reading = normalise(table, event, payload);
    const row = findRow(table, event, reading);
    // An event the table does not name resolves to nothing, never to a fallthrough row.
    if (row === undefined) return;

    const root = resolveRoot(process.env, os.homedir());
    const claudePid = resolveClaudePid(process.env, process.ppid);

    // The one write outside the event file (rule five), and it comes before the read, so a
    // stale marker never mutes the very startup that removes it. Only the main thread's startup:
    // anything inside a subagent call is by definition a process that is already running.
    const startup =
      event === 'SessionStart' && payload.source === STARTUP_SOURCE && reading.agent === 'absent';
    if (startup) {
      try {
        fs.unlinkSync(markerPath(root, claudePid));
      } catch {
        // No marker is the normal case; any other failure leaves it to be read as it stands.
      }
    }
    const muted = muteReason(process.env, root, claudePid);

    const state = row.state;
    const sequence = typeof row.sequence === 'string' ? row.sequence : null;
    // What reaches the tab. A clear draws nothing, so it is the one sequence a muted pane keeps.
    const printed = muted === null || sequence === 'clear' ? sequence : null;

    writeEventFile(
      root,
      buildEvent({
        ts: Date.now(),
        event,
        row,
        payload,
        reading,
        claudePid,
        cwd: typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : process.cwd(),
        state,
        sequence: printed,
        muted,
      }),
    );

    // A no-op row, or a muted mark, prints nothing at all: an empty stdout is how a hook says
    // "no change".
    if (printed === null) return;
    const sequences = table.sequences;
    const bytes =
      sequences === null || typeof sequences !== 'object' ? undefined : sequences[printed];
    if (typeof bytes !== 'string' || bytes === '') return;

    writeStdout(`${JSON.stringify({ terminalSequence: bytes })}\n`);
  } catch {
    // Silence is the contract. Nothing printed, nothing thrown, and the exit code below stands.
  }
  process.exitCode = 0;
}

module.exports = {
  EVENT_SCHEMA,
  MUTE_DIRNAME,
  buildEvent,
  findRow,
  ignoredByEnv,
  main,
  markerPath,
  muteReason,
  normalise,
  readTable,
  resolveClaudePid,
  resolveRoot,
  rowMatches,
  writeEventFile,
};

if (require.main === module) main();
