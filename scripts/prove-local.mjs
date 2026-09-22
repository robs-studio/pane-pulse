#!/usr/bin/env node
// Check that pane-pulse's install is in place, by reading alone: the install checker.
//
// Four things make an install real, and each is checked against the files themselves, never
// against what the install record claims. The record is exactly what goes stale: Glitch's /look
// restore rewrites both settings files and quietly takes the hooks out while the record still
// says installed. So the record is one of the things checked, never the evidence.
//
//   1 hooks        every registration in the DEPLOYED table (<root>/decision-table.json, the one
//                  the hook really reads) has exactly one pane-pulse entry in Claude Code's
//                  settings, under its event and matcher, in the shape the installer writes for
//                  this platform, pointing at <root>; no pane-pulse entry sits anywhere the
//                  table does not register; no hand-installed indicator entry is left beside them.
//   2 synchronous  none of those entries is async: a terminalSequence is honoured only from a
//                  synchronous hook.
//   3 settings     VS Code's tab description carries ${progress} exactly once, and Claude Code's
//                  own terminalProgressBarEnabled is false.
//   4 deployed     <root>/hook.js and its table match the hook source the install record names,
//                  by sha256, and the record itself is there and parses.
//
// READ-ONLY BY CONSTRUCTION. From node:fs this file imports existsSync and readFileSync and
// nothing else, and from the installer only functions that answer a question: where the files
// are, what an entry must look like, which entries are indicators. tests/prove-local.test.mjs
// scans this source for any call that writes, renames, removes, creates or copies, and runs it
// over a lab whose every file and folder must come out byte- and mtime-identical.
//
// NEVER A SECOND INSTALLER. What an entry must look like is src/installer.ts's buildEntry and
// shapeToWrite, which entries are indicators is its isIndicatorEntry, which shape an entry is in
// is its shapeOfEntry, where the files are is its resolveLocations, and the registrations come
// from decision.ts's own loader, so no event, count, shape or entry is restated below. The three
// setting names are the one exception: the installer keeps its copies private, and the test
// holds these to the install record, which carries the installer's.
//
// Nothing here quotes the member's settings back at them: a reason names the event, the file
// and what was found, never the text of a hook they wrote.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse as parseJsonc } from 'jsonc-parser';

import { loadDecisionTable, registrationKey } from '../src/decision.ts';
import {
  buildEntry,
  hasInstallRecord,
  isIndicatorEntry,
  nodeCommand,
  readRecord,
  recordPathFor,
  resolveLocations,
  shapeOfEntry,
  shapeToWrite,
  shellCommand,
  tablePathIn,
} from '../src/installer.ts';

/** This repo's hook/: compared against only when there is no install record to name a source. */
const HOOK_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'hook');

/** Claude Code's own key, in its settings.json. */
export const PROGRESS_KEY = 'terminalProgressBarEnabled';

/** VS Code's key, in its user settings.json, and the token that gives a tab its mark. */
export const DESCRIPTION_KEY = 'terminal.integrated.tabs.description';
export const PROGRESS_TOKEN = '${progress}';

/** A root that exists nowhere, used only to ask the installer what its entries look like. */
const PROBE_ROOT = join(sep, 'pane-pulse-probe-root');

/** The deployed files' names, as the installer names them. */
const HOOK_BASENAME = basename(nodeCommand(PROBE_ROOT).args[0]);
const TABLE_BASENAME = basename(tablePathIn(PROBE_ROOT));

/**
 * pane-pulse's shell one-liner, split around the one place its root appears. An entry that
 * opens with the head and closes with the tail is pane-pulse's own, whatever root it was
 * written for; the one equal to shellCommand(<root>) is this root's. Split from the installer's
 * own text, and refused at load if the root stops appearing exactly once.
 */
const SHELL_PROBE = shellCommand(PROBE_ROOT);
const SHELL_AT = SHELL_PROBE.indexOf(PROBE_ROOT);
if (SHELL_AT === -1 || SHELL_PROBE.indexOf(PROBE_ROOT, SHELL_AT + 1) !== -1) {
  throw new Error(
    "pane-pulse prove-local: the installer's shell entry no longer carries its root exactly once, " +
      'so its entries cannot be recognised',
  );
}
const SHELL_HEAD = SHELL_PROBE.slice(0, SHELL_AT);
const SHELL_TAIL = SHELL_PROBE.slice(SHELL_AT + PROBE_ROOT.length);

