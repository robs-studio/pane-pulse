// The three settings commands: install the hooks, uninstall them, restore a backup.
//
// Each one writes the member's own configuration, so each one asks first, and a dismissal is
// a no. Everything they decide (the plan, the preview, the words of every question, which
// backup overwrites which file) is in installer.ts, which has no vscode import, so node --test
// holds it to the plan. This file only shows those words and carries out the answer, so it is
// checked by typecheck, by the build and by a stub smoke of the bundle: logic added here is
// logic no unit test reaches.
//
// Four rules this file is built around:
//
//   * NOTHING IS WRITTEN WITHOUT A YES. Install and uninstall show the installer's own
//     preview, then ask in a modal; only the one button that names the action commits, and
//     the plan committed is the plan previewed (commit() refuses one whose files moved since).
//     Restore picks a backup per file, says which file each will overwrite, and asks the same.
//   * THE PREVIEW IS A READ-ONLY DOCUMENT. It is served by a content provider under its own
//     scheme rather than opened as an untitled file: an untitled file is editable, so it could
//     be read as the thing that will be written, and closing it asks to save it. The output
//     channel was the other road, but it stamps every line and sits in a panel the modal then
//     covers. The preview is logged there as well, so what was agreed to stays on record.
//   * THE EXTENSION DEPLOYS ITS OWN COPY. The hook source is `<extension>/dist/hook/`, which
//     esbuild.mjs fills and .vscodeignore ships, never the repo's hook/ (installer.ts's header
//     says why that path is a parameter).
//   * A COMMAND NEVER THROWS. Every failure is logged in full and shown in plain words; a
//     rejection escaping a command handler would surface as VS Code's own unexplained error.
import type { Disposable, ExtensionContext, QuickPickItem, TextDocumentContentProvider } from 'vscode';
import { EventEmitter, Uri, commands, window, workspace } from 'vscode';

import {
  backupChoices,
  commit,
  describeCommit,
  describeStamp,
  editedFiles,
  extensionHookDir,
  hasInstallRecord,
  proposeInstall,
  proposeUninstall,
  recordPathFor,
  resolveContext,
  resolveLocations,
  restorePick,
  restoreQuestion,
} from './installer.ts';
import type { BackupChoice, Proposal, RestorePick } from './installer.ts';

/** The three command ids package.json contributes; installer.test.mjs holds the two in step. */
export const INSTALL_HOOKS_COMMAND = 'panePulse.installHooks';
export const UNINSTALL_HOOKS_COMMAND = 'panePulse.uninstallHooks';
export const RESTORE_BACKUPS_COMMAND = 'panePulse.restoreBackups';

/** The read-only preview documents live under this scheme, one per command. */
const PREVIEW_SCHEME = 'pane-pulse-preview';

/** The restore dialog's yes. */
const RESTORE_ACTION = 'Restore';

/** Every line this module logs opens with this, so it reads plainly in the output channel. */
const LOG_PREFIX = 'pane-pulse commands: ';

/** The installer's own refusals open with a prefix a person does not need to read twice. */
const MESSAGE_PREFIX = /^pane-pulse[^:]*:\s*/;

/** A line to the output channel. The wiring's own, which never throws. */
export type Log = (line: string) => void;

/** One row of a restore pick: a backup, or the choice to leave that file alone. */
type BackupItem = QuickPickItem & { readonly choice: BackupChoice | null };

/**
 * The previews, served read-only. One document per command, refreshed in place, so running a
 * command twice shows the new preview in the same tab rather than stacking stale ones.
 */
class PreviewDocuments implements TextDocumentContentProvider, Disposable {
  readonly #texts = new Map<string, string>();
  readonly #changed = new EventEmitter<Uri>();

  readonly onDidChange = this.#changed.event;

  provideTextDocumentContent(uri: Uri): string {
    return this.#texts.get(uri.path) ?? '';
  }

  /** Open (or refresh) the named preview in the editor. Throws if it cannot be shown. */
  async show(name: string, text: string): Promise<void> {
    const uri = Uri.from({ scheme: PREVIEW_SCHEME, path: `/${name}` });
    this.#texts.set(uri.path, text);
    this.#changed.fire(uri);
    const document = await workspace.openTextDocument(uri);
    await window.showTextDocument(document, { preview: false });
  }

  dispose(): void {
    this.#changed.dispose();
    this.#texts.clear();
  }
}

/** Shown without ever throwing: a message that cannot be shown is logged and dropped. */
function tell(show: (message: string) => Thenable<unknown>, message: string, log: Log): void {
  try {
    void Promise.resolve(show(message)).then(undefined, (error: unknown) =>
      log(`${LOG_PREFIX}could not show a message: ${String(error)}`),
    );
  } catch (error) {
    log(`${LOG_PREFIX}could not show a message: ${String(error)}`);
  }
}

/** Runs one command's flow; any failure is logged in full and shown in plain words. */
async function guarded(what: string, log: Log, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const full = error instanceof Error && error.stack !== undefined ? error.stack : message;
    log(`${LOG_PREFIX}could not ${what}: ${full}`);
    tell((text) => window.showErrorMessage(text), `Pane Pulse could not ${what}. ${message.replace(MESSAGE_PREFIX, '')}`, log);
  }
}

