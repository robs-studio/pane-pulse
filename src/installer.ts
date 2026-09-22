// Register pane-pulse's hook set in the member's own configuration, reversibly: the one installer.
//
// Two files are touched and both are the MEMBER's: Claude Code's settings.json (the hook
// entries, plus its own terminalProgressBarEnabled) and VS Code's user settings.json (the
// terminal tab description, so ${progress} has somewhere to render). Both locations take an
// environment override, which is how every test points at copies instead:
// PANE_PULSE_CLAUDE_SETTINGS, PANE_PULSE_VSCODE_SETTINGS and PANE_PULSE_HOME.
//
// Two roads share this module and neither forks it: `scripts/install-hooks.mjs` (the command
// line, which Node runs with the types stripped) and `src/commands.ts` (the extension's three
// commands, bundled by esbuild). So nothing here imports vscode, and NOTHING HERE WORKS OUT
// WHERE THE HOOK IS. `import.meta.url` is `undefined` in esbuild's CommonJS bundle (see
// decision.ts's header), so a path derived from this file's location would be right in the
// source tree and wrong in the extension. The hook source directory is a parameter of every
// install instead: `hook/` for the command line, `<extension>/dist/hook/` for the extension,
// and the decision table is read from beside whichever one it is.
//
// Six rules this file is built around:
//
//   * DRIVEN BY THE TABLE, NEVER BY A COUNT. Every entry written comes from one row of the
//     table's `registrations`, in the `shape` that row declares. No number of registrations and
//     no list of events appears anywhere below, so a registration added to the table is
//     written for free and one removed stops being written.
//   * DEPLOY BEFORE SETTINGS. hook.js and its table are copied into <root> and their sha256
//     recorded BEFORE a byte of settings is written. The other order points the member's live
//     configuration at a file that does not exist. Each copy is written beside its target and
//     renamed into place, so a hook firing during a re-install reads the old file or the new
//     one, whole, never half of each; and the bytes written are the bytes whose sha256 is on
//     record, read once and checked.
//   * BACK UP, OR DO NOT WRITE. Both files are backed up through backup.ts first, and a backup
//     that throws takes the whole run down before the first edit.
//   * SURGICAL, AND REVERSIBLE FROM A RECORD. <root>/install-record.json holds every entry
//     added and every entry removed, verbatim, with where each one sat, and the backup of each
//     file as it was before the FIRST install. An uninstall computes the inverse from that
//     record alone. jsonc-parser rewrites a whole replaced array in the member's indentation,
//     so a hook group they wrote on one line would come back re-flowed: when the inverse is the
//     pre-install file in everything but layout, the pre-install bytes go back instead, exactly.
//   * A PLAN IS WRITTEN ONLY OVER THE BYTES IT WAS MADE FROM. The extension shows a preview and
//     then waits on a person, and Claude Code rewrites its own settings.json whenever a
//     permission is granted. commit() re-reads both files and the hook source first, and a
//     change since the plan refuses the write: a yes to one preview is never a yes to another.
//   * NEVER A BRAIN. assertNotInBrain() walks every ancestor of every path written.
//
// The removal predicate matters more than it looks. A live machine already carries
// hand-installed entries that emit the same OSC 9;4 marks by printf; leaving them in place
// would put two hooks on one event, both returning a terminalSequence, with no defined winner.
// So anything whose command carries `9;4`, or whose args[0] is a file named hook.js, comes out
// first -- including a previous pane-pulse install, which is what makes a second install
// idempotent.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { applyEdits, modify, parse as parseJsonc, visit } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';

import { BACKUPS_DIRNAME, assertNotInBrain, backup, list, resolveRoot, restore, writeFileAtomic } from './backup.ts';
import { REGISTRATION_SHAPES, loadDecisionTable } from './decision.ts';
import type { Registration, RegistrationShape } from './decision.ts';

const HOOK_BASENAME = 'hook.js';
const TABLE_BASENAME = 'decision-table.json';

/**
 * hook/package.json rides along on purpose: it is the two lines that classify the folder
 * commonjs, and hook.js is plain CommonJS. Without it, a `"type": "module"` package.json
 * anywhere above <root> would make `node <root>/hook.js` fail to parse.
 */
const DEPLOYED_FILES: readonly string[] = Object.freeze([HOOK_BASENAME, TABLE_BASENAME, 'package.json']);

/** Where the extension's copy of the hook sits inside its install: esbuild.mjs copies hook/ there. */
const EXTENSION_HOOK_DIR: readonly string[] = Object.freeze(['dist', 'hook']);

const EVENTS_DIRNAME = 'events';

/**
 * `<root>/mute/<claude pid>`: a pane is muted while its marker exists. The extension writes and
 * deletes the markers; the hook and the shell one-liner only ever stat one. hook/hook.js exports
 * the same name, and tests/installer.test.mjs holds the folder an install makes to it.
 */
const MUTE_DIRNAME = 'mute';

/** Set in a pane's environment, it mutes that pane from its start. hook/hook.js reads the same one. */
const IGNORE_ENV = 'PANE_PULSE_IGNORE';

const RECORD_BASENAME = 'install-record.json';
const RECORD_VERSION = 1;
const RECORD_TOOL = 'pane-pulse';

const CLAUDE_SETTINGS_ENV = 'PANE_PULSE_CLAUDE_SETTINGS';
const VSCODE_SETTINGS_ENV = 'PANE_PULSE_VSCODE_SETTINGS';

/** What each file is called wherever a person reads about it: the preview, a dialog, a pick. */
const CLAUDE_LABEL = 'Claude Code settings';
const VSCODE_LABEL = 'VS Code settings';

/** Claude Code's own key. It is not the VS Code setting of a similar name, which does not exist. */
const PROGRESS_KEY = 'terminalProgressBarEnabled';

const DESCRIPTION_KEY = 'terminal.integrated.tabs.description';
const PROGRESS_TOKEN = '${progress}';
const DESCRIPTION_PREFIX = '${progress}${separator}';

/**
 * VS Code's own default for DESCRIPTION_KEY. Setting the key at all overrides that default, so
 * a member who has never touched it would silently lose the task and folder text. Prepending
 * onto the default keeps what they see today and adds the progress token in front of it.
 */
const VSCODE_DEFAULT_DESCRIPTION = '${task}${separator}${local}${separator}${cwdFolder}';

/** Every hook entry carries this. Five seconds is far past a synchronous hook's real cost. */
const HOOK_TIMEOUT = 5;

/** What marks an entry as one of the terminal-indicator hooks, ours or a hand-installed one. */
const INDICATOR_MARK = '9;4';

/**
 * The subagent guard, preserved verbatim: the head of the shell shape, and how it is recognised.
 *
 * It implements the table's `PostToolUse / agent_id: present -> noop` row: a tool call made by
 * a subagent must not re-spin the parent pane. `grep -q` consumes stdin, which is why everything
 * after it is built from the environment alone -- nothing downstream can re-read the payload.
 * The `||` runs the brace group that follows only on the branch where grep found no agent_id, so
 * a subagent's tool call writes neither the mark nor an event, which is what `noop` means.
 */
const SUBAGENT_GUARD = `grep -q '"agent_id"' ||`;

/** The table's spin mark, printed on the one branch that is not muted. */
const SHELL_SPIN = `printf '%s' '{"terminalSequence":"\\u001b]9;4;3;0\\u001b\\\\"}'`;

/**
 * The mute read, in shell source, and it comes BEFORE the mark. `u` is `env` when
 * PANE_PULSE_IGNORE is set, else `marker` when `$m` (the pane's marker) exists, else empty: the
 * hook's own order, the environment first. `[ -e ]` is a stat, so nothing ever opens the marker
 * and a FIFO there cannot hang a pane. The variable is compared as text with no trim -- unset,
 * empty and `0` are off, anything else is on -- which is exactly hook/hook.js's ignoredByEnv, and
 * tests/installer.test.mjs holds the two readers equal value by value.
 *
 * A muted pane prints nothing and records `sequence: null` with why, in `muted`; an unmuted one
 * prints the spin and records it. Every variable is assigned on both branches, so nothing in the
 * member's environment can leak into the record.
 */