const USAGE = `pane-pulse prove-local

  node scripts/prove-local.mjs --check-only

  --check-only  read the installed state and check it. This is the only mode there is so
                far, and it writes nothing, anywhere.
  --help        this

  Four checks, each printed as ok or FAIL with the reason, then a one-line verdict:
    1 hooks        every registration in <root>/decision-table.json has exactly one
                   pane-pulse hook in Claude Code's settings, in the shape the table declares
                   for this platform, pointing at <root>; none anywhere the table does not
                   register; no hand-installed indicator hook left beside them
    2 synchronous  none of those hooks is async
    3 settings     VS Code's terminal.integrated.tabs.description contains \${progress}
                   exactly once, and Claude Code's terminalProgressBarEnabled is false
    4 deployed     <root>/hook.js and <root>/decision-table.json match the hook source by
                   sha256, and <root>/install-record.json is there and parses

  Exit 0 when every check holds, 1 when any fails, 2 on a usage error.

  PANE_PULSE_HOME              <root> (default ~/.pane-pulse)
  PANE_PULSE_CLAUDE_SETTINGS   Claude Code's settings.json
  PANE_PULSE_VSCODE_SETTINGS   VS Code's user settings.json
`;

// ---------------------------------------------------------------------------- small helpers

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Order-sensitive on purpose: it is the installer's own test of "the same entry", so an entry
 * this calls equal is one an uninstall will recognise and take back out.
 */
function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function short(sha) {
  return sha.slice(0, 12);
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function unique(items) {
  return [...new Set(items)];
}

/** `a`, `a and b`, `a, b and c`. */
function inWords(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A value for a reason line: short, and never more than a glance of it. */
function glance(value) {
  if (value === undefined) return 'absent';
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** How a registration is named in a reason: its event, and its matcher when it has one. */
function labelOf(registration) {
  return registration.matcher === undefined
    ? registration.event
    : `${registration.event} (matcher ${registration.matcher})`;
}

/** An entry with any `async` flag taken off: check 2 judges that, so check 1 must not. */
function withoutAsync(entry) {
  const { async: _async, ...rest } = entry;
  return rest;
}

// ---------------------------------------------------------------------------- reading

/** A settings file, read as the installer reads it: JSON with comments and trailing commas. */
function readSettings(file) {
  if (!existsSync(file)) return { ok: false, why: `not found at ${file}` };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, why: `at ${file} cannot be read (${error.message})` };
  }
  if (text.trim() === '') return { ok: true, data: {} };
  const problems = [];
  const data = parseJsonc(text, problems, { allowTrailingComma: true });
  if (problems.length > 0) {
    return {
      ok: false,
      why: `at ${file} do not parse as JSON with comments (${plural(problems.length, 'problem', 'problems')}, the first at offset ${problems[0].offset})`,
    };
  }
  if (!isObject(data)) return { ok: false, why: `at ${file} do not hold a JSON object` };
  return { ok: true, data };
}

/**
 * pane-pulse's own entry, for this root or any other: the node exec form running a file named
 * hook.js (the installer's own test, asked of the args alone), or the shell one-liner.
 */
function isPanePulseEntry(entry) {
  if (!isObject(entry)) return false;
  if (Array.isArray(entry.args)) return isIndicatorEntry({ args: entry.args });
  return (
    typeof entry.command === 'string' &&
    entry.command.length >= SHELL_HEAD.length + SHELL_TAIL.length &&
    entry.command.startsWith(SHELL_HEAD) &&
    entry.command.endsWith(SHELL_TAIL)
  );
}

/** Every indicator entry in Claude Code's settings: pane-pulse's, and anyone else's. */
function scanHooks(data) {
  const ours = [];
  const handInstalled = [];
  const problems = [];
  if (!hasOwn(data, 'hooks')) return { ours, handInstalled, problems };
  if (!isObject(data.hooks)) {
    problems.push('"hooks" in Claude Code settings is not an object');
    return { ours, handInstalled, problems };
  }
  for (const [event, groups] of Object.entries(data.hooks)) {
    if (!Array.isArray(groups)) {
      problems.push(`hooks.${event} in Claude Code settings is not a list of groups`);
      continue;
    }
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      const key = registrationKey(event, group.matcher);
      for (const entry of group.hooks) {
        if (isPanePulseEntry(entry)) ours.push({ event, key, entry });
        else if (isIndicatorEntry(entry)) handInstalled.push({ event, key });
      }
    }
  }
  return { ours, handInstalled, problems };
}