/** Preview, ask, and commit only on the proposal's own yes. */
async function askAndCommit(
  proposal: Proposal,
  previewName: string,
  previews: PreviewDocuments,
  log: Log,
): Promise<void> {
  log(`${LOG_PREFIX}asking before ${proposal.plan.mode}:\n${proposal.preview}`);
  await previews.show(previewName, proposal.preview);
  const answer = await window.showWarningMessage(
    proposal.summary,
    { modal: true, detail: proposal.detail },
    proposal.action,
  );
  if (answer !== proposal.action) {
    log(`${LOG_PREFIX}${proposal.plan.mode} not confirmed; nothing was written`);
    return;
  }
  const result = commit(proposal.plan);
  const message = describeCommit(result);
  log(`${LOG_PREFIX}${message}`);
  tell((text) => window.showInformationMessage(text), message, log);
}

async function installHooks(hookDir: string, env: NodeJS.ProcessEnv, previews: PreviewDocuments, log: Log): Promise<void> {
  await askAndCommit(proposeInstall(resolveContext(hookDir, env)), 'Pane Pulse install preview.txt', previews, log);
}

async function uninstallHooks(env: NodeJS.ProcessEnv, previews: PreviewDocuments, log: Log): Promise<void> {
  const { root } = resolveLocations(env);
  if (!hasInstallRecord(root)) {
    const message =
      `Pane Pulse has nothing to uninstall: there is no install record at ${recordPathFor(root)}, ` +
      'so nothing was changed.';
    log(`${LOG_PREFIX}${message}`);
    tell((text) => window.showInformationMessage(text), message, log);
    return;
  }
  await askAndCommit(proposeUninstall({ root }), 'Pane Pulse uninstall preview.txt', previews, log);
}

async function restoreBackups(env: NodeJS.ProcessEnv, log: Log): Promise<void> {
  const locations = resolveLocations(env);
  const files = editedFiles(locations);
  const picks: RestorePick[] = [];
  let offered = 0;

  for (const [index, file] of files.entries()) {
    const choices = backupChoices(file.path, locations.root);
    if (choices.length === 0) {
      log(`${LOG_PREFIX}no backups of ${file.path} yet`);
      continue;
    }
    offered += 1;
    const items: BackupItem[] = [
      ...choices.map((choice) => ({ label: describeStamp(choice), description: choice.name, detail: choice.path, choice })),
      { label: "Don't restore this file", description: `leave ${file.path} as it is`, choice: null },
    ];
    const picked = await window.showQuickPick(items, {
      title: `Pane Pulse: restore ${file.label} (${index + 1} of ${files.length})`,
      placeHolder: `Choose a backup of ${file.path}, newest first`,
      ignoreFocusOut: true,
    });
    if (picked === undefined) {
      log(`${LOG_PREFIX}restore dismissed; nothing was written`);
      return;
    }
    if (picked.choice !== null) picks.push({ file, choice: picked.choice });
  }

  if (picks.length === 0) {
    const message =
      offered === 0
        ? 'Pane Pulse has no backups yet. Install and Uninstall back each settings file up before ' +
          'they change it, and those backups are what this restores.'
        : 'No backup was chosen, so nothing was changed.';
    log(`${LOG_PREFIX}${message}`);
    tell((text) => window.showInformationMessage(text), message, log);
    return;
  }

  const question = restoreQuestion(picks);
  log(`${LOG_PREFIX}asking before restore:\n${question.detail}`);
  const answer = await window.showWarningMessage(question.summary, { modal: true, detail: question.detail }, RESTORE_ACTION);
  if (answer !== RESTORE_ACTION) {
    log(`${LOG_PREFIX}restore not confirmed; nothing was written`);
    return;
  }
  const restored = picks.map(
    (pick) => `${pick.file.label} (${restorePick(pick, locations.root)}) to its backup from ${describeStamp(pick.choice)}`,
  );
  const message = `Pane Pulse restored ${restored.join('; ')}. What each file held a moment ago is backed up too.`;
  log(`${LOG_PREFIX}${message}`);
  tell((text) => window.showInformationMessage(text), message, log);
}

/**
 * Registers the three settings commands and the preview provider, and answers what the caller
 * must dispose. `env` is injected so a smoke can point every path at copies; production takes
 * the extension host's own environment, where the same overrides still apply.
 */
export function registerCommands(
  context: Pick<ExtensionContext, 'extensionPath'>,
  log: Log,
  env: NodeJS.ProcessEnv = process.env,
): readonly Disposable[] {
  const previews = new PreviewDocuments();
  const hookDir = extensionHookDir(context.extensionPath);
  return Object.freeze([
    previews,
    workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previews),
    commands.registerCommand(INSTALL_HOOKS_COMMAND, () =>
      guarded('install the hooks', log, () => installHooks(hookDir, env, previews, log)),
    ),
    commands.registerCommand(UNINSTALL_HOOKS_COMMAND, () =>
      guarded('uninstall the hooks', log, () => uninstallHooks(env, previews, log)),
    ),
    commands.registerCommand(RESTORE_BACKUPS_COMMAND, () =>
      guarded('restore a backup', log, () => restoreBackups(env, log)),
    ),
  ]);
}