const SHELL_MUTE_READ =
  'if [ "${' +
  IGNORE_ENV +
  ':-0}" != 0 ]; then u=env; elif [ -e "$m" ]; then u=marker; else u=; fi; ' +
  'if [ -n "$u" ]; then s=null; x=",\\"muted\\":\\"$u\\""; else ' +
  SHELL_SPIN +
  '; s=\'"spin"\'; x=; fi';

/**
 * The event record the shell shape emits, in shell source. Every field comes from the
 * environment: the guard above has already eaten the payload. `session_id` and `bg` are absent,
 * and `muted` is present only when the pane is, all three of which hook/hook.js's EVENT_SCHEMA
 * declares optional; the rest are what it calls required. `$s$x` is the mute read's answer: the
 * sequence that reached the tab, then the `muted` field when there is one.
 *
 * A working directory holding a `"` or a `\` would make this JSON malformed and src/events.ts
 * would discard that one event -- the mark itself is unaffected, and escaping it would cost a
 * process on every tool call for a path shape that does not occur in practice.
 */
const SHELL_EVENT_RECORD =
  '"{\\"ts\\":$t,\\"event\\":\\"PostToolUse\\",\\"matcher\\":null,\\"notification_type\\":null,' +
  '\\"claude_pid\\":$p,\\"cwd\\":\\"$PWD\\",\\"state\\":\\"thinking\\",\\"sequence\\":$s$x}"';

// ---------------------------------------------------------------------------- types

/** A JSON object as a settings file holds it. Its values are read and checked, never trusted. */
export type JsonObject = Record<string, unknown>;

/** Where every install, uninstall and restore reads from and writes to. */
export type Locations = {
  /** `<root>`: the deployed hook, the event files, the install record and the backups. */
  readonly root: string;
  readonly platform: NodeJS.Platform;
  readonly claudeSettings: string;
  readonly vscodeSettings: string;
};

/**
 * One install's inputs. `hookDir` is the folder the hook is deployed FROM, with its table
 * beside it. It is always given, never derived: see the header.
 */
export type InstallContext = Locations & {
  readonly hookDir: string;
};

/** An uninstall needs only the root: everything else is in the record the install left there. */
export type UninstallContext = Pick<Locations, 'root'>;

/** The exec form: no shell parses the path. */
export type NodeEntry = {
  readonly type: 'command';
  readonly command: 'node';
  readonly args: readonly string[];
  readonly timeout: number;
};

/** The guarded one-liner, written for a `shell` registration everywhere but win32. */
export type ShellEntry = {
  readonly type: 'command';
  readonly command: string;
  readonly timeout: number;
};

/** An entry this installer writes. */
export type HookEntry = NodeEntry | ShellEntry;

/** How a file is laid out, detected rather than assumed, so an edit keeps the member's style. */
export type Formatting = {
  readonly insertSpaces: boolean;
  readonly tabSize: number;
  readonly eol: string;
};

/** One settings file as a plan found it: the bytes, what they parse to, and their layout. */
export type SettingsSnapshot = {
  readonly path: string;
  readonly exists: boolean;
  readonly text: string;
  readonly data: JsonObject;
  readonly formatting: Formatting;
};

/** One surgical change to a settings file: set the key at `path`, or remove it. */
export type SettingsEdit =
  | { readonly path: readonly string[]; readonly value: unknown }
  | { readonly path: readonly string[]; readonly remove: true };

/** A settings file, its snapshot, and the edits a commit will make to it. */
export type PlannedFile = SettingsSnapshot & {
  readonly label: string;
  readonly edits: readonly SettingsEdit[];
  /** The exact text a commit writes when there are edits: the edits applied, or see below. */
  readonly result: string;
  /**
   * Uninstall only: the pre-install backup whose bytes `result` is, when the edits alone would
   * have given the same file in a different layout. Null when `result` is the edits' own text.
   */
  readonly originalFrom: string | null;
  /** Uninstall only: a file the install brought into being goes with the last key inside it. */
  readonly removeIfEmpty: boolean;
};

/** One file copied into <root> before any setting names it. */
export type DeployedFile = {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly sha256: string;
};

/**
 * One entry an install took out, with exactly where it sat. `group_survivors` is what makes
 * the inverse exact: see stripEvent(). JSON-mirroring, so the fields stay snake_case.
 */
export type Removal = {
  readonly event: string;
  readonly group_index: number;
  readonly hook_index: number;
  readonly group_template: JsonObject;
  readonly group_survivors: readonly unknown[] | null;
  readonly entry: unknown;
};

/** One entry an install put in, one per registration. */
export type Addition = {
  readonly event: string;
  readonly matcher: string | null;
  readonly shape: RegistrationShape;
  readonly entry: HookEntry;
};

/** What one key read before the FIRST install, and what the install wrote there (`null`: nothing). */
export type KeyRecord = {
  readonly key: string;
  readonly existed: boolean;
  readonly previous: unknown;
  readonly written: unknown;
};

/** The tab description's record, with the reason in words, which the preview shows. */
export type DescriptionRecord = KeyRecord & {
  readonly why: string;
};

/** What an uninstall does to one key: the edit (`null` leaves it alone), and why, in words. */
export type KeyChange = {
  readonly edit: SettingsEdit | null;
  readonly why: string;
};

/** <root>/install-record.json, field for field. JSON-mirroring, so the fields stay snake_case. */
export type InstallRecord = {
  readonly version: number;
  readonly tool: string;
  readonly installed_at: string;
  readonly platform: NodeJS.Platform;
  readonly root: string;
  readonly table: { readonly path: string; readonly registrations: number };
  readonly deployed: Readonly<Record<string, string>>;
  readonly claude: {
    readonly path: string;
    readonly existed: boolean;
    readonly hooks_existed: boolean;
    readonly removed: readonly Removal[];
    readonly added: readonly Addition[];
    readonly before: Readonly<Record<string, unknown>>;
    readonly after: Readonly<Record<string, unknown>>;
    readonly progress: KeyRecord;
    readonly backup: string | null;
  };
  readonly vscode: {
    readonly path: string;
    readonly existed: boolean;
    readonly description: DescriptionRecord;
    readonly backup: string | null;
  };
};

type PlanBase = {
  readonly root: string;
  readonly platform: NodeJS.Platform;
  readonly tablePath: string;
  readonly registrations: number;
  readonly deploy: readonly DeployedFile[];
  readonly discard: readonly string[];
  readonly recordPath: string;
  readonly record: InstallRecord;
  /** Claude Code's settings first, VS Code's second, always. */
  readonly files: readonly [PlannedFile, PlannedFile];
};

/** Everything an install will do, worked out before anything is written. */
export type InstallPlan = PlanBase & {
  readonly mode: 'install';
  /** No earlier record: this run's backups are the pre-install state the record keeps. */
  readonly firstInstall: boolean;
  readonly changes: {
    readonly removed: readonly Removal[];
    readonly added: readonly Addition[];
    readonly progress: KeyRecord;
    readonly description: DescriptionRecord;
  };
};

/** Everything an uninstall will do, worked out from the record before anything is written. */
export type UninstallPlan = PlanBase & {
  readonly mode: 'uninstall';
  readonly changes: {
    readonly restored: readonly Removal[];
    /** Removals an equal entry already answers for, which a restore or another tool put back. */
    readonly standing: readonly Removal[];
    readonly dropped: readonly { readonly event: string; readonly entry: unknown }[];
    readonly progress: KeyChange;
    readonly description: KeyChange;
  };
};

export type Plan = InstallPlan | UninstallPlan;

/**
 * Where a preview is read. `dry-run` and `writing` are the command line's two (it passes its
 * `--dry-run` flag straight through as a boolean); `confirm` is the extension's, shown before
 * it asks.
 */
export type PreviewStage = 'dry-run' | 'writing' | 'confirm';