/** The deployed table, or the repo's when the deployed one cannot be had, with why. */
function loadTable(root, repoHookDir) {
  const deployed = tablePathIn(root);
  let why;
  if (!existsSync(deployed)) {
    why = `the deployed table ${deployed} is missing`;
  } else {
    try {
      return { table: loadDecisionTable(deployed), path: deployed, notes: [] };
    } catch (error) {
      why = `the deployed table ${deployed} does not load (${error.message})`;
    }
  }
  const fallback = tablePathIn(repoHookDir);
  try {
    return {
      table: loadDecisionTable(fallback),
      path: fallback,
      notes: [`${why}, so the hooks were checked against the repo's ${fallback} instead`],
    };
  } catch (error) {
    return { table: null, path: fallback, notes: [`${why}, and the repo's ${fallback} does not load either (${error.message})`] };
  }
}

function loadRecord(root) {
  if (!hasInstallRecord(root)) return { present: false, record: null, problem: null };
  try {
    return { present: true, record: readRecord(root), problem: null };
  } catch (error) {
    return { present: true, record: null, problem: error.message.replace(/^pane-pulse install: /, '') };
  }
}

/** Everything the four checks judge, read once. */
function gather(locations, repoHookDir) {
  const claude = readSettings(locations.claudeSettings);
  const scan = claude.ok ? scanHooks(claude.data) : { ours: [], handInstalled: [], problems: [] };
  const table = loadTable(locations.root, repoHookDir);
  const registered = new Map();
  for (const registration of table.table?.registrations ?? []) {
    registered.set(registrationKey(registration.event, registration.matcher), registration);
  }
  const missing = [...registered.keys()].filter((key) => !scan.ours.some((found) => found.key === key));
  return {
    ...locations,
    repoHookDir,
    claude,
    code: readSettings(locations.vscodeSettings),
    scan,
    table,
    registered,
    missing,
    record: loadRecord(locations.root),
  };
}

// ---------------------------------------------------------------------------- the checks

/** Why one pane-pulse entry is not the one the installer writes for its registration, or null. */
function mismatch(entry, registration, root, platform) {
  const expected = buildEntry(registration, root, platform);
  const bare = withoutAsync(entry);
  if (sameJson(bare, expected)) return null;
  const shape = shapeToWrite(registration, platform);
  let actual;
  try {
    actual = shapeOfEntry(bare);
  } catch {
    return 'is in neither shape the installer writes';
  }
  if (actual !== shape) {
    return `is in the ${actual} shape, where on ${platform} the installer writes this registration in the ${shape} shape`;
  }
  if (actual === 'node' && bare.args[0] !== expected.args[0]) {
    return `runs ${bare.args[0]}, not ${expected.args[0]}`;
  }
  if (actual === 'shell' && bare.command !== expected.command) {
    return `is pane-pulse's one-liner written for another root, not ${root}`;
  }
  const differing = unique([...Object.keys(bare), ...Object.keys(expected)]).filter(
    (key) => !sameJson(bare[key], expected[key]),
  );
  if (differing.length === 0) {
    return "has the installer's fields in another order, so an uninstall would not recognise it";
  }
  return `differs from the installer's entry: ${differing
    .map((key) => `${key} is ${glance(bare[key])}, the installer writes ${glance(expected[key])}`)
    .join(', ')}`;
}

