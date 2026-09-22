# AGENT-UNINSTALL.md: removing Pane Pulse

This file is the removal procedure for a **coding agent** working in someone's terminal.
A person doing it by hand can follow it too; the README's "Uninstall" section is the shorter version for that.

Read the whole file before running anything.
**The order matters three times over**: untick before removing the extension, or one setting can never be put back; roll back before removing anything, because removal closes that road; and undo the hooks before deleting the folder the record lives in.

## Read this first

Pane Pulse remembers how to put things back in two different places:

1. **`~/.pane-pulse/install-record.json`** holds every hook entry added, every entry removed, both settings' previous values, and where the backups are. The uninstaller works from this file alone.
2. **VS Code's own storage for this extension** holds one thing: the value `terminal.integrated.environmentChangesIndicator` had before the extension set it to `off`. **Removing the extension destroys that storage.**

So the order is forced: **untick the checkbox before removing the extension**, and **undo the hooks before deleting `~/.pane-pulse`**.

If the person has never ticked `panePulse.terminal.disableEnvironmentChangeIndicator`, step 1 is a no-op and you can pass over it, but check rather than assume.

Throughout, `<repo>` is the absolute path to the project folder, and `<root>` is Pane Pulse's own folder, `~/.pane-pulse` unless `PANE_PULSE_HOME` was set at install time. Use the same value the install used: the install record's `root` field is the authority. If nothing is at the path below, ask which `PANE_PULSE_HOME` the install ran with, because the record lives inside the very folder you are looking for.

```sh
cat "$HOME/.pane-pulse/install-record.json" | head -20
```

## Step 1. Untick the environment-change checkbox, while the extension is still installed

Check whether it is on:

```sh
grep -n "disableEnvironmentChangeIndicator" "$HOME/Library/Application Support/Code/User/settings.json"
```

On Linux that file is at `~/.config/Code/User/settings.json`, on Windows at `%APPDATA%\Code\User\settings.json`. The extension reads the *effective* value, so a `true` in the workspace's own `.vscode/settings.json`, or in a non-default profile, keeps it ticked even when the user file reads `false`. The safe read is the checkbox itself in the Settings UI.

If it reads `true`, ask the person to untick **Pane Pulse → Terminal → Disable Environment Change Indicator** in VS Code's settings, or set it to `false` in that file.
The extension notices, puts `terminal.integrated.environmentChangesIndicator` back to whatever it was, and forgets it.
**VS Code has to be running with Pane Pulse active for that to happen.** Editing the file with VS Code closed changes the checkbox and restores nothing, and the value is then lost at step 5. If it was closed, start it once and read the file again.

**Then read the file again rather than taking the answer on trust.** A person can untick a box in a different window, or in a profile whose settings live elsewhere, and the value you are about to rely on is unchanged. If it still reads `true`, say so and settle it before going on; editing the value to `false` yourself is the same change, if they would rather you did it.

Then confirm the indicator key is back to its old value, or absent if it was never set:

```sh
grep -n "environmentChangesIndicator" "$HOME/Library/Application Support/Code/User/settings.json"
```

**Only move on once this is settled.** After step 5 the old value is gone for good, and the person is left with a setting neither of you can put back.

## Step 2. Undo the hooks: preview, ask, then run

**2a. Preview. Writes nothing:**

```sh
node "<repo>/scripts/install-hooks.mjs" --uninstall --dry-run
```

**2b. Show the person the output and ask.** Two things in it deserve saying out loud:

- Any hook the install had removed is **put back** where it was. If they had hand-rolled indicator hooks before installing, those return, and that is correct.
- A setting is left alone if it no longer reads what the install wrote, and the preview says so in its own words. In particular, if `terminal.integrated.tabs.description` already contained `${progress}` before the install, Pane Pulse never wrote it and the uninstall will not touch it.

**2c. On a clear yes:**

```sh
node "<repo>/scripts/install-hooks.mjs" --uninstall
```

Expect `done · uninstall`.

It backs both settings files up again before changing them, so this step is itself undoable.

If it refuses with `no install record at <path>`, the root is wrong: read the real one out of the record, or set `PANE_PULSE_HOME` to what the install used, and run again.

There is also **Pane Pulse: Uninstall Hooks** in the Command Palette, which previews and asks in a dialog. A human can use it; an agent cannot click the dialog.

## Step 3. Verify the hooks are gone

```sh
node "<repo>/scripts/prove-local.mjs" --check-only
```

Expect **exit code 1** and a verdict beginning:

```
verdict: pane-pulse is NOT installed here: there is no install record, no deployed hook and no pane-pulse hook in Claude Code's settings.
```

