#!/usr/bin/env node
// The command line over src/installer.ts: register pane-pulse's hook set, or take it back out.
//
// Every rule the install keeps (driven by the table, deploy before settings, back up or do not
// write, reversible from a record, never a brain) lives in src/installer.ts, which the
// extension's commands bundle too. This file is only the command line: its flags, its usage,
// its exit codes, and the one thing only it knows -- that the hook it deploys is this repo's
// own hook/, one folder up from here. Node strips the types off src/installer.ts on import,
// which is what lets a `.mjs` script run the same TypeScript the extension bundles.
//
// Both settings locations and the root take an environment override, which is how every test
// points at copies instead: PANE_PULSE_CLAUDE_SETTINGS, PANE_PULSE_VSCODE_SETTINGS and
// PANE_PULSE_HOME.
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  commit,
  planInstall,
  planUninstall,
  renderPreview,
  resolveContext,
  tablePathIn,
} from '../src/installer.ts';

// Everything the tests and other callers imported from this file before the logic moved, so
// no importer has to learn the new home: tests/installer.test.mjs, tests/events.test.mjs.
export {
  applySettingsEdits as applyEdits_,
  buildEntry,
  commit,
  detectFormatting,
  isIndicatorEntry,
  nodeCommand,
  planInstall,
  planUninstall,
  readRecord,
  recordPathFor,
  renderPreview,
  resolveClaudeSettings,
  resolveVsCodeSettings,
  shapeOfEntry,
  shapeToWrite,
  shellCommand,
} from '../src/installer.ts';

/** This repo's hook/: the command line deploys the source tree's hook, never a built copy. */
const HOOK_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'hook');

const USAGE = `pane-pulse install-hooks

  node scripts/install-hooks.mjs [--dry-run]
  node scripts/install-hooks.mjs --uninstall [--dry-run]

  --dry-run    print the preview and write nothing at all
  --uninstall  undo an install from <root>/install-record.json
  --help       this

  PANE_PULSE_HOME              <root> (default ~/.pane-pulse)
  PANE_PULSE_CLAUDE_SETTINGS   Claude Code's settings.json
  PANE_PULSE_VSCODE_SETTINGS   VS Code's user settings.json
`;

/** The one never-returning helper, worded as the installer's own refusals are. */
function fail(message) {
  throw new Error(`pane-pulse install: ${message}`);
}

/** The decision table the command line installs from: the one beside hook/hook.js. */
export function tablePath() {
  return tablePathIn(HOOK_DIR);
}

export function parseArgs(argv) {
  const options = { dryRun: false, uninstall: false, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--uninstall') options.uninstall = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else fail(`unknown argument ${JSON.stringify(arg)}\n\n${USAGE}`);
  }
  return options;
}

/** The installer's own resolution, with this repo's hook/ as the source. */
export function contextFrom(env = process.env, platform = process.platform, home = homedir()) {
  return resolveContext(HOOK_DIR, env, platform, home);
}

export function main(argv = process.argv.slice(2), env = process.env, out = process.stdout) {
  const options = parseArgs(argv);
  if (options.help) {
    out.write(USAGE);
    return 0;
  }
  const context = contextFrom(env);
  const plan = options.uninstall ? planUninstall(context) : planInstall(context);
  out.write(renderPreview(plan, options.dryRun));
  if (options.dryRun) return 0;
  commit(plan);
  out.write(`done · ${plan.mode}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