function checkHooks(facts) {
  const { table, claude, scan, registered, root, platform } = facts;
  const reasons = [...table.notes];
  if (table.table === null) return { ok: false, text: reasons.join('; ') };
  if (!claude.ok) {
    reasons.push(`Claude Code settings ${claude.why}`);
    return { ok: false, text: reasons.join('; ') };
  }
  reasons.push(...scan.problems);

  const missing = [];
  const doubled = [];
  const wrong = [];
  for (const [key, registration] of registered) {
    const found = scan.ours.filter((entry) => entry.key === key);
    if (found.length === 0) {
      missing.push(labelOf(registration));
    } else if (found.length > 1) {
      doubled.push(`${found.length} under ${labelOf(registration)}`);
    } else {
      const why = mismatch(found[0].entry, registration, root, platform);
      if (why !== null) wrong.push(`the one under ${labelOf(registration)} ${why}`);
    }
  }
  if (missing.length > 0) reasons.push(`no pane-pulse hook under ${missing.join(', ')}`);
  if (doubled.length > 0) reasons.push(`more than the one pane-pulse hook there must be: ${doubled.join(', ')}`);
  reasons.push(...wrong);

  const registeredEvents = new Set([...registered.values()].map((registration) => registration.event));
  const strays = scan.ours
    .filter((entry) => !registered.has(entry.key))
    .map((entry) =>
      registeredEvents.has(entry.event) ? `${entry.event} (in a group whose matcher it does not register)` : entry.event,
    );
  if (strays.length > 0) {
    reasons.push(
      `${plural(strays.length, 'pane-pulse hook', 'pane-pulse hooks')} where the table registers none, under ${unique(strays).join(', ')}`,
    );
  }

  const leftovers = scan.handInstalled.length;
  if (leftovers > 0) {
    reasons.push(
      `${plural(leftovers, 'hand-installed indicator hook', 'hand-installed indicator hooks')} (printing the 9;4 mark ` +
        `itself) under ${unique(scan.handInstalled.map((entry) => entry.event)).join(', ')}; ` +
        `the install takes ${leftovers === 1 ? 'it' : 'them'} out`,
    );
  }

  if (reasons.length > 0) return { ok: false, text: reasons.join('; ') };
  return {
    ok: true,
    text:
      `each of the ${registered.size} registrations in ${table.path} has exactly one pane-pulse hook, ` +
      `in the shape the table declares for ${platform}, pointing at ${root}; none anywhere else, ` +
      'and no hand-installed indicator hook left',
  };
}

function checkSynchronous(facts) {
  const { claude, scan, registered } = facts;
  if (!claude.ok) return { ok: false, text: `could not be checked: Claude Code settings ${claude.why}` };
  const asynchronous = scan.ours.filter((entry) => entry.entry.async === true);
  if (asynchronous.length > 0) {
    const where = unique(
      asynchronous.map((entry) => (registered.has(entry.key) ? labelOf(registered.get(entry.key)) : entry.event)),
    );
    return {
      ok: false,
      text:
        `${plural(asynchronous.length, 'pane-pulse hook is', 'pane-pulse hooks are')} async (async: true), under ` +
        `${where.join(', ')}: a terminalSequence is honoured only from a synchronous hook, so ` +
        `${asynchronous.length === 1 ? 'it' : 'they'} can never set a mark`,
    };
  }
  return {
    ok: true,
    text:
      scan.ours.length === 0
        ? "no pane-pulse hook in Claude Code's settings is async (there are none to check)"
        : `none of the ${scan.ours.length} pane-pulse hooks is async`,
  };
}