/** What a commit did: each file and where its pre-write backup went, and the record. */
export type CommitResult = {
  readonly mode: Plan['mode'];
  readonly root: string;
  /** `backup` is null for a file that did not exist yet: a cold start has nothing to lose. */
  readonly backups: readonly { readonly label: string; readonly path: string; readonly backup: string | null }[];
  /** The record as written (install) or as consumed (uninstall). */
  readonly record: InstallRecord;
};

/** A plan with the words a person is asked over: the full preview, and the dialog's gist. */
export type Proposal = {
  readonly plan: Plan;
  readonly preview: string;
  readonly summary: string;
  readonly detail: string;
  /** The one button that says yes. Anything else, a dismissal included, writes nothing. */
  readonly action: string;
};

/** One of the two files the installer edits, named for a person. */
export type EditedFile = {
  readonly label: string;
  readonly path: string;
};

/** One backup in a file's ring, as the restore command offers it. */
export type BackupChoice = {
  readonly path: string;
  /** The backup's file name, which is also its exact stamp for backup.ts's restore(). */
  readonly name: string;
  /** The instant the stamp names; null for a name that is not a stamp. */
  readonly takenAt: Date | null;
};

/** One file the member chose to roll back, and the backup chosen for it. */
export type RestorePick = {
  readonly file: EditedFile;
  readonly choice: BackupChoice;
};

/** The one never-returning helper. Messages name the path and quote the value. */
function fail(message: string): never {
  throw new Error(`pane-pulse install: ${message}`);
}

// ---------------------------------------------------------------------------- paths

/** Claude Code's user settings: the override, else `~/.claude/settings.json` on every OS. */
export function resolveClaudeSettings(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env[CLAUDE_SETTINGS_ENV];
  if (typeof configured === 'string' && configured !== '') return resolve(configured);
  return join(home, '.claude', 'settings.json');
}

/** VS Code's user settings: the override, else where VS Code keeps them on this platform. */
export function resolveVsCodeSettings(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env[VSCODE_SETTINGS_ENV];
  if (typeof configured === 'string' && configured !== '') return resolve(configured);
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  }
  if (platform === 'win32') {
    const appData = env.APPDATA;
    const base =
      typeof appData === 'string' && appData !== '' ? appData : join(home, 'AppData', 'Roaming');
    return join(base, 'Code', 'User', 'settings.json');
  }
  return join(home, '.config', 'Code', 'User', 'settings.json');
}

/** The root and both settings files, by the environment overrides or the per-OS defaults. */
export function resolveLocations(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): Locations {
  return Object.freeze({
    root: resolveRoot(env, home),
    platform,
    claudeSettings: resolveClaudeSettings(env, home),
    vscodeSettings: resolveVsCodeSettings(env, home, platform),
  });
}

/** An install's whole context: the resolved locations, plus the hook source the caller names. */
export function resolveContext(
  hookDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): InstallContext {
  return Object.freeze({ ...resolveLocations(env, platform, home), hookDir });
}

/** Where the extension deploys from: its own bundled copy, never the repo's hook/. */
export function extensionHookDir(extensionPath: string): string {
  return join(extensionPath, ...EXTENSION_HOOK_DIR);
}

/** The decision table the plan reads: the one beside the hook it deploys. */
export function tablePathIn(hookDir: string): string {
  return join(hookDir, TABLE_BASENAME);
}

export function recordPathFor(root: string): string {
  return join(root, RECORD_BASENAME);
}

/** Whether an install left a record here, which is what an uninstall needs to exist at all. */
export function hasInstallRecord(root: string): boolean {
  return existsSync(recordPathFor(root));
}

/** Refuses a missing or empty hook source rather than guessing one. */
function hookDirOf(context: InstallContext): string {
  const given: unknown = context.hookDir;
  if (typeof given !== 'string' || given === '') {
    fail(
      `no hook source directory was given (hookDir, got ${JSON.stringify(given)}). The installer ` +
        'never works out where the hook is: the command line passes hook/, the extension dist/hook/.',
    );
  }
  return resolve(given);
}

// ---------------------------------------------------------------------------- entries

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * The shell shape: the guard verbatim, then on the surviving branch the mute read, the mark only
 * when the pane is not muted, and one atomic event file. The root is bound ONCE, to `r`, and both
 * paths are built from it: scripts/prove-local.mjs recognises this entry by splitting it around
 * the one place its root appears, and refuses at load an entry that carries it twice.
 */
export function shellCommand(root: string): string {
  return (
    SUBAGENT_GUARD +
    ' { p=${CLAUDE_PID:-$PPID}; r=' +
    shellQuote(root) +
    '; m=$r/' +
    MUTE_DIRNAME +
    '/$p; ' +
    SHELL_MUTE_READ +
    '; t=$(date +%s)000; d=$r/' +
    EVENTS_DIRNAME +
    '; mkdir -p "$d"; f=$d/$t-$p-$$.json; printf \'%s\' ' +
    SHELL_EVENT_RECORD +
    ' > "$f.tmp" && mv "$f.tmp" "$f" || :; }'
  );
}

/** The node shape: the exec form, so no shell parses the path. */
export function nodeCommand(root: string): NodeEntry {
  return Object.freeze({
    type: 'command',
    command: 'node',
    args: Object.freeze([join(root, HOOK_BASENAME)]),
    timeout: HOOK_TIMEOUT,
  });
}

/**
 * One builder per shape the table may declare. The Record type makes a shape without a builder
 * a type error, and the loop below makes it a load-time one too, so a shape added to
 * decision.ts fails loudly instead of quietly taking the wrong form.
 */
const ENTRY_BUILDERS: Readonly<Record<RegistrationShape, (root: string) => HookEntry>> = Object.freeze({
  node: (root: string): HookEntry => nodeCommand(root),
  shell: (root: string): HookEntry =>
    Object.freeze({ type: 'command', command: shellCommand(root), timeout: HOOK_TIMEOUT }),
});

for (const shape of REGISTRATION_SHAPES) {
  if (typeof ENTRY_BUILDERS[shape] !== 'function') {
    fail(`the table may declare the shape ${JSON.stringify(shape)} and this installer cannot write it`);
  }
}

/**
 * The shape an entry is actually written in. win32 has neither `sh` nor `printf`, so a `shell`
 * registration falls back to the node exec form there; everywhere else the declaration stands.
 */
export function shapeToWrite(
  registration: Pick<Registration, 'event' | 'shape'>,
  platform: NodeJS.Platform,
): RegistrationShape {
  const declared = registration.shape;
  if (!REGISTRATION_SHAPES.includes(declared)) {
    fail(`registration ${registration.event} declares an unknown shape ${JSON.stringify(declared)}`);
  }
  return platform === 'win32' ? 'node' : declared;
}

