# AGENTS.md: installing Pane Pulse

**Here to change this project's code? Read [CLAUDE.md](CLAUDE.md) instead; nothing below applies.**

This file is the install procedure for a **coding agent** working in someone's terminal: Claude Code, Codex, Cursor, or anything else that can run commands and read output.
A person following along by hand can use it too, but the README's "Install by hand" section is the friendlier road for that.

Read this file to the end before running anything.
The steps are ordered, and step 5 changes settings files that belong to the person you are working for.

## What you are installing

Pane Pulse is a VS Code extension that marks a Claude Code terminal tab while it is working and when it finishes in a pane you are not looking at.
It has two halves, and **both** must be installed or it does nothing:

1. **The extension**, which draws the Panes panel and clears marks, installed into VS Code.
2. **The hooks**, small entries in Claude Code's own settings that fire on each event and write the mark, installed into `~/.claude/settings.json` by this project's installer.

Installing the extension alone is the most common failure. It leaves a panel that lists nothing.

## The rules for this install

- **Never hand-edit the settings files.** The installer writes them atomically, backs them up first, and records every change so it can be undone exactly. A hand edit breaks that record and the uninstall then cannot put things back.
- **Always run the dry run first, show the person its output, and get a clear yes before the real run.** Step 5 is the only step that changes the person's settings.
- **Never run the two installers with `sudo`.** Everything is inside the person's home directory.
- **Do not use `cd X && …` chains.** Use absolute paths, `npm --prefix <dir>`, and `git -C <dir>`. Some environments block a folder-step followed by more commands, and absolute paths always work.
- **If a command fails, stop and read "When something goes wrong" at the bottom before retrying.** Do not loop on a failing command.

## Step 1. Check the prerequisites

```sh
code --version      # first line must be 1.138.0 or later
node --version      # must be v22.18.0 or later
git --version       # any recent version
claude --version    # Claude Code must be installed and set up
```

What each one is for:

| requirement | minimum | why |
|---|---|---|
| VS Code | 1.138.0 | the manifest's `engines.vscode`; VS Code refuses to install the extension below it |
| Node.js | 22.18 | the two installer scripts import TypeScript directly, which needs Node's type stripping |
| Claude Code | tested against 2.1.278 | the extension reads its session files, whose shape Anthropic does not document |
| `code` on the PATH | any | to install the extension from a terminal |
| `node` on the PATH **Claude Code itself uses** | any | eight of the nine hooks run `node <root>/hook.js`; if Claude Code cannot find `node`, only the `PostToolUse` spinner still draws |
| `sh`, `grep`, `printf`, `date`, `mkdir`, `mv` | any | the `PostToolUse` hook is a shell one-liner on macOS and Linux. On Windows it is written in the node form instead |
| `powershell` (Windows only) | any | how the extension finds which terminal a `claude` runs in |

If `code` is missing on macOS, the person can add it from VS Code: Command Palette → **Shell Command: Install 'code' command in PATH**.
If they run a different build, substitute its own CLI for `code` everywhere below (`code-insiders`, `codium`), use that build's own extensions folder (`~/.vscode-insiders/extensions` and so on), and set `PANE_PULSE_VSCODE_SETTINGS`, because its settings folder is not named `Code`.
If `node` is missing, stop and ask how they want Node installed; do not install a runtime on someone's machine on your own initiative.

Check the platform before promising anything:

- **macOS**: everything works.
- **Linux**: everything is built to work and nothing in the source blocks it, but it has never been run. Say so rather than promising.
- **Windows**: the panel and the hooks work, but the extension cannot clear a tab mark, so a finished pane's mark stays until the person's next message in that pane. Whether the mark draws at all under ConPTY has never been tested. Tell them this **before** installing, not after.

## Step 2. Get the source

The installer's command line and the verifier live in the repository, not in the packaged extension, so you need the source even if a `.vsix` is already to hand.