function checkSettings(facts) {
  const { code, claude } = facts;
  const reasons = [];
  if (!code.ok) {
    reasons.push(`VS Code settings ${code.why}`);
  } else if (!hasOwn(code.data, DESCRIPTION_KEY)) {
    reasons.push(`VS Code settings have no ${DESCRIPTION_KEY}, so no tab shows a mark`);
  } else if (typeof code.data[DESCRIPTION_KEY] !== 'string') {
    reasons.push(`VS Code's ${DESCRIPTION_KEY} is not text`);
  } else {
    const times = code.data[DESCRIPTION_KEY].split(PROGRESS_TOKEN).length - 1;
    if (times === 0) reasons.push(`VS Code's ${DESCRIPTION_KEY} does not contain ${PROGRESS_TOKEN}, so no tab shows a mark`);
    if (times > 1) reasons.push(`VS Code's ${DESCRIPTION_KEY} contains ${PROGRESS_TOKEN} ${times} times; it must be exactly once`);
  }
  if (!claude.ok) {
    reasons.push(`Claude Code settings ${claude.why}`);
  } else if (!hasOwn(claude.data, PROGRESS_KEY)) {
    reasons.push(`Claude Code's ${PROGRESS_KEY} is not set; the install sets it to false`);
  } else if (claude.data[PROGRESS_KEY] !== false) {
    reasons.push(
      `Claude Code's ${PROGRESS_KEY} is ${glance(claude.data[PROGRESS_KEY])}, not false, so Claude Code's own ` +
        "progress mark competes with pane-pulse's",
    );
  }
  if (reasons.length > 0) return { ok: false, text: reasons.join('; ') };
  return {
    ok: true,
    text: `VS Code's ${DESCRIPTION_KEY} contains ${PROGRESS_TOKEN} exactly once, and Claude Code's ${PROGRESS_KEY} is false`,
  };
}

/** What the deployed files are compared with, said in words: the record's source, or the repo's. */
function comparisonFor(facts) {
  const { record: loaded, repoHookDir } = facts;
  const record = loaded.record;
  if (record === null) {
    const why = loaded.present ? 'the install record cannot be read to name one' : 'there is no install record to name one';
    return { source: repoHookDir, recorded: null, words: `the repo's hook source (${repoHookDir}), since ${why}` };
  }
  const recorded = isObject(record.deployed) ? record.deployed : {};
  const named = isObject(record.table) && typeof record.table.path === 'string' ? dirname(record.table.path) : null;
  if (named !== null && existsSync(named)) {
    return { source: named, recorded, words: `the hook source the install record names (${named})` };
  }
  return {
    source: null,
    recorded,
    words:
      named === null
        ? 'the sha256 the install record holds (it names no source folder)'
        : `the sha256 the install record holds (its source ${named} is gone)`,
  };
}

/** Why one deployed file is not what it must be, or null. */
function deployedProblem(name, facts, comparison) {
  const deployed = join(facts.root, name);
  if (!existsSync(deployed)) return `${deployed} is missing`;
  const have = sha256Of(deployed);
  const { source, recorded } = comparison;
  const want = recorded !== null && typeof recorded[name] === 'string' ? recorded[name] : null;
  if (recorded !== null && want === null) return `the install record holds no sha256 for ${name}`;
  if (want !== null && have !== want) {
    return `${deployed} has changed since the install deployed it (sha256 ${short(have)}, the record says ${short(want)})`;
  }
  if (source === null) return null;
  const origin = join(source, name);
  if (!existsSync(origin)) return `${origin} is missing, so ${deployed} cannot be compared with it`;
  const then = sha256Of(origin);
  if (have === then) return null;
  return want !== null
    ? `${deployed} is out of date: ${origin} has changed since the install, so install again`
    : `${deployed} does not match ${origin} (sha256 ${short(have)} against ${short(then)})`;
}

function checkDeployed(facts) {
  const { root, record: loaded } = facts;
  const reasons = [];
  if (!loaded.present) {
    reasons.push(`the install record ${recordPathFor(root)} is missing, so an uninstall has nothing to work from`);
  } else if (loaded.problem !== null) {
    reasons.push(loaded.problem);
  }
  const comparison = comparisonFor(facts);
  const names = unique([HOOK_BASENAME, TABLE_BASENAME, ...Object.keys(comparison.recorded ?? {})]);
  for (const name of names) {
    const problem = deployedProblem(name, facts, comparison);
    if (problem !== null) reasons.push(problem);
  }
  if (reasons.length > 0) return { ok: false, text: `${reasons.join('; ')}; compared against ${comparison.words}` };
  return {
    ok: true,
    text: `by sha256, ${inWords(names)} in ${root} match ${comparison.words}, and the install record parses`,
  };
}