export function buildEntry(
  registration: Pick<Registration, 'event' | 'shape'>,
  root: string,
  platform: NodeJS.Platform,
): HookEntry {
  return ENTRY_BUILDERS[shapeToWrite(registration, platform)](root);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read an entry back and say which shape it is in. The sweep in the test uses this, and so does
 * scripts/prove-local.mjs.
 *
 * The shell shape is the guard as its head AND the mute marker in its body. The one-liner an
 * earlier pane-pulse wrote opens with the same guard but reads no marker, so it is refused here
 * as a shape this installer no longer writes, never passed as ours in shape; isIndicatorEntry
 * still reads its `9;4`, which is what makes a re-install take it out rather than leave it
 * marking the tab beside the new one.
 */
export function shapeOfEntry(entry: unknown): RegistrationShape {
  if (!isObject(entry)) {
    fail(`a hook entry must be an object, got ${JSON.stringify(entry)}`);
  }
  if (Array.isArray(entry.args)) {
    if (entry.command !== 'node') fail(`an entry with args must run node, got ${JSON.stringify(entry.command)}`);
    return 'node';
  }
  if (
    typeof entry.command === 'string' &&
    entry.command.startsWith(SUBAGENT_GUARD) &&
    entry.command.includes(`/${MUTE_DIRNAME}/`)
  ) {
    return 'shell';
  }
  fail(`a hook entry that is neither exec form nor the guarded shell one-liner that reads the mute: ${JSON.stringify(entry)}`);
}

/**
 * The removal predicate. Anything already marking this terminal comes out: a hand-installed
 * printf one-liner (they carry the OSC 9;4 mark in their command) and any previous pane-pulse
 * entry (its args[0] is the deployed hook.js, and its shell form carries the mark too). That
 * second arm is what makes a second install idempotent rather than doubling.
 *
 * It matches the FILE hook.js, not any name ending in those seven characters: a member's own
 * `my-hook.js` is not ours, and quietly deleting it would be the worst thing this file could
 * do. Both separators, because an entry written on Windows is read on Windows.
 */
export function isIndicatorEntry(entry: unknown): boolean {
  if (!isObject(entry)) return false;
  if (typeof entry.command === 'string' && entry.command.includes(INDICATOR_MARK)) return true;
  if (!Array.isArray(entry.args) || typeof entry.args[0] !== 'string') return false;
  const first: string = entry.args[0];
  return (
    first === HOOK_BASENAME ||
    first.endsWith(`/${HOOK_BASENAME}`) ||
    first.endsWith(`\\${HOOK_BASENAME}`)
  );
}

// ---------------------------------------------------------------------------- json files

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Detected rather than assumed: an edit must not reformat a file the member owns. */
export function detectFormatting(text: string): Formatting {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indented = /^([ \t]+)"/m.exec(text);
  if (indented === null) return Object.freeze({ insertSpaces: true, tabSize: 2, eol });
  return indented[1].startsWith('\t')
    ? Object.freeze({ insertSpaces: false, tabSize: 2, eol })
    : Object.freeze({ insertSpaces: true, tabSize: indented[1].length, eol });
}

/** JSON with comments, because a VS Code settings file is routinely exactly that. */
function readSettings(file: string): SettingsSnapshot {
  if (!existsSync(file)) {
    return Object.freeze({ path: file, exists: false, text: '', data: {}, formatting: detectFormatting('') });
  }
  const text = readFileSync(file, 'utf8');
  if (text.trim() === '') {
    return Object.freeze({ path: file, exists: true, text, data: {}, formatting: detectFormatting(text) });
  }
  const problems: ParseError[] = [];
  const data: unknown = parseJsonc(text, problems, { allowTrailingComma: true });
  if (problems.length > 0) {
    fail(`${file} does not parse as JSON (with comments): ${problems.length} problem(s), first at offset ${problems[0].offset}`);
  }
  if (!isObject(data)) {
    fail(`${file} must hold a JSON object at the top level, got ${JSON.stringify(data)}`);
  }
  return Object.freeze({ path: file, exists: true, text, data, formatting: detectFormatting(text) });
}

/** One surgical edit. A `remove` deletes the key; anything else sets it. */
function applyEdit(text: string, edit: SettingsEdit, formatting: Formatting): string {
  const base = text.trim() === '' ? '{}' : text;
  const value = 'remove' in edit ? undefined : edit.value;
  return applyEdits(base, modify(base, [...edit.path], value, { formattingOptions: formatting }));
}

/** A file's text after every edit of a plan, in order. */
export function applySettingsEdits(
  text: string,
  edits: readonly SettingsEdit[],
  formatting: Formatting,
): string {
  return edits.reduce((carry, edit) => applyEdit(carry, edit, formatting), text);
}

// ---------------------------------------------------------------------------- hook groups

/** A matcher group as the plan works on it: its own copy, so the parsed file is never mutated. */
type Group = JsonObject & { hooks: unknown[] };

function hooksOf(settings: SettingsSnapshot): { readonly hooks: JsonObject; readonly existed: boolean } {
  if (!hasOwn(settings.data, 'hooks')) return { hooks: {}, existed: false };
  const hooks = settings.data.hooks;
  if (!isObject(hooks)) {
    fail(`${settings.path}: "hooks" must be an object, got ${JSON.stringify(hooks)}`);
  }
  return { hooks, existed: true };
}

/** A group with its entries emptied: what it takes to put a removed entry back where it was. */
function groupTemplate(group: JsonObject): JsonObject {
  const template: JsonObject = {};
  for (const [key, value] of Object.entries(group)) template[key] = key === 'hooks' ? [] : value;
  if (!hasOwn(template, 'hooks')) template.hooks = [];
  return template;
}

function isGroup(value: unknown): value is Group {
  return isObject(value) && Array.isArray(value.hooks);
}

/**
 * Drop every indicator entry from one event's groups, remembering exactly where each sat.
 *
 * `group_survivors` is what makes the inverse exact: a group emptied of everything is deleted
 * and must be spliced back in at its old index, while a group that kept entries is still there
 * and must be found rather than duplicated. A template alone cannot tell those apart -- two
 * groups with no matcher have the same template -- and picking the wrong one would fold a
 * restored entry into a group it never belonged to.
 */
function stripEvent(event: string, groups: readonly unknown[], removed: Removal[]): unknown[] {
  const kept: unknown[] = [];
  groups.forEach((group, groupIndex) => {
    if (!isGroup(group)) {
      kept.push(group);
      return;
    }
    const survivors: unknown[] = [];
    const taken: { readonly hookIndex: number; readonly entry: unknown }[] = [];
    group.hooks.forEach((entry, hookIndex) => {
      if (isIndicatorEntry(entry)) taken.push({ hookIndex, entry });
      else survivors.push(entry);
    });
    for (const { hookIndex, entry } of taken) {
      removed.push(
        Object.freeze({
          event,
          group_index: groupIndex,
          hook_index: hookIndex,
          group_template: groupTemplate(group),
          group_survivors: survivors,
          entry,
        }),
      );
    }
    if (survivors.length > 0) kept.push({ ...group, hooks: survivors });
  });
  return kept;
}

/** The key two removals share when they are the same entry taken from the same event. */
function removalKey(event: string, entry: unknown): string {
  return JSON.stringify([event, entry]);
}

/**
 * The removals in `fresh` that nothing in `answered` accounts for. Each (event, entry) key in
 * `answered` answers for ONE equal removal in `fresh`, never for every one: a member who really
 * had the same entry twice under one event must get both back.
 */
function unanswered(fresh: readonly Removal[], answered: readonly string[]): Removal[] {
  const counts = new Map<string, number>();
  for (const key of answered) counts.set(key, (counts.get(key) ?? 0) + 1);
  return fresh.filter((removal) => {
    const key = removalKey(removal.event, removal.entry);
    const left = counts.get(key) ?? 0;
    if (left === 0) return true;
    counts.set(key, left - 1);
    return false;
  });
}

/**
 * Split one event's recorded removals into those to put back and those already standing.
 *
 * Putting a removed entry back is a no-op when an equal entry is already under that event:
 * that is the state a restore of the pre-install file leaves (backup.ts's restore, or /look's),
 * and reinstating it would double the member's own hook. Each equal entry present answers for
 * one recorded removal, counted before anything is put back, so two identical entries the
 * install really took out both come back on an ordinary uninstall.
 */
function splitReinstatements(
  event: string,
  groups: readonly unknown[],
  removals: readonly Removal[],
): { readonly missing: readonly Removal[]; readonly standing: readonly Removal[] } {
  const present = groups.flatMap((group) =>
    isGroup(group) ? group.hooks.map((entry) => removalKey(event, entry)) : [],
  );
  const missing = unanswered(removals, present);
  return { missing, standing: removals.filter((removal) => !missing.includes(removal)) };
}

/** Put one event's recorded removals back where they were, after ours have been taken out. */
function reinstateEvent(groups: readonly unknown[], removals: readonly Removal[]): unknown[] {
  const restored: unknown[] = groups.map((group) =>
    isGroup(group) ? { ...group, hooks: [...group.hooks] } : group,
  );

  type Bucket = {
    readonly index: number;
    readonly template: JsonObject;
    readonly survivors: readonly unknown[];
    readonly entries: Removal[];
  };
  const buckets = new Map<number, Bucket>();
  for (const removal of removals) {
    let bucket = buckets.get(removal.group_index);
    if (bucket === undefined) {
      bucket = {
        index: removal.group_index,
        template: removal.group_template,
        survivors: removal.group_survivors ?? [],
        entries: [],
      };
      buckets.set(removal.group_index, bucket);
    }
    bucket.entries.push(removal);
  }

  const claimed = new Set<Group>();
  for (const bucket of [...buckets.values()].sort((a, b) => a.index - b.index)) {
    let target: Group | undefined;
    if (bucket.survivors.length > 0) {
      for (const group of restored) {
        if (
          isGroup(group) &&
          !claimed.has(group) &&
          sameJson(groupTemplate(group), bucket.template) &&
          sameJson(group.hooks, bucket.survivors)
        ) {
          target = group;
          break;
        }
      }
    }
    if (target === undefined) {
      target = { ...bucket.template, hooks: [] };
      restored.splice(Math.min(bucket.index, restored.length), 0, target);
    }
    claimed.add(target);
    for (const removal of [...bucket.entries].sort((a, b) => a.hook_index - b.hook_index)) {
      target.hooks.splice(Math.min(removal.hook_index, target.hooks.length), 0, removal.entry);
    }
  }
  return restored;
}

// ---------------------------------------------------------------------------- install

/**
 * Everything an install will do, worked out and written nowhere. The table is read from beside
 * `context.hookDir` and the files deployed are that folder's, so the command line and the
 * extension each install exactly the hook they carry.
 */
export function planInstall(context: InstallContext): InstallPlan {
  const { root, platform } = context;
  const hookDir = hookDirOf(context);
  const tablePath = tablePathIn(hookDir);
  const table = loadDecisionTable(tablePath);

  const deploy = DEPLOYED_FILES.map((name): DeployedFile => {
    const from = join(hookDir, name);
    if (!existsSync(from)) fail(`the hook source ${from} is missing -- nothing to deploy`);
    return Object.freeze({ name, from, to: join(root, name), sha256: sha256Of(readFileSync(from)) });
  });

  // What an earlier install already knows. Without it a second install would record ITS OWN
  // entries as the state to restore, and uninstall would put pane-pulse back instead of taking
  // it away. The record always describes the journey back to the state before the FIRST one.
  const prior = existsSync(recordPathFor(root)) ? readRecord(root) : null;

  const claude = readSettings(context.claudeSettings);
  const { hooks, existed: hooksExisted } = hooksOf(claude);

  const removed: Removal[] = [];
  const next = new Map<string, unknown[]>();
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) fail(`${claude.path}: hooks.${event} must be an array of groups`);
    next.set(event, stripEvent(event, groups, removed));
  }

  const added: Addition[] = [];
  for (const registration of table.registrations) {
    const entry = buildEntry(registration, root, platform);
    const group =
      registration.matcher === undefined
        ? { hooks: [entry] }
        : { matcher: registration.matcher, hooks: [entry] };
    const groups = next.get(registration.event) ?? [];
    groups.push(group);
    next.set(registration.event, groups);
    added.push(
      Object.freeze({
        event: registration.event,
        matcher: registration.matcher ?? null,
        shape: shapeToWrite(registration, platform),
        entry,
      }),
    );
  }

  // An entry this run took out that a previous run had put in is ours coming home, never the
  // member's to get back.
  const priorlyAdded = prior === null ? [] : prior.claude.added.map((entry) => entry.entry);
  const theirsRemoved = removed.filter(
    (removal) => !priorlyAdded.some((entry) => sameJson(entry, removal.entry)),
  );
  // And one the record already holds is the same entry taken out again: a restore of the
  // pre-install file (backup.ts's, or /look's) put it back, and this run took it out a second
  // time. Recording it twice would make the uninstall put it back twice. Each removal already
  // on record answers for one equal (event, entry) removal of this run, so two identical
  // entries the member really had are still both on record, and both come back.
  const recordedRemoved =
    prior === null
      ? theirsRemoved
      : [
          ...prior.claude.removed,
          ...unanswered(
            theirsRemoved,
            prior.claude.removed.map((removal) => removalKey(removal.event, removal.entry)),
          ),
        ];
  const priorBefore: Readonly<Record<string, unknown>> = prior === null ? {} : prior.claude.before;

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const edits: SettingsEdit[] = [];
  for (const event of new Set([...next.keys(), ...Object.keys(priorBefore)])) {
    const was = hasOwn(hooks, event) ? hooks[event] : null;
    const groups = next.get(event);
    const will = groups === undefined ? was : groups.length === 0 ? null : groups;
    before[event] = hasOwn(priorBefore, event) ? priorBefore[event] : was;
    after[event] = will;
    if (sameJson(was, will)) continue;
    edits.push(
      will === null
        ? { path: ['hooks', event], remove: true }
        : { path: ['hooks', event], value: will },
    );
  }

  const progressNow = hasOwn(claude.data, PROGRESS_KEY) ? claude.data[PROGRESS_KEY] : null;
  const progress = inherit<KeyRecord>(
    {
      key: PROGRESS_KEY,
      existed: hasOwn(claude.data, PROGRESS_KEY),
      previous: progressNow,
      written: false,
    },
    prior === null ? null : prior.claude.progress,
    progressNow,
  );
  if (progressNow !== false) edits.push({ path: [PROGRESS_KEY], value: false });

  const code = readSettings(context.vscodeSettings);
  const descriptionNow = hasOwn(code.data, DESCRIPTION_KEY) ? code.data[DESCRIPTION_KEY] : null;
  const description = inherit<DescriptionRecord>(
    planDescription(code),
    prior === null ? null : prior.vscode.description,
    descriptionNow,
  );
  const codeEdits: SettingsEdit[] =
    description.written === null || sameJson(descriptionNow, description.written)
      ? []
      : [{ path: [DESCRIPTION_KEY], value: description.written }];

  const record: InstallRecord = {
    version: RECORD_VERSION,
    tool: RECORD_TOOL,
    installed_at: new Date().toISOString(),
    platform,
    root,
    table: { path: tablePath, registrations: table.registrations.length },
    deployed: Object.fromEntries(deploy.map((file) => [file.name, file.sha256])),
    claude: {
      path: claude.path,
      existed: prior === null ? claude.exists : prior.claude.existed,
      hooks_existed: prior === null ? hooksExisted : prior.claude.hooks_existed,
      removed: recordedRemoved,
      added,
      before,
      after,
      progress,
      backup: prior === null ? null : prior.claude.backup,
    },
    vscode: {
      path: code.path,
      existed: prior === null ? code.exists : prior.vscode.existed,
      description,
      backup: prior === null ? null : prior.vscode.backup,
    },
  };

  return Object.freeze({
    mode: 'install',
    firstInstall: prior === null,
    root,
    platform,
    tablePath,
    registrations: table.registrations.length,
    deploy: Object.freeze(deploy),
    discard: Object.freeze([]),
    recordPath: recordPathFor(root),
    record,
    files: Object.freeze([
      plannedFile(CLAUDE_LABEL, claude, edits, false, null),
      plannedFile(VSCODE_LABEL, code, codeEdits, false, null),
    ] as const),
    changes: Object.freeze({
      removed: Object.freeze(removed),
      added: Object.freeze(added),
      progress,
      description,
    }),
  });
}