If you get `installed, but N of 4 checks fail` instead, read the FAIL lines: something Pane Pulse shaped is still in Claude Code's settings, most likely a second install made under a different `PANE_PULSE_HOME`. Undo that one too, with that value set.

A non-zero exit is the **success** condition here. Do it now rather than later: once the record is gone you can no longer tell a clean uninstall from a record someone deleted by hand.

## Step 4. Your last chance to roll back, before anything is removed

Every backup ring lives at `<root>/backups/<slug>-<hash>/`, holds copies named by UTC time, and carries a `.origin` file naming the path it came from.

```sh
for d in "$HOME/.pane-pulse/backups/"*/; do echo "== $d"; cat "$d.origin"; ls "$d"; done
```

**Read this step even if nothing looks wrong.** The kind road is **Pane Pulse: Restore Backups** in the Command Palette, which lists each file's copies newest first and asks before writing. It needs the extension, which step 5 removes, and the backups, which step 7 deletes. After those two steps, this road is gone.

By hand, copy the chosen file over the path named in that ring's `.origin`, after copying the current file somewhere safe first.

## Step 5. Remove the extension

```sh
code --uninstall-extension robs-studio.pane-pulse
```

On VS Code Insiders or VSCodium the CLI is `code-insiders` or `codium`, and the extensions folder below is that build's own (`~/.vscode-insiders/extensions` and so on).

Then sweep up any older version folders left behind by earlier installs:

```sh
ls -d "$HOME/.vscode/extensions/robs-studio.pane-pulse-"* 2>/dev/null
```

Delete any that remain, and check the extension is no longer listed:

```sh
code --list-extensions | grep -i pane-pulse || echo "gone"
```

The running window keeps the extension alive until it reloads, so the person may still see the panel until they reload or restart VS Code. Tell them; do not reload their window yourself, because that restarts every Claude Code pane in it.

## Step 6. Remove the leftover settings keys

The uninstaller never writes `panePulse.*` keys, so it cannot take them away either. They are harmless, and VS Code will grey them as unknown settings.

```sh
grep -n "panePulse" "$HOME/Library/Application Support/Code/User/settings.json"
```

Anything that comes back is one of: `panePulse.peek.enabled`, `panePulse.context.warnAtPercent`, `panePulse.context.alertAtPercent`, `panePulse.terminal.disableEnvironmentChangeIndicator`, `panePulse.about` (which the About row's "Edit in settings.json" link can write), or a `panePulse.*` colour under `workbench.colorCustomizations`.
Ask before removing them, and let the person edit their own settings file, or edit it only with their explicit yes.

## Step 7. Delete Pane Pulse's own folder, backups last

What is in `<root>` after step 2: `events/` (transient), `mute/` (one file per muted pane), `backups/` (dated copies of both settings files, thirty deep), and nothing else, because the uninstaller discarded the deployed hook and the record.

```sh
ls -la "$HOME/.pane-pulse"
ls "$HOME/.pane-pulse/mute" 2>/dev/null
```

**Before deleting anything, check `mute/`.** Each file is named for a live `claude` process id; deleting one unmutes that pane.

**`backups/` is the only copy of the settings files as they were before Pane Pulse ever ran.** Keep it until the person is satisfied that everything is back the way they want it. Copy it somewhere of their choosing if they want to keep it after the folder goes:

```sh
cp -R "$HOME/.pane-pulse/backups" "$HOME/pane-pulse-backups"
```

Then, with their yes:

```sh
rm -rf "$HOME/.pane-pulse"
```

If VS Code is still running with the extension loaded, it may recreate an empty `<root>/events/` folder. That is harmless; delete it again after they reload, or leave it.

## What a complete removal does and does not reach

**Put back, not deleted** (step 2 does all of this):

- every hook entry the install had removed, at its original position;
- `terminalProgressBarEnabled`, to its previous value, or deleted if it was absent before;
- `terminal.integrated.tabs.description`, to its previous value, unless the install left it alone, in which case the uninstall leaves it alone too.

**Deleted** (step 2): `<root>/hook.js`, `<root>/decision-table.json`, `<root>/package.json`, `<root>/install-record.json`.

**Either settings key the uninstall preview reported as "left alone"**, because it no longer reads what the install wrote: someone changed it after installing, so the uninstall will not touch it. Read those lines out of the preview and offer to put them back by hand.

**Left behind by design, and yours to clear by hand**: `<root>` itself with `backups/`, `events/` and `mute/` (step 7); the `panePulse.*` settings keys (step 6); the installed extension (step 5); and `terminal.integrated.environmentChangesIndicator` if the checkbox was still ticked when the extension went (step 1, which is why it comes first).

## Reinstalling afterwards

Start again at [AGENTS.md](AGENTS.md), step 1. A reinstall is a clean install: it makes a fresh root, fresh backups and a fresh record.