(If the person would rather not have a build on their machine at all, there is a shorter road they can walk themselves: download the `.vsix` from the project's latest release, install it, and run **Pane Pulse: Install Hooks** from the Command Palette, which previews and asks. Offer it, then stop; the dialog is theirs to click, not yours.) The installer itself does ship inside the extension, but the road that drives it there is a dialog only a human can click.

```sh
git clone https://github.com/robs-studio/pane-pulse.git "$HOME/pane-pulse"
```

Use any folder the person prefers; every command below takes the folder as an absolute path.
If they already have the source, use that folder and skip the clone.

**Tell them to keep that folder.** The verifier and the uninstaller both live in it, so a clone into a temporary directory leaves them with no way to check or remove the install.

Throughout the rest of this file, `<repo>` means that absolute path.

## Step 3. Build the extension

```sh
npm --prefix "<repo>" install
npm --prefix "<repo>" run package
```

`npm run package` builds first, then writes `pane-pulse-<version>.vsix` into `<repo>`.
Expect a final line like `DONE  Packaged: <repo>/pane-pulse-0.2.0.vsix`.


## Step 4. Install the extension into VS Code

**Name the file exactly. Never use a wildcard here:**

```sh
ls "<repo>"/*.vsix                                        # see what is actually there
code --install-extension "<repo>/pane-pulse-<version>.vsix" --force
```

A folder that has been built before can hold several `.vsix` files, and `pane-pulse-*.vsix` then hands VS Code more than one. It installs the wrong build and reports success, so you get an old version with no error to tell you. This has happened; take the version from the `DONE  Packaged:` line in step 3 and type it out.

Expect `Extension 'pane-pulse-<version>.vsix' was successfully installed.`
`--force` is what lets a rebuild replace the same version; without it VS Code refuses when that version is already there.

Confirm the right build is the one registered:

```sh
code --list-extensions --show-versions | grep pane-pulse
```

If an older version is listed, remove it and install the exact file again:

```sh
code --uninstall-extension robs-studio.pane-pulse
code --install-extension "<repo>/pane-pulse-<version>.vsix" --force
```

VS Code leaves the old version's folder behind under `~/.vscode/extensions/` and marks it obsolete; it is safe to delete once `code --list-extensions --show-versions` shows only the version you want.

This step changes nothing outside `~/.vscode/extensions/`.

The extension loads when VS Code next starts, or when the person runs **Developer: Reload Window**.
**Do not reload their window on your own initiative**: a reload restarts every terminal-hosted agent in that window, including possibly you. Tell them, and let them choose the moment.

## Step 5. The hooks: preview, ask, then install

This is the step that changes the person's settings. It has three parts and none of them may be skipped.

First, two things that change where it writes:

```sh
echo "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-<unset>}"   # set? then pass PANE_PULSE_CLAUDE_SETTINGS
```

And ask which VS Code profile they use: anything but the default needs `PANE_PULSE_VSCODE_SETTINGS`. Both are under "Flags and overrides" below.

**5a. Preview. Writes nothing:**

```sh
node "<repo>/scripts/install-hooks.mjs" --dry-run
```

On Node 22 this also prints `ExperimentalWarning: Type Stripping is an experimental feature` on stderr. That is expected: judge the run by its exit code, not by that line.

**5b. Show them the output and ask.** Summarise it in plain words: it adds nine hook entries to Claude Code's settings, turns Claude Code's own terminal progress bar off, and adds `${progress}` to VS Code's terminal tab description. Both settings files are backed up first. Say that it removes any earlier Pane Pulse or hand-rolled indicator hooks it finds, and name them if the preview lists any.

**5c. On a clear yes:**

```sh
node "<repo>/scripts/install-hooks.mjs"
```

Expect it to print the same preview and then `done · install`.

**The command-line installer never asks.** Without `--dry-run` it writes immediately. That is precisely why the yes has to come from the person, at 5b.

There is also a road that asks for itself: the Command Palette's **Pane Pulse: Install Hooks**, which opens a preview document and a modal dialog. A human can use it; an agent cannot click the dialog, which is why the command line is your road.

## Step 6. Verify

```sh
node "<repo>/scripts/prove-local.mjs" --check-only
```

This reads and never writes. Expect exit code 0 and a report ending in:

```
verdict: pane-pulse is installed, and all 4 checks hold.
```

The four checks are: every registration in the deployed decision table has exactly one Pane Pulse hook in Claude Code's settings, in the right shape for this platform; none of those hooks is async; the two settings keys read what they should; and the deployed hook files match their source by sha256 with the install record present and parseable.

Any other verdict means the install is not complete. The three others, and what each means:

| verdict | meaning |
|---|---|
| `pane-pulse is NOT installed here: …` | nothing is in place. Step 5 did not run, or it ran with a different `PANE_PULSE_HOME` |
| `pane-pulse is NOT installed the way its record says: … N of M hooks are gone …` | something rewrote Claude Code's settings after the install. Run step 5 again |
| `pane-pulse is installed, but N of 4 checks fail` | each `FAIL` line says what is wrong; fix that and re-run |

## Step 7. Report back

Tell the person, in this order:

1. That it is installed, and the verdict line from step 6 as proof.
2. That **the panel appears after they reload the window or restart VS Code**, and that a reload restarts every Claude Code pane in that window, so it is their call when.
3. That **Claude panes already running may need restarting** before they start marking, since a pane picks up new hooks when Claude Code re-reads its settings.
4. Where the panel is: the Pane Pulse icon in the activity bar, or Command Palette → **Pane Pulse: Show Panes**.
5. On Windows, repeat the tab-mark limitation from step 1.

## What the install changed, in exact terms

Report these accurately if you are asked. All of it is recorded in `~/.pane-pulse/install-record.json`, and all of it is reversible.

**In Claude Code's settings (`~/.claude/settings.json`):**

| key | change |
|---|---|
| `hooks` | nine entries added, one per registration in the decision table: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Notification`, `Stop`, `StopFailure`, `SessionEnd`. Each is synchronous with a 5 second timeout, because Claude Code honours a hook's terminal sequence only on the synchronous path |
| `hooks` | any earlier Pane Pulse entry, and any hand-rolled indicator hook, is **removed** and recorded verbatim so an uninstall can put it back |
| `terminalProgressBarEnabled` | set to `false`, so Claude Code's own progress bar can never compete with the tab marks. The previous value, or the fact that the key was absent, is recorded |

Eight of the nine entries are the exec form, `node <root>/hook.js`, which no shell parses, so a home folder with spaces or quotes is safe.
`PostToolUse` is a shell one-liner on macOS and Linux, because it fires on every tool call and starting Node each time would cost about a second a turn. On Windows, which has neither `sh` nor `printf`, it is written in the node form too.

**In VS Code's user settings:**

| key | change |
|---|---|
| `terminal.integrated.tabs.description` | gains `${progress}` once, prepended as `${progress}${separator}` in front of whatever was there, or in front of VS Code's own default if the key was never set or holds nothing usable. A value that already contains `${progress}` is **left exactly as it is**, and an uninstall then never touches it |

**On disk, under `<root>` (default `~/.pane-pulse`):**

`hook.js`, `decision-table.json` and a two-word `package.json` are deployed there; `events/` and `mute/` are created; `backups/` holds a dated copy of each settings file before each change, thirty deep; `install-record.json` records every addition, every removal, both settings' previous values, the sha256 of each deployed file, and where the backups went.

**Nothing else.** The installer never writes a `panePulse.*` setting, never touches the marketplace, and never installs anything globally.

## One setting the person may want, that the install does not touch

`panePulse.terminal.disableEnvironmentChangeIndicator` hides the warning triangle VS Code puts on a terminal tab when an extension wants to relaunch the terminal to change its environment.
Ticking it makes the extension set `terminal.integrated.environmentChangesIndicator` to `off` in their user settings; unticking it puts back what was there, unless that setting has been changed by hand since, which is left as they set it.

Offer it, do not set it silently, and know the trap: **the previous value is remembered inside VS Code's own storage for this extension**, not in the install record. If they ever remove the extension while the box is ticked, that memory goes with it and the old value cannot be restored. So if they tick it, tell them that unticking comes **before** uninstalling, not after.

The other three settings are ordinary preferences with safe defaults: `panePulse.peek.enabled` (`true`), `panePulse.context.warnAtPercent` (`50`), `panePulse.context.alertAtPercent` (`80`).

## Flags and overrides, for when the defaults are wrong

Set these in the environment of the command you run. Only reach for one when the matching condition is true.

| variable | set it when | what it changes |
|---|---|---|
| `PANE_PULSE_HOME` | the person wants Pane Pulse's files somewhere other than `~/.pane-pulse` | `<root>`. It must be the **same value** for the installer, for VS Code and for Claude Code, and you must re-run step 5 after changing it, because every hook entry has the root written into it at install time |
| `PANE_PULSE_CLAUDE_SETTINGS` | `CLAUDE_CONFIG_DIR` is set, so Claude Code's settings are not at `~/.claude/settings.json` | the installer's target for Claude Code's settings. **The installer does not read `CLAUDE_CONFIG_DIR`**, so on such a machine this override is required, not optional |
| `PANE_PULSE_VSCODE_SETTINGS` | they run VS Code Insiders, VSCodium or Code-OSS, **or a VS Code profile other than the default** | the installer's target for VS Code's settings. It assumes the default profile's file, in a product folder named `Code`. A profile's settings live at `…/Code/User/profiles/<id>/settings.json`, and a fork's are somewhere else entirely, so point this at the real file. Get it wrong and the install reports success, the verifier passes, and no tab ever shows a mark |
| `PANE_PULSE_IGNORE` | a pane should never be marked, such as an unattended loop | set it to `1` in that pane's own environment before `claude` starts: any value except empty or `0` mutes. It mutes that pane permanently and cannot be changed while it runs |

Check whether the first two apply before step 5:

```sh
echo "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-<unset>}"
ls -d "$HOME/Library/Application Support/Code/User" 2>/dev/null || ls -d "$HOME/.config/Code/User" 2>/dev/null
```

On Windows the VS Code settings live at `%APPDATA%\Code\User\settings.json`. The commands above are POSIX shell; under PowerShell use its own equivalents (`$env:CLAUDE_CONFIG_DIR`, `Test-Path`) rather than pasting them as they are.

## If you are working inside Glitch

Glitch is a local-first assistant whose folder is called a brain. Pane Pulse knows about it, and these five things are the whole difference.

1. **Pane Pulse refuses to write anywhere inside a brain.** Every write checks the target and every folder above it for `operations-reference.md`, and refuses with a message naming it. So `PANE_PULSE_HOME` can never point inside the brain, and the default `~/.pane-pulse` is correct. Do not try to work around the refusal; it is the protection working.
2. **The project usually lives at `<brain>/workspaces/pane-pulse`.** That is `<repo>` for every command above. Work there, never in the brain's own engine folders.
3. **Editing Claude Code's settings is allowed.** The brain guard covers the brain's own files, not `~/.claude/settings.json`, which is where the hooks belong.
4. **Glitch's `/look` restore rewrites both settings files**, which can strip the hooks while the install record still claims they are there. That is exactly what step 6 catches: run it after any `/look` change, and run step 5 again if the verdict says the hooks are gone.
5. **Installing from the repo, as this file tells you to, records the repo's `hook/` folder as the source.** If you later edit anything in `hook/`, step 6 reports the deployed copy as out of date, which is correct: run step 5 again to redeploy it.

6. **Getting the source, in Glitch:** `/import-workspace https://github.com/robs-studio/pane-pulse` puts it under `workspaces/` the sanctioned way and records it, which is better than a loose clone. Everything after that is the same.

Nothing else about Glitch matters here, and nothing in this file needs Glitch to work.

## When something goes wrong

| what you see | what it means | what to do |
|---|---|---|
| `no install record at <path>, so there is nothing to undo` | an uninstall ran against a different root | re-run with the same `PANE_PULSE_HOME` the install used |
| `refusing to write <path>: operations-reference.md marks <dir> as a Glitch brain` | a target is inside a Glitch brain | point `PANE_PULSE_HOME` at a folder outside it, such as the default `~/.pane-pulse` |
| the install refuses because a settings file changed between preview and answer | Claude Code rewrote its own settings in the meantime, which it does whenever a permission is granted in any pane | run the dry run again, show the fresh preview, ask again |
| `code: command not found` | the VS Code CLI is not on the PATH | macOS: Command Palette → **Shell Command: Install 'code' command in PATH** |
| step 6 says a hook is missing right after a clean install | something rewrote Claude Code's settings between the two steps | run step 5 again, then step 6 again |
| the panel works but no tab ever shows a mark, and step 6 passes | `${progress}` went into a different profile's or product's settings file | set `PANE_PULSE_VSCODE_SETTINGS` to the real file and run step 5 again |
| the panel lists nothing, and step 6 passes | the window has not reloaded since the extension was installed, or the running `claude` panes predate the hooks | ask them to reload the window when convenient, and to restart a pane that still shows nothing |
| the panel lists nothing inside tmux | tmux daemonises its server, so no VS Code shell is among the pane's ancestors | not supported on any platform; nothing to fix |
| a Linux box lists no panes at all | a `ps` without `-eo`, such as BusyBox on Alpine | unsupported today; say so rather than patching around it |

If you are still stuck after two attempts, stop and hand back to the person with what you ran, what came back, and what you think it means.

## Uninstalling

The whole removal, in order, with the traps named, is in **[AGENT-UNINSTALL.md](AGENT-UNINSTALL.md)**.
Read that file rather than improvising, because two of the steps have to happen in a particular order to be reversible at all.