/**
 * Keep the ORIGINAL reading of a key across a re-install. `fresh` is what this run sees, which
 * after an earlier install is that install's own handiwork; when the key still reads exactly
 * what the last run wrote, the last run's record of what was there before it is the true one.
 */
function inherit<T extends KeyRecord>(fresh: T, priorEntry: T | null, current: unknown): T {
  if (priorEntry === null || priorEntry.written === null) return fresh;
  return sameJson(current, priorEntry.written) ? priorEntry : fresh;
}

/** Prepend the progress token -- unless the value already carries it, which a member may have set. */
function planDescription(code: SettingsSnapshot): DescriptionRecord {
  const existed = hasOwn(code.data, DESCRIPTION_KEY);
  const previous = existed ? code.data[DESCRIPTION_KEY] : null;
  if (typeof previous === 'string' && previous.includes(PROGRESS_TOKEN)) {
    return {
      key: DESCRIPTION_KEY,
      existed,
      previous,
      written: null,
      why: `already carries ${PROGRESS_TOKEN} -- left exactly as it is`,
    };
  }
  const base = typeof previous === 'string' && previous !== '' ? previous : VSCODE_DEFAULT_DESCRIPTION;
  return {
    key: DESCRIPTION_KEY,
    existed,
    previous,
    written: DESCRIPTION_PREFIX + base,
    why: existed
      ? 'prepended to the value that was already there'
      : "prepended to VS Code's own default, so nothing the member sees today is lost",
  };
}

