# Changelog

What changed in each release of Pane Pulse, newest first.

## 0.2.1

- A first-run prompt: while the hooks have never been set up, Pane Pulse asks at start-up, in the window you're looking at, with **Set it up**, **Not now** or **Don't ask again**. **Set it up** runs **Install Hooks**, which still previews every change and asks first.
- It asks at most three times, days apart, and never again once the hooks are set up.
- When Pane Pulse can't find Node.js, the prompt says so and offers **Get Node.js**, then **Set it up**, so the hooks can go in while Node.js installs.
- **Install Hooks** says so too: when it can't find Node.js, its closing message says to install it and restart VS Code.
- Pane Pulse is now on the VS Code Marketplace.

## 0.2.0 - 2026-09-22

The first public release.

- Marks each Claude Code terminal tab with what that pane is doing: working, finished and unread, or waiting on you.
- The **Panes** panel lists every pane under headings with counts (Needs you, Unseen, Working, Idle, Muted), with a line on top that adds them up.
- Each row shows the pane's model, effort and how full its context is.
- A right-click menu acts on a pane without finding its tab: open, mark as seen, mute, rename, copy the last reply, clear context, interrupt or close.
- Mute a pane to stop its tab marks while Pane Pulse keeps following it.
- A Terminal checkbox in the settings turns off the warning triangle VS Code puts on terminal tabs when an extension changes their environment.
- An About row in the settings.
- **Install Hooks** and **Uninstall Hooks** preview every change and ask first, and uninstalling puts back what the install took.
- Needs VS Code 1.138 or later, Claude Code, and Node.js for the hooks.
- Run on macOS. Windows and Linux are built for but untested.
- MIT licence.