/** One check, run so that a surprise inside it is a FAIL line rather than a crash. */
function run(number, name, judge, facts) {
  try {
    return { number, name, ...judge(facts) };
  } catch (error) {
    return { number, name, ok: false, text: `could not be checked: ${error.message}` };
  }
}

function verdictOf(facts, checks) {
  const failing = checks.filter((check) => !check.ok).length;
  if (failing === 0) return `pane-pulse is installed, and all ${checks.length} checks hold.`;
  const anything =
    facts.record.present || existsSync(join(facts.root, HOOK_BASENAME)) || facts.scan.ours.length > 0;
  if (!anything) {
    return (
      "pane-pulse is NOT installed here: there is no install record, no deployed hook and no pane-pulse hook in Claude Code's " +
      'settings. To install, run Pane Pulse: Install Hooks in VS Code, or preview it with node scripts/install-hooks.mjs --dry-run.'
    );
  }
  if (facts.record.record !== null && facts.missing.length > 0) {
    return (
      `pane-pulse is NOT installed the way its record says: the install record says it is, but ${facts.missing.length} of ` +
      `its ${facts.registered.size} hooks are gone from Claude Code's settings. Something rewrote that file after the install ` +
      "(Glitch's /look restore does this); install again to put them back."
    );
  }
  return `pane-pulse is installed, but ${failing} of ${checks.length} checks fail; each FAIL line above says what is wrong.`;
}

// ---------------------------------------------------------------------------- the command line

/**
 * Every check against these locations, read once and judged four ways. `repoHookDir` is the
 * source the deployed files are compared with when there is no install record to name one.
 */
export function prove(locations, repoHookDir = HOOK_DIR) {
  const facts = gather(locations, repoHookDir);
  const checks = [
    run(1, 'hooks', checkHooks, facts),
    run(2, 'synchronous', checkSynchronous, facts),
    run(3, 'settings', checkSettings, facts),
    run(4, 'deployed', checkDeployed, facts),
  ];
  return Object.freeze({
    locations,
    checks: Object.freeze(checks),
    verdict: verdictOf(facts, checks),
    exitCode: checks.every((check) => check.ok) ? 0 : 1,
  });
}

/** The report a member reads: where it looked, one line per check, and the verdict. */
export function renderReport(report) {
  const { locations } = report;
  const lines = ['pane-pulse · check-only (reads, never writes)', ''];
  lines.push(`root                   ${locations.root}`);
  lines.push(`platform               ${locations.platform}`);
  lines.push(`Claude Code settings   ${locations.claudeSettings}`);
  lines.push(`VS Code settings       ${locations.vscodeSettings}`);
  lines.push('');
  for (const check of report.checks) {
    lines.push(`${(check.ok ? 'ok' : 'FAIL').padEnd(4)}  ${check.number}  ${check.name}: ${check.text}`);
  }
  lines.push('');
  lines.push(`verdict: ${report.verdict}`);
  return `${lines.join('\n')}\n`;
}

/** The flags, and the one problem with them if there is one. */
export function parseArgs(argv) {
  const options = { checkOnly: false, help: false, problem: null };
  for (const arg of argv) {
    if (arg === '--check-only') options.checkOnly = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (options.problem === null) options.problem = `unknown argument ${JSON.stringify(arg)}`;
  }
  if (options.problem === null && !options.help && !options.checkOnly) {
    options.problem = '--check-only is the only mode there is so far, and it was not given; nothing was checked';
  }
  return options;
}

export function main(
  argv = process.argv.slice(2),
  env = process.env,
  out = process.stdout,
  err = process.stderr,
  platform = process.platform,
  home = homedir(),
) {
  const options = parseArgs(argv);
  if (options.problem !== null) {
    err.write(`pane-pulse prove-local: ${options.problem}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    out.write(USAGE);
    return 0;
  }
  const report = prove(resolveLocations(env, platform, home));
  out.write(renderReport(report));
  return report.exitCode;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`pane-pulse prove-local: ${error.message}\n`);
    process.exitCode = 1;
  }
}