// ---------------------------------------------------------------------------- the written text

/** Every comment in a JSON-with-comments text, in order, as written. */
function commentsOf(text: string): string[] {
  const found: string[] = [];
  visit(text, { onComment: (offset, length) => found.push(text.slice(offset, offset + length)) }, { allowTrailingComma: true });
  return found;
}

/** A backup's text, or null when it is gone or unreadable: the edits' own result stands then. */
function readBackup(path: string | null): string | null {
  if (path === null) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Whether the pre-install bytes may stand in for what the edits produced: the two parse to the
 * same JSON, and the result carries no comment the original lacks. The second test is what
 * keeps a comment the member wrote AFTER the install from being dropped; a comment the install
 * itself lost (one inside a hook array it replaced) is exactly what the original gives back.
 */
function originalAnswers(result: string, original: string): boolean {
  const problems: ParseError[] = [];
  const parsedOriginal: unknown = parseJsonc(original, problems, { allowTrailingComma: true });
  if (problems.length > 0) return false;
  if (!sameJson(parseJsonc(result, [], { allowTrailingComma: true }), parsedOriginal)) return false;
  const available = commentsOf(original);
  for (const comment of commentsOf(result)) {
    const at = available.indexOf(comment);
    if (at === -1) return false;
    available.splice(at, 1);
  }
  return true;
}

/**
 * One file of a plan, with the exact text a commit will write. `original` is the pre-install
 * backup an uninstall may put back byte for byte; an install passes null.
 */
function plannedFile(
  label: string,
  snapshot: SettingsSnapshot,
  edits: readonly SettingsEdit[],
  removeIfEmpty: boolean,
  original: string | null,
): PlannedFile {
  const surgical = edits.length === 0 ? snapshot.text : applySettingsEdits(snapshot.text, edits, snapshot.formatting);
  const before = edits.length === 0 ? null : readBackup(original);
  const exact = before !== null && before !== surgical && originalAnswers(surgical, before);
  return Object.freeze({
    label,
    ...snapshot,
    edits: Object.freeze([...edits]),
    removeIfEmpty,
    result: exact ? before : surgical,
    originalFrom: exact ? original : null,
  });
}

// ---------------------------------------------------------------------------- uninstall

/** The install record under this root, or a refusal that says why there is nothing to undo. */
export function readRecord(root: string): InstallRecord {
  const path = recordPathFor(root);
  if (!existsSync(path)) {
    fail(
      `no install record at ${path}, so there is nothing to undo from this root. ` +
        'If the install ran with a different PANE_PULSE_HOME, set it and run again.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${path} is not readable as JSON: ${(error as Error).message}`);
  }
  if (!isObject(parsed) || parsed.version !== RECORD_VERSION) {
    fail(`${path} is not a version ${RECORD_VERSION} pane-pulse install record`);
  }
  return parsed as InstallRecord;
}

/** Everything an uninstall will do, from the record alone, written nowhere. */
export function planUninstall(context: UninstallContext): UninstallPlan {
  const record = readRecord(context.root);

  const claude = readSettings(record.claude.path);
  const { hooks } = hooksOf(claude);
  const resulting: JsonObject = { ...hooks };
  const edits: SettingsEdit[] = [];
  const restored: Removal[] = [];
  const standing: Removal[] = [];
  const dropped: { readonly event: string; readonly entry: unknown }[] = [];

  for (const event of Object.keys(record.claude.after)) {
    const present = hooks[event];
    const current: readonly unknown[] = Array.isArray(present) ? present : [];
    const ours = record.claude.added.filter((entry) => entry.event === event);
    const theirs = record.claude.removed.filter((entry) => entry.event === event);

    const kept: unknown[] = [];
    for (const group of current) {
      if (!isGroup(group)) {
        kept.push(group);
        continue;
      }
      const keptEntries = group.hooks.filter((entry) => {
        const mine = ours.some((candidate) => sameJson(candidate.entry, entry));
        if (mine) dropped.push(Object.freeze({ event, entry }));
        return !mine;
      });
      if (keptEntries.length > 0) kept.push({ ...group, hooks: keptEntries });
    }

    const { missing, standing: already } = splitReinstatements(event, kept, theirs);
    const groups = reinstateEvent(kept, missing);
    restored.push(...missing);
    standing.push(...already);

    const target = groups.length === 0 ? null : groups;
    if (sameJson(hasOwn(hooks, event) ? hooks[event] : null, target)) continue;
    if (target === null) delete resulting[event];
    else resulting[event] = target;
    edits.push(
      target === null
        ? { path: ['hooks', event], remove: true }
        : { path: ['hooks', event], value: target },
    );
  }

  // The `hooks` object we created ourselves goes with the last entry inside it.
  if (record.claude.hooks_existed === false && Object.keys(resulting).length === 0) {
    edits.push({ path: ['hooks'], remove: true });
  }

  const progress = record.claude.progress;
  const progressNow = hasOwn(claude.data, progress.key) ? claude.data[progress.key] : null;
  const progressChange = planKeyRestore(progress, progressNow);
  if (progressChange.edit !== null) edits.push(progressChange.edit);

  const code = readSettings(record.vscode.path);
  const description = record.vscode.description;
  const descriptionNow = hasOwn(code.data, description.key) ? code.data[description.key] : null;
  const descriptionChange: KeyChange =
    description.written === null
      ? { edit: null, why: 'the install left it alone, so uninstall does too' }
      : planKeyRestore(
          { key: description.key, existed: description.existed, previous: description.previous, written: description.written },
          descriptionNow,
        );
  const codeEdits: SettingsEdit[] = descriptionChange.edit === null ? [] : [descriptionChange.edit];

  return Object.freeze({
    mode: 'uninstall',
    root: context.root,
    platform: record.platform,
    tablePath: record.table.path,
    registrations: record.table.registrations,
    deploy: Object.freeze([]),
    discard: Object.freeze([
      ...Object.keys(record.deployed).map((name) => join(context.root, name)),
      recordPathFor(context.root),
    ]),
    recordPath: recordPathFor(context.root),
    record,
    files: Object.freeze([
      plannedFile(CLAUDE_LABEL, claude, edits, record.claude.existed === false, record.claude.backup),
      plannedFile(VSCODE_LABEL, code, codeEdits, record.vscode.existed === false, record.vscode.backup),
    ] as const),
    changes: Object.freeze({
      restored: Object.freeze(restored),
      standing: Object.freeze(standing),
      dropped: Object.freeze(dropped),
      progress: progressChange,
      description: descriptionChange,
    }),
  });
}

/** Put one key back: to what it was, or gone entirely -- unless the member has changed it since. */
function planKeyRestore(key: KeyRecord, current: unknown): KeyChange {
  if (!sameJson(current, key.written)) {
    return {
      edit: null,
      why: `left alone: it now reads ${JSON.stringify(current)}, not the ${JSON.stringify(key.written)} this install wrote`,
    };
  }
  if (key.existed) {
    return { edit: { path: [key.key], value: key.previous }, why: `back to ${JSON.stringify(key.previous)}` };
  }
  return { edit: { path: [key.key], remove: true }, why: 'deleted -- it was absent before the install' };
}

// ---------------------------------------------------------------------------- preview

/** The button that says yes to each mode, in the dialog and in the preview's last line. */
const ACTIONS: Readonly<Record<Plan['mode'], string>> = Object.freeze({
  install: 'Install',
  uninstall: 'Uninstall',
});

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function previewInstall(plan: InstallPlan, lines: string[]): void {
  lines.push('deploy into the root FIRST, before a byte of settings is written');
  for (const file of plan.deploy) lines.push(`  ${file.name.padEnd(20)} sha256 ${file.sha256}`);
  lines.push(
    `  ${`${MUTE_DIRNAME}/`.padEnd(20)} made if absent, and left by an uninstall: a pane is muted while ` +
      `${join(plan.root, MUTE_DIRNAME, '<claude pid>')} exists`,
  );
  lines.push('');

  const { removed, added, progress, description } = plan.changes;
  lines.push(`Claude Code settings   ${plan.files[0].path}${plan.files[0].exists ? '' : '   (does not exist yet)'}`);
  lines.push(`  remove ${plural(removed.length, 'hook entry', 'hook entries')} already marking this terminal:`);
  for (const entry of removed) {
    lines.push(`    ${entry.event}[${entry.group_index}].hooks[${entry.hook_index}]`);
    lines.push(indent(JSON.stringify(entry.entry), '      '));
  }
  lines.push(`  add ${plural(added.length, 'hook entry', 'hook entries')}, one per registration in the table:`);
  for (const entry of added) {
    const where = entry.matcher === null ? entry.event : `${entry.event}  (matcher ${entry.matcher})`;
    lines.push(`    ${where}   shape ${entry.shape}`);
    lines.push(indent(JSON.stringify(entry.entry), '      '));
    if (entry.shape === 'shell') {
      lines.push(`      before its mark, the one-liner checks ${IGNORE_ENV} and then the pane's marker in ${MUTE_DIRNAME}/,`);
      lines.push('      by existence alone: a muted pane gets its event file and no mark');
    }
  }
  lines.push(
    `  ${progress.key} -> false   (${progress.existed ? `was ${JSON.stringify(progress.previous)}; uninstall restores it` : 'absent before; uninstall deletes it'})`,
  );
  lines.push('');
  lines.push(`VS Code settings       ${plan.files[1].path}${plan.files[1].exists ? '' : '   (does not exist yet)'}`);
  lines.push(`  ${description.key}`);
  lines.push(`    ${description.why}`);
  lines.push(`    now:  ${JSON.stringify(description.previous)}`);
  lines.push(`    next: ${JSON.stringify(description.written === null ? description.previous : description.written)}`);
}

/** Said only when it changes what is written, so an ordinary uninstall reads as it always has. */
function pushOriginal(file: PlannedFile, lines: string[]): void {
  if (file.originalFrom === null) return;
  lines.push('  the result is the file as it was before the install in everything but layout, so its');
  lines.push(`  original bytes go back exactly, from ${file.originalFrom}`);
}

function previewUninstall(plan: UninstallPlan, lines: string[]): void {
  const { restored, standing, dropped, progress, description } = plan.changes;
  lines.push(`record                 ${plan.recordPath}  (installed ${plan.record.installed_at})`);
  lines.push('');
  lines.push(`Claude Code settings   ${plan.files[0].path}`);
  lines.push(`  remove ${plural(dropped.length, 'hook entry', 'hook entries')} this install added`);
  lines.push(`  put back ${plural(restored.length, 'hook entry', 'hook entries')} this install removed:`);
  for (const entry of restored) {
    lines.push(`    ${entry.event}[${entry.group_index}].hooks[${entry.hook_index}]`);
    lines.push(indent(JSON.stringify(entry.entry), '      '));
  }
  if (standing.length > 0) {
    lines.push(`  leave ${plural(standing.length, 'hook entry', 'hook entries')} this install removed, already back where it sat:`);
    for (const entry of standing) {
      lines.push(`    ${entry.event}[${entry.group_index}].hooks[${entry.hook_index}]`);
      lines.push(indent(JSON.stringify(entry.entry), '      '));
    }
  }
  lines.push(`  ${plan.record.claude.progress.key}: ${progress.why}`);
  pushOriginal(plan.files[0], lines);
  lines.push('');
  lines.push(`VS Code settings       ${plan.files[1].path}`);
  lines.push(`  ${plan.record.vscode.description.key}: ${description.why}`);
  pushOriginal(plan.files[1], lines);
  lines.push('');
  lines.push('discard');
  for (const path of plan.discard) lines.push(`  ${path}`);
  lines.push(`  (the backups under ${join(plan.root, BACKUPS_DIRNAME)} are kept)`);
}

/**
 * The whole plan in words: every entry removed and added, in full, and both keys before and
 * after. `stage` is the command line's `--dry-run` flag as a boolean, or `confirm` for the
 * extension, which shows this before it asks and so says nothing has been written yet.
 */
export function renderPreview(plan: Plan, stage: boolean | PreviewStage): string {
  const at: PreviewStage = stage === true ? 'dry-run' : stage === false ? 'writing' : stage;
  const title = { 'dry-run': ' · dry run', writing: '', confirm: ' · preview' }[at];
  const lines = [`pane-pulse · ${plan.mode}${title}`, ''];
  lines.push(`root                   ${plan.root}`);
  lines.push(`platform               ${plan.platform}`);
  lines.push(`decision table         ${plan.tablePath}  (${plan.registrations} registrations)`);
  lines.push('');
  if (plan.mode === 'install') previewInstall(plan, lines);
  else previewUninstall(plan, lines);
  lines.push('');
  lines.push(
    {
      'dry-run': 'nothing was written (--dry-run).',
      writing: 'writing.',
      confirm: `nothing has been written yet, and nothing will be unless you choose ${ACTIONS[plan.mode]}.`,
    }[at],
  );
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------- the question

function progressWords(plan: InstallPlan): string {
  return plan.files[0].edits.some((edit) => edit.path[0] === PROGRESS_KEY)
    ? "turns Claude Code's own progress bar off, so the marks are pane-pulse's alone"
    : "leaves Claude Code's own progress bar off, as it already is";
}

function descriptionWords(description: DescriptionRecord): string {
  return description.written === null
    ? `already shows ${PROGRESS_TOKEN}, so it is left exactly as it is`
    : `becomes ${JSON.stringify(description.written)}, so each tab has somewhere to show its mark`;
}

/** An install, with the words its dialog asks over. `plan` is what a yes commits, nothing else. */
export function proposeInstall(context: InstallContext): Proposal {
  const plan = planInstall(context);
  const { removed, added, description } = plan.changes;
  const detail = [
    `${CLAUDE_LABEL} (${plan.files[0].path}): takes out ` +
      `${plural(removed.length, 'hook entry', 'hook entries')} that already mark your terminal tabs, ` +
      `adds ${plural(added.length, 'entry', 'entries')} of pane-pulse's own, and ${progressWords(plan)}.`,
    `${VSCODE_LABEL} (${plan.files[1].path}): the terminal tab description ${descriptionWords(description)}.`,
    `Both files are backed up first, under ${join(plan.root, BACKUPS_DIRNAME)}, and Uninstall puts ` +
      'back exactly what it changed.',
    'Every entry is listed in full in the preview open in the editor.',
  ].join('\n\n');
  return Object.freeze({
    plan,
    preview: renderPreview(plan, 'confirm'),
    summary: "Install Pane Pulse's hooks into your Claude Code and VS Code settings?",
    detail,
    action: ACTIONS.install,
  });
}

/** An uninstall, from the record, with the words its dialog asks over. */
export function proposeUninstall(context: UninstallContext): Proposal {
  const plan = planUninstall(context);
  const { restored, dropped, progress, description } = plan.changes;
  const detail = [
    `${CLAUDE_LABEL} (${plan.files[0].path}): takes out the ` +
      `${plural(dropped.length, 'hook entry', 'hook entries')} the install added and puts back the ` +
      `${plural(restored.length, 'entry', 'entries')} it took out. ${PROGRESS_KEY}: ${progress.why}.`,
    `${VSCODE_LABEL} (${plan.files[1].path}): the terminal tab description: ${description.why}.`,
    'Both files are backed up first. The deployed hook and the install record go; the backups ' +
      `under ${join(plan.root, BACKUPS_DIRNAME)} stay.`,
    'Every entry is listed in full in the preview open in the editor.',
  ].join('\n\n');
  return Object.freeze({
    plan,
    preview: renderPreview(plan, 'confirm'),
    summary: "Uninstall Pane Pulse's hooks from your Claude Code and VS Code settings?",
    detail,
    action: ACTIONS.uninstall,
  });
}

/** What a commit did, in one message a person can act on. */
export function describeCommit(result: CommitResult): string {
  const backups = result.backups
    .map((file) =>
      file.backup === null
        ? `${file.label} did not exist, so there was nothing to back up`
        : `${file.label} to ${file.backup}`,
    )
    .join('; ');
  return result.mode === 'install'
    ? `Pane Pulse's hooks are installed. Backed up first: ${backups}. New Claude panes carry the ` +
        'marks; a pane already running may need a restart to pick them up.'
    : `Pane Pulse's hooks are uninstalled. What the files held a moment ago is backed up: ${backups}.`;
}

// ---------------------------------------------------------------------------- commit

/**
 * Refuse a plan whose inputs moved after it was made. The extension's preview waits on a
 * person, and in that time Claude Code may rewrite its own settings (a permission granted in any
 * pane does it) or the extension may be rebuilt. Writing the planned text then would silently
 * drop that change; refusing costs one more run.
 */
function assertCurrent(plan: Plan): void {
  for (const file of plan.files) {
    const now = existsSync(file.path) ? readFileSync(file.path, 'utf8') : null;
    const then = file.exists ? file.text : null;
    if (now !== then) {
      fail(
        `${file.path} changed after this plan was made, so its preview no longer says what would ` +
          'be written. Nothing was written; run it again to see the new preview.',
      );
    }
  }
  for (const file of plan.deploy) {
    if (!existsSync(file.from) || sha256Of(readFileSync(file.from)) !== file.sha256) {
      fail(
        `the hook source ${file.from} changed after this plan was made. Nothing was written; ` +
          'run it again to see the new preview.',
      );
    }
  }
}

/**
 * The exact bytes one deployed file will carry, read once: they are what the record's sha256
 * says, or nothing is written. assertCurrent() checked the same, a moment earlier; reading the
 * bytes once and writing those leaves no gap for the source to change in between.
 */
function deployableBytes(file: DeployedFile): Buffer {
  const bytes = readFileSync(file.from);
  if (sha256Of(bytes) !== file.sha256) {
    fail(
      `the hook source ${file.from} changed after this plan was made. Nothing was written; ` +
        'run it again to see the new preview.',
    );
  }
  return bytes;
}

function isEmptyObject(text: string): boolean {
  const parsed: unknown = parseJsonc(text, [], { allowTrailingComma: true });
  return Object.keys(isObject(parsed) ? parsed : {}).length === 0;
}

/**
 * Carry a plan out: check it is still current, back both files up, deploy, edit, then write or
 * discard the record. Every step can throw, and each one that can runs before the next write,
 * so a failure leaves the member's files as the last completed step left them.
 */
export function commit(plan: Plan): CommitResult {
  assertNotInBrain(plan.root);
  assertCurrent(plan);
  const deployBytes = plan.deploy.map(deployableBytes);

  // A failed backup aborts the write: backup() throws, and nothing below has run yet.
  const backups = plan.files.map((file) => backup(file.path, { root: plan.root }));

  mkdirSync(plan.root, { recursive: true });
  // Temp file then rename, through the same primitive the settings go through: the hook is
  // live the moment it lands, and Claude Code may run it while this loop is still going.
  plan.deploy.forEach((file, index) => writeFileAtomic(file.to, deployBytes[index]));
  // The event files the hook drops, and the mute markers the extension writes and the hook stats.
  // An uninstall leaves both folders as they are: what is in them is the extension's.
  if (plan.mode === 'install') {
    for (const folder of [EVENTS_DIRNAME, MUTE_DIRNAME]) {
      mkdirSync(assertNotInBrain(join(plan.root, folder)), { recursive: true });
    }
  }

  for (const file of plan.files) {
    if (file.edits.length === 0) continue;
    // A file this install brought into being goes with the last key of ours inside it.
    if (file.removeIfEmpty && isEmptyObject(file.result)) {
      rmSync(assertNotInBrain(file.path), { force: true });
      continue;
    }
    writeFileAtomic(file.path, file.result);
  }

  // A re-install keeps the first install's backups on record: they are the pre-install bytes
  // an uninstall may put back, and this run's backups hold pane-pulse's own earlier entries.
  let record = plan.record;
  if (plan.mode === 'install' && plan.firstInstall) {
    record = {
      ...plan.record,
      claude: { ...plan.record.claude, backup: backups[0] },
      vscode: { ...plan.record.vscode, backup: backups[1] },
    };
  }
  if (plan.mode === 'install') {
    writeFileAtomic(plan.recordPath, `${JSON.stringify(record, null, 2)}\n`);
  } else {
    for (const path of plan.discard) rmSync(assertNotInBrain(path), { force: true });
  }

  return Object.freeze({
    mode: plan.mode,
    root: plan.root,
    backups: Object.freeze(
      plan.files.map((file, index) =>
        Object.freeze({ label: file.label, path: file.path, backup: backups[index] }),
      ),
    ),
    record,
  });
}

// ---------------------------------------------------------------------------- restore

/** The two files the installer edits, which are the only two the restore command offers. */
export function editedFiles(locations: Pick<Locations, 'claudeSettings' | 'vscodeSettings'>): readonly EditedFile[] {
  return Object.freeze([
    Object.freeze({ label: CLAUDE_LABEL, path: locations.claudeSettings }),
    Object.freeze({ label: VSCODE_LABEL, path: locations.vscodeSettings }),
  ]);
}

/** `20260920T101112.345Z~1.json` -> that instant; null for a name that is not a stamp. */
export function stampDate(name: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z/.exec(name);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, ms] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A file's backups, NEWEST FIRST, each with the moment its stamp names. */
export function backupChoices(file: string, root: string): readonly BackupChoice[] {
  return Object.freeze(
    list(file, { root }).map((path) => {
      const name = basename(path);
      return Object.freeze({ path, name, takenAt: stampDate(name) });
    }),
  );
}

/**
 * When a backup was taken, in the member's local time. The stamps are UTC so they sort; a
 * person choosing one reads their own clock. `timeZone` is injected by the tests.
 */
export function describeStamp(choice: BackupChoice, timeZone?: string): string {
  if (choice.takenAt === null) return choice.name;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium', timeZone }).format(
    choice.takenAt,
  );
}

/** The restore dialog's words: which file each chosen backup will overwrite. */
export function restoreQuestion(
  picks: readonly RestorePick[],
  timeZone?: string,
): { readonly summary: string; readonly detail: string } {
  const lines = picks.map(
    (pick) =>
      `${pick.file.label} (${pick.file.path}) is overwritten with the backup taken ` +
      `${describeStamp(pick.choice, timeZone)} (${pick.choice.path}).`,
  );
  lines.push(
    'What each file holds now is backed up first, so this restore can itself be undone. ' +
      "Pane Pulse's install record is not changed by a restore.",
  );
  return Object.freeze({
    summary:
      picks.length === 1
        ? `Restore your ${picks[0].file.label} from a backup?`
        : `Restore ${plural(picks.length, 'settings file', 'settings files')} from backups?`,
    detail: lines.join('\n\n'),
  });
}

/**
 * Roll one file back to the chosen backup, through backup.ts's restore(), which backs the
 * current state up first. The WHOLE file name is passed as the stamp, so the backup picked is
 * exactly the one restored: restore() tries an exact file name first, then an exact stamp, and
 * only then a prefix, which it refuses when two backups share it. A backup that has gone since
 * it was picked is therefore refused by name, never swapped for a neighbour.
 */
export function restorePick(pick: RestorePick, root: string): string {
  return restore(pick.file.path, { root, stamp: pick.choice.name });
}
