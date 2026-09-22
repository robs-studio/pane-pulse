// The binding: VS Code's terminals, focus, the Panes panel and its menu, handed to the controller.
//
// Thin on purpose. Every decision the wiring makes (which pane an event is, when a clear may be
// written, what a click does, and that nothing clears on a guess) is in controller.ts, and every
// word, bucket, column and class the panel shows is in panel.ts; neither has a vscode import, so
// node --test holds both to the plan with fakes. This file only builds the parts, forwards VS
// Code's events to them, and turns the menu's commands into the controller's calls and the few
// terminal actions VS Code offers, so it is checked by typecheck, by the build and by the manual
// gate: logic added here is logic no unit test reaches.
//
// Ten facts about VS Code and Claude Code shape the little that is here:
//
//   * THE WINDOW KEY LIVES IN MEMORY ONLY. context.globalState is shared by every window of one
//     extension on one machine, so a persisted key would be the same key in every window and
//     the event source's claim-by-rename could no longer tell two windows apart.
//   * window.activeTerminal IS READ ONCE, HERE. With onStartupFinished the first
//     onDidChangeActiveTerminal may already have fired before activate() ran. That one read also
//     seeds the panel's highlight (R10), which then follows onDidChangeActiveTerminal: the row
//     of the active terminal's live pane is the highlighted one, and highlighting opens nothing.
//     The one other read is Rename's, below, which asks only whether its own pane is active yet.
//   * A TERMINAL'S processId SETTLES LATE. Right after spawn it can still be pending, and a pane
//     whose shell pid is unknown cannot be mapped, so its event files wait in the skip set. Each
//     terminal's processId is watched, and one rescan follows once it settles, deferred a turn
//     so the mapper's own handler on the same promise has recorded the pid first. The watch
//     starts for every terminal already open at activation too: the OS watch on the events
//     folder can start a few milliseconds late, and that one rescan picks up whatever it missed.
//   * CLAUDE CODE KEEPS A REGISTRY OF ITS RUNNING SESSIONS. `<config>/sessions/<pid>.json` lists
//     every claude on the machine, so at activation the controller's discover() lists the ones
//     already running in this window's terminals at once (R11), seeded busy as working, waiting
//     as waiting and anything else as idle, and a mute marker still down re-adopts its mute. The
//     mapper waits at most a second for a pending shell pid, so discovery runs again beside each
//     settle's rescan (P11): a known pid is skipped, so a second run only adds what the first
//     could not match, and runs that land while one is going share one more pass after it.
//   * THE PANEL'S PAGE IS REBUILT EMPTY WHENEVER THE VIEW IS SHOWN AGAIN. The view keeps no page
//     while hidden (retainContextWhenHidden stays off), so a render is posted only while the view
//     is on screen and the page's `ready` is always answered with the current one (P12); the
//     view, and so the activity-bar badge, exists only once the sidebar has first shown it.
//     panelView.ts owns all of that; this file renders on every change and hands the result over.
//   * NO EVENT SAYS A TERMINAL WAS RENAMED, AND NONE SAYS TIME PASSED. Terminal.name changes in
//     place, so the names are read again every NAME_REFRESH_MS while the panel is on screen (its
//     visibility read once, here, then followed), and the list is drawn again only when
//     rowNamesKey() says a name, or the set of panes, has changed; the same tick brings each
//     live pane's details up to date from Claude Code's files. "22m ago" and a session's length
//     move with the clock alone, so the panel is drawn again every AGES_REFRESH_MS while it is on
//     screen. A drawing equal to the last one posted is never posted, so a quiet tick moves
//     nothing under the mouse.
//   * A MENU COMMAND CARRIES A ROW THAT MAY HAVE GONE. VS Code hands a `webview/context` command
//     the row's `data-vscode-context` as it was at the right-click, and a modal can sit open
//     while the pane ends and its terminal starts another claude. So every menu command finds
//     its row again among the rows the panel lists, and acts only while that row's terminal is
//     still open, else it says "That pane has closed" and does nothing (P6); Close Pane finds it
//     again after its modal, and /Clear Context and Interrupt just before they type.
//   * ONLY THE ACTIVE TERMINAL CAN BE RENAMED. workbench.action.terminal.renameWithArg acts on
//     whichever terminal is active, so Rename opens the pane first (which marks it seen, as a
//     click does, R9) and shows it again the moment the modeless name box closes. The show and
//     the rename are two messages to the window that can land together, so the rename waits
//     until onDidChangeActiveTerminal says the pane really is the active one, at most
//     RENAME_ACTIVE_MS; if it never is, nothing is renamed and the status bar says so.
//   * A TERMINAL TAKES TYPED TEXT AS TYPED. terminal.sendText(text, false) delivers the bytes
//     unchanged, so Interrupt is one Esc byte, and /Clear Context types `/clear` and then, a beat
//     later, the Enter that sends it, so the two never arrive as one burst.
//   * SessionEnd NEVER FIRES ON A CRASH. Claude Code runs no hook when claude crashes or is
//     killed, so every live pane's claude is checked every LIVENESS_MS, always, and a dead one
//     leaves the list with its tab cleared. A muted claude that died while no window watched
//     (VS Code quit with a muted pane open, say) left its marker behind for the same reason, so
//     every marker whose pid is dead is swept away once, at activation.
//
// Everything disposable goes into context.subscriptions, so deactivate() has nothing of its own
// to do. installHooks, uninstallHooks and restoreBackups are registered by commands.ts, over
// installer.ts; this file registers the pane list's eleven commands (show the panes, open the
// settings, and the row menu's nine) and hands the rest over. Every one of those handlers runs
// through guarded(), which logs a failure and never throws.
import { randomUUID } from 'node:crypto';

import type { ExtensionContext, Terminal } from 'vscode';
import { ConfigurationTarget, commands, env, window, workspace } from 'vscode';

import { resolveRoot } from './backup.ts';
import { claudeConfigDir, readRegistry } from './claudeFiles.ts';
import { registerCommands } from './commands.ts';
import { PaneController } from './controller.ts';
import type { DiscoveredPane, Timer } from './controller.ts';
import type { PaneState } from './decision.ts';
import { stripSpinner } from './details.ts';
import { DetailsStore } from './detailsStore.ts';
import type { DetailsTarget } from './detailsStore.ts';
import { EventSource } from './events.ts';
import {
  DISABLE_INDICATOR_SETTING,
  INDICATOR_KEY,
  INDICATOR_SECTION,
  IndicatorSync,
  KEPT_INDICATOR_KEY,
} from './indicator.ts';
import { Mapper } from './mapping.ts';
import { LOG_PREFIX as MUTE_LOG_PREFIX, MuteMarkers, controllerMarkers, isAlive } from './mute.ts';
import { CONTEXT_THRESHOLDS, badgeOf, buildPanel, renderPanel } from './panel.ts';
import type { PanelOptions } from './panel.ts';
import { LOG_PREFIX, PanelView } from './panelView.ts';
import { PaneStatusBar } from './statusbar.ts';
import { LIVENESS_MS, NAME_REFRESH_MS, Ticker } from './ticker.ts';
import {
  CLEAR_CONTEXT_COMMAND,
  CLOSE_PANE_COMMAND,
  CONTAINER_ID,
  COPY_REPLY_COMMAND,
  INTERRUPT_PANE_COMMAND,
  MARK_SEEN_COMMAND,
  MUTE_PANE_COMMAND,
  OPEN_PANE_COMMAND,
  OPEN_SETTINGS_COMMAND,
  RENAME_PANE_COMMAND,
  SHOW_PANES_COMMAND,
  STATE_WORDS,
  UNMUTE_PANE_COMMAND,
  VIEW_ID,
  rowNamesKey,
  visibleRows,
} from './view.ts';
import type { PaneRow } from './view.ts';
import { VERSION } from './version.ts';
import { clearIndicator } from './writer.ts';

/** The output channel's name, where Rob reads what the extension did and why. */
const CHANNEL_NAME = 'Pane Pulse';

/** How often the panel is drawn again while on screen, so its ages and durations move. */
const AGES_REFRESH_MS = 30_000;

/** How long a menu command's note stays in the status bar. */
const NOTE_MS = 4000;

/** What a menu command says when the row it names has gone, or its terminal has closed (P6). */
const CLOSED_NOTE = 'That pane has closed';

/**
 * The settings the gear opens (P2), under package.json's `panePulse` section. The panel reads
 * three; the environment change indicator's checkbox is indicator.ts's, and the About row holds
 * nothing.
 */
const SETTINGS_SECTION = 'panePulse';
const PEEK_SETTING = 'peek.enabled';
const WARN_SETTING = 'context.warnAtPercent';
const ALERT_SETTING = 'context.alertAtPercent';

/** Whether rows carry a peek when the setting holds something other than true or false. */
const PEEK_DEFAULT = true;

/** The pane states each typing command acts on, by the pane's own state, muted or not (R8). */
const CLEARABLE_STATES: readonly PaneState[] = Object.freeze(['idle', 'unread']);
const INTERRUPTIBLE_STATES: readonly PaneState[] = Object.freeze(['thinking', 'waiting']);

/** The state Mark as Seen moves a pane out of. */
const UNSEEN_STATE: PaneState = 'unread';

/** What Interrupt types: the Esc key, one byte. */
const ESCAPE = '\x1b';

/** What /Clear Context types, then the Enter that sends it, CLEAR_ENTER_DELAY_MS later. */
const CLEAR_TEXT = '/clear';
const ENTER = '\r';
const CLEAR_ENTER_DELAY_MS = 80;

/** The two modals' questions and yeses (R8); anything else, a dismissal included, is a no. */
const CLEAR_ACTION = 'Clear Context';
const CLEAR_DETAIL =
  'This types /clear into that pane and starts a fresh conversation there; the old one stays ' +
  'in its history (/resume). Anything typed in that pane but not sent yet would be sent with it.';
const CLOSE_ACTION = 'Close Pane';
const CLOSE_DETAIL =
  'This closes the terminal and ends the Claude session running in it. Its conversation stays ' +
  'in its history (/resume).';

/** Rename's name box. */
const RENAME_PROMPT = 'A new name for this terminal';
const RENAME_EMPTY = 'A name cannot be empty';

/** How long Rename waits for its pane to become the active terminal before it gives up (F4). */
const RENAME_ACTIVE_MS = 250;

/** What Rename says when its pane never became the active terminal, so nothing was renamed. */
const RENAME_SWITCH_NOTE = 'Could not switch to that pane to rename it';

/** VS Code's own commands this file runs. */
const RENAME_TERMINAL = 'workbench.action.terminal.renameWithArg';
const OPEN_WORKBENCH_SETTINGS = 'workbench.action.openSettings';

/** A timer over the host's own setTimeout, in the shape the controller takes. */
function setTimer(run: () => void, ms: number): Timer {
  const handle = setTimeout(run, ms);
  return Object.freeze({ cancel: (): void => clearTimeout(handle) });
}

/**
 * Whether `terminal` is the active terminal within `ms`: true at once when it already is, true as
 * soon as onDidChangeActiveTerminal says it has become so, else what window.activeTerminal says
 * once `ms` has passed. The listener and the timer go either way.
 */
function becameActive(terminal: Terminal, ms: number): Promise<boolean> {
  if (window.activeTerminal === terminal) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    // Both are declared before either can fire: VS Code never calls a listener as it subscribes.
    const settle = (active: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(active);
      listener.dispose();
    };
    const listener = window.onDidChangeActiveTerminal((active) => {
      if (active === terminal) settle(true);
    });
    const timer = setTimeout(() => settle(window.activeTerminal === terminal), ms);
  });
}

function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'an error that could not be printed';
  }
}

/**
 * The pane a menu command names. VS Code hands a `webview/context` command the row's context
 * object, whose `paneId` is the pane's id; an object with an `id` is taken as a row; anything else
 * is taken as the id itself. A miss is the caller's to say.
 */
function paneIdOf(arg: unknown): string {
  if (typeof arg === 'object' && arg !== null) {
    if ('paneId' in arg && typeof arg.paneId === 'string') return arg.paneId;
    if ('id' in arg && typeof arg.id === 'string') return arg.id;
  }
  return String(arg);
}

/** The state a registry status seeds (R11): busy is working, waiting is waiting, else idle. */
function seededState(status: string | undefined): DiscoveredPane['state'] {
  if (status === 'busy') return 'thinking';
  if (status === 'waiting') return 'waiting';
  return 'idle';
}

/**
 * A log that says each distinct line once. The registry is read at every discovery, and one
 * broken entry would otherwise be said again at every terminal that opens.
 */
function saidOnce(log: (line: string) => void): (line: string) => void {
  const said = new Set<string>();
  return (line: string): void => {
    if (said.has(line)) return;
    said.add(line);
    log(line);
  };
}

/** How a row is named in a log line: its pid, and its terminal's name as written. */
function labelOf(row: PaneRow<Terminal>): string {
  return `pane ${row.id} (${JSON.stringify(row.name)})`;
}

/** How a row is named to Rob: the name its row shows, Claude Code's title glyph stripped (R12). */
function shownName(row: PaneRow<Terminal>): string {
  return stripSpinner(row.name);
}

/** Builds the panel, the status bar and the event pipeline, and hands them to VS Code. */
export function activate(context: ExtensionContext): void {
  const channel = window.createOutputChannel(CHANNEL_NAME, { log: true });
  context.subscriptions.push(channel);
  const log = (line: string): void => {
    try {
      channel.appendLine(line);
    } catch {
      // A channel already disposed at shutdown has nowhere left to write; never throw for it.
    }
  };
  log(`pane-pulse ${VERSION} activated`);

  const windowKey = randomUUID();
  const root = resolveRoot();
  const mapper = new Mapper<Terminal>(() => window.terminals, { log });

  // Whether a claude still runs. An answer from the OS that is neither yes nor "no such process"
  // is logged here, and reads as alive.
  const alive = (claudePid: number): boolean => isAlive(claudePid, undefined, log);
  // The markers of claudes that died with no window to take them up go before any event lands:
  // dead is dead for every window, and a live pid's marker may be another window's to keep.
  const markers = new MuteMarkers(root, { log });
  const stale = markers.sweep(alive);
  log(
    `${MUTE_LOG_PREFIX}the activation sweep took up ${stale.length} stale marker(s)` +
      (stale.length > 0 ? `, of dead claude pid(s) ${stale.join(', ')}` : ''),
  );

  // The controller needs a refresh that draws the panel and the status bar, which need the
  // controller's rows: the refresh is filled in once both exist, before anything can call it.
  // Its poke reaches the event source, built below from the controller's own owns(): nothing
  // pokes before VS Code's events and the commands are wired, after both exist.
  let refresh = (): void => {};
  const controller = new PaneController<Terminal>({
    resolve: (claudePid) => mapper.resolve(claudePid),
    terminals: () => window.terminals,
    clear: (target) => clearIndicator(target, { log }),
    changed: () => refresh(),
    log,
    setTimer,
    forget: (claudePid) => mapper.forget(claudePid),
    poke: () => events.poke(),
    isAlive: alive,
    // A marker that did not land reaches the controller as a throw, the one failure it reads,
    // so a failed put-down or take-up is tried again (C22).
    markers: controllerMarkers(markers),
  });
  context.subscriptions.push(controller);

  // Each pane's model, effort, context and last words, read from Claude Code's own files and
  // never written: the registry and the transcripts under CLAUDE_CONFIG_DIR, else ~/.claude.
  const configDir = claudeConfigDir();
  const store = new DetailsStore({ configDir, log });
  context.subscriptions.push({ dispose: (): void => store.dispose() });

  /** A short note in the status bar, for what a menu command did not do and why. */
  const note = (text: string): void => {
    try {
      window.setStatusBarMessage(text, NOTE_MS);
    } catch (error) {
      log(`${LOG_PREFIX}could not show the note ${JSON.stringify(text)}: ${messageOf(error)}`);
    }
  };

  /**
   * The row a menu command names, found again among the rows the panel lists, while its
   * terminal is still open (P6). Anything else is logged, noted as closed, and answers undefined.
   */
  const liveRow = (id: string, what: string): PaneRow<Terminal> | undefined => {
    const row = visibleRows(controller.rows()).find((candidate) => candidate.id === id);
    if (row !== undefined && window.terminals.includes(row.terminal)) return row;
    log(
      `${LOG_PREFIX}${what} named pane ${JSON.stringify(id)}, which is no longer listed or whose ` +
        'terminal has closed, so nothing was done',
    );
    note(CLOSED_NOTE);
    return undefined;
  };

  /**
   * Opens a pane as a click on its row does: the controller sends it `gained`, which marks an
   * unseen pane seen, and its terminal is shown with the focus, as a click on its tab would.
   */
  const showPane = (id: string): Terminal | undefined => {
    const terminal = controller.focusPane(id);
    terminal?.show(false);
    return terminal;
  };

  /** Open Pane, a row's click and Enter on a row: one road (P7). */
  const openPane = (id: string, what: string): void => {
    if (liveRow(id, what) !== undefined) showPane(id);
  };

  const panelView = new PanelView({
    extensionUri: context.extensionUri,
    open: (id) => openPane(id, 'a row click'),
    log,
  });
  const statusBar = new PaneStatusBar(() => controller.rows());

  /** The panel's three settings (P2); buildPanel falls back on any it cannot use. */
  const readSettings = (): Pick<PanelOptions, 'peek' | 'thresholds'> => {
    const config = workspace.getConfiguration(SETTINGS_SECTION);
    const peek = config.get<unknown>(PEEK_SETTING);
    const mid = config.get<unknown>(WARN_SETTING);
    const high = config.get<unknown>(ALERT_SETTING);
    return Object.freeze({
      peek: typeof peek === 'boolean' ? peek : PEEK_DEFAULT,
      thresholds: Object.freeze({
        mid: typeof mid === 'number' ? mid : CONTEXT_THRESHOLDS.mid,
        high: typeof high === 'number' ? high : CONTEXT_THRESHOLDS.high,
      }),
    });
  };
  let settings = readSettings();

  // The Terminal checkbox: VS Code's environment change indicator, off while it is ticked and
  // put back when it is not (indicator.ts). Brought in line once now, in case the box changed
  // while VS Code was closed, and again on each change of the box.
  const indicator = new IndicatorSync({
    want: () =>
      workspace.getConfiguration(SETTINGS_SECTION).get<unknown>(DISABLE_INDICATOR_SETTING),
    current: () =>
      workspace.getConfiguration(INDICATOR_SECTION).inspect<unknown>(INDICATOR_KEY)?.globalValue,
    kept: () => context.globalState.get<unknown>(KEPT_INDICATOR_KEY),
    keep: (kept) => context.globalState.update(KEPT_INDICATOR_KEY, kept),
    write: (value) =>
      workspace
        .getConfiguration(INDICATOR_SECTION)
        .update(INDICATOR_KEY, value, ConfigurationTarget.Global),
    log,
  });
  void indicator.sync();
  // The terminal the highlight follows (R10): window.activeTerminal's one read, below, then
  // every onDidChangeActiveTerminal.
  let highlighted: Terminal | undefined;

  /** The panel drawn from the rows, each pane's details and the settings, and handed over. */
  const render = (): void => {
    try {
      const rows = controller.rows();
      const activeId = visibleRows(rows).find((row) => row.terminal === highlighted)?.id;
      const model = buildPanel(rows, (id) => store.get(Number(id)), {
        activeId,
        now: Date.now(),
        ...settings,
      });
      panelView.show(renderPanel(model), badgeOf(model));
    } catch (error) {
      log(`${LOG_PREFIX}the list could not be drawn, so it shows the one before: ${messageOf(error)}`);
    }
  };

  // The panes listed at the last details refresh: one that has left since is forgotten.
  let detailed: ReadonlySet<string> = new Set();
  /**
   * Each listed pane's details brought up to date from Claude Code's files, and the panel drawn
   * again if any changed. The store runs one pass at a time, so overlapping calls cost at most
   * two passes; a pane no longer listed is forgotten first.
   */
  const refreshDetails = (): void => {
    try {
      const live = visibleRows(controller.rows());
      const ids = new Set(live.map((row) => row.id));
      for (const id of detailed) if (!ids.has(id)) store.forget(Number(id));
      detailed = ids;
      const targets: DetailsTarget[] = live.map((row) => ({
        pid: Number(row.id),
        sessionId: row.sessionId,
        cwd: row.cwd,
        lastEvent: row.lastEvent,
      }));
      void store.refresh(targets).then(
        (changed) => {
          if (changed) render();
        },
        (error: unknown) => log(`${LOG_PREFIX}the details refresh failed: ${messageOf(error)}`),
      );
    } catch (error) {
      log(`${LOG_PREFIX}the details refresh could not start: ${messageOf(error)}`);
    }
  };

  refresh = (): void => {
    try {
      statusBar.refresh();
    } catch (error) {
      log(`${LOG_PREFIX}the status bar could not be refreshed: ${messageOf(error)}`);
    }
    render();
    refreshDetails();
  };

  // The names, read again while the panel is on screen, with each pane's details. The list is
  // drawn again only when a name or the set of panes has changed since the last tick, or the
  // details did; a change of state or mute already draws it through refresh.
  let lastNames = rowNamesKey(controller.rows());
  const names = new Ticker(
    () => {
      const key = rowNamesKey(controller.rows());
      if (key !== lastNames) {
        lastNames = key;
        render();
      }
      refreshDetails();
    },
    NAME_REFRESH_MS,
    { log },
  );
  // The ages and durations, moved on while the panel is on screen.
  const ages = new Ticker(() => render(), AGES_REFRESH_MS, { log });
  // Every live pane's claude asked after, always: a crash fires no SessionEnd.
  const liveness = new Ticker(() => controller.sweep(), LIVENESS_MS, { log });
  context.subscriptions.push(names, ages, liveness);

  const events = new EventSource(root, windowKey, {
    owns: (claudePid) => controller.owns(claudePid),
    onEvent: (event) => controller.onEvent(event),
    log,
  });
  context.subscriptions.push({ dispose: (): void => events.dispose() });

  // The claudes already running, from Claude Code's session registry (R11), each with whether
  // its mute marker is down now. A run asked for while one is going is folded into one more
  // pass after it, which reads the registry and the markers afresh.
  const registryLog = saidOnce(log);
  let discovering = false;
  let discoverAgain = false;
  const discover = (): void => {
    if (discovering) {
      discoverAgain = true;
      return;
    }
    discovering = true;
    void (async (): Promise<void> => {
      try {
        do {
          discoverAgain = false;
          const marked = new Set(markers.list());
          const entries: DiscoveredPane[] = readRegistry(configDir, registryLog).map((entry) => ({
            pid: entry.pid,
            state: seededState(entry.status),
            sessionId: entry.sessionId,
            cwd: entry.cwd,
            marked: marked.has(entry.pid),
          }));
          await controller.discover(entries);
        } while (discoverAgain);
      } catch (error) {
        log(`${LOG_PREFIX}listing the panes already running failed: ${messageOf(error)}`);
      } finally {
        discovering = false;
      }
    })();
  };

  const watchProcessId = (terminal: Terminal): void => {
    void Promise.resolve(terminal.processId).then(
      () =>
        setImmediate(() => {
          events.rescan();
          discover();
        }),
      (): void => undefined,
    );
  };

  // Read once, here, as the header says, and the highlight starts from the same read.
  const startActive = window.activeTerminal;
  controller.start(startActive);
  highlighted = startActive;
  discover();

  // The tickers that only matter on screen follow the panel's visibility, read once here and
  // then followed. Coming on screen brings the list and its details up to date at once.
  const followVisibility = (visible: boolean): void => {
    names.setActive(visible);
    ages.setActive(visible);
    if (!visible) return;
    render();
    refreshDetails();
  };
  names.setActive(panelView.visible);
  ages.setActive(panelView.visible);

  /**
   * A command's handler, run so that nothing it throws or rejects escapes into VS Code: the
   * failure is logged in full and noted in the status bar.
   */
  const guarded =
    (what: string, run: (arg: unknown) => unknown) =>
    async (arg?: unknown): Promise<void> => {
      try {
        await run(arg);
      } catch (error) {
        log(`${LOG_PREFIX}${what} failed, and was dropped: ${messageOf(error)}`);
        note(`Pane Pulse: ${what} did not finish; the Pane Pulse log says why`);
      }
    };

  /** Mark as Seen: an unseen pane goes idle and its tab clears, with no terminal shown. */
  const markSeen = (id: string): void => {
    const row = liveRow(id, 'Mark as Seen');
    if (row === undefined) return;
    if (row.state !== UNSEEN_STATE) {
      note(`${shownName(row)} has nothing unseen to mark`);
      return;
    }
    if (!controller.markSeen(id)) {
      note(`${shownName(row)} could not be marked as seen; the Pane Pulse log says why`);
    }
  };

  /** Mute Status and Unmute Status: the controller's mute of that pane's terminal. */
  const setMuted = (id: string, muted: boolean): void => {
    const what = muted ? 'Mute Status' : 'Unmute Status';
    const row = liveRow(id, what);
    if (row === undefined) return;
    if (muted ? controller.mute(id) : controller.unmute(id)) return;
    note(
      row.muted === 'env'
        ? `${shownName(row)} is muted by PANE_PULSE_IGNORE in its environment, which the menu cannot change`
        : `${what} did not reach ${shownName(row)}; the Pane Pulse log says why`,
    );
  };

  /** Rename…: opens the pane, asks for the name, then renames it while it is the active one. */
  const renamePane = async (id: string): Promise<void> => {
    const row = liveRow(id, 'Rename');
    if (row === undefined) return;
    const terminal = showPane(id);
    if (terminal === undefined) {
      note(CLOSED_NOTE);
      return;
    }
    const name = await window.showInputBox({
      value: shownName(row),
      prompt: RENAME_PROMPT,
      validateInput: (value) => (value.trim() === '' ? RENAME_EMPTY : undefined),
    });
    if (name === undefined) return;
    if (!window.terminals.includes(terminal)) {
      log(`${LOG_PREFIX}${labelOf(row)} closed while its new name was asked, so nothing was renamed`);
      note(CLOSED_NOTE);
      return;
    }
    // The name box is modeless, so any terminal may be the active one by now (P6). show() and
    // the rename are two messages that can land together, so the rename waits until VS Code says
    // the pane is the active terminal (F4); if it never is, nothing is renamed.
    terminal.show(false);
    if (!(await becameActive(terminal, RENAME_ACTIVE_MS))) {
      log(
        `${LOG_PREFIX}${labelOf(row)} did not become the active terminal within ` +
          `${RENAME_ACTIVE_MS} ms, so nothing was renamed`,
      );
      note(RENAME_SWITCH_NOTE);
      return;
    }
    await commands.executeCommand(RENAME_TERMINAL, { name: name.trim() });
    log(`${LOG_PREFIX}${labelOf(row)} was renamed ${JSON.stringify(name.trim())}`);
  };

  /** Copy Last Reply: the pane's newest reply, read fresh from its transcript. */
  const copyLastReply = async (id: string): Promise<void> => {
    const row = liveRow(id, 'Copy Last Reply');
    if (row === undefined) return;
    const reply = await store.lastReply(Number(id));
    if (reply === undefined || reply.trim() === '') {
      note(`${shownName(row)} has no reply to copy yet`);
      return;
    }
    await env.clipboard.writeText(reply);
    log(`${LOG_PREFIX}copied the last reply of ${labelOf(row)} (${reply.length} characters)`);
    note(`Copied the last reply from ${shownName(row)}`);
  };

  /** /Clear Context: asks, finds the row again, then types /clear and, a beat later, Enter. */
  const clearContext = async (id: string): Promise<void> => {
    const what = '/Clear Context';
    const row = liveRow(id, what);
    if (row === undefined) return;
    if (!CLEARABLE_STATES.includes(row.state)) {
      note(`${what} needs an idle pane; ${shownName(row)} is ${STATE_WORDS[row.state]}`);
      return;
    }
    const answer = await window.showWarningMessage(
      `Clear ${shownName(row)}'s context?`,
      { modal: true, detail: CLEAR_DETAIL },
      CLEAR_ACTION,
    );
    if (answer !== CLEAR_ACTION) return;
    const again = liveRow(id, what);
    if (again === undefined) return;
    if (!CLEARABLE_STATES.includes(again.state)) {
      note(`${shownName(again)} is ${STATE_WORDS[again.state]} now, so nothing was typed`);
      return;
    }
    const { terminal } = again;
    terminal.sendText(CLEAR_TEXT, false);
    setTimeout(() => {
      try {
        if (!window.terminals.includes(terminal)) {
          log(`${LOG_PREFIX}${labelOf(again)} closed before /clear was sent, so no Enter followed`);
          return;
        }
        terminal.sendText(ENTER, false);
      } catch (error) {
        log(`${LOG_PREFIX}the Enter after /clear in ${labelOf(again)} failed: ${messageOf(error)}`);
      }
    }, CLEAR_ENTER_DELAY_MS);
    log(`${LOG_PREFIX}typed /clear into ${labelOf(again)}, as confirmed`);
  };

  /** Interrupt: Esc to a pane that is working or waiting for an answer. */
  const interruptPane = (id: string): void => {
    const row = liveRow(id, 'Interrupt');
    if (row === undefined) return;
    if (!INTERRUPTIBLE_STATES.includes(row.state)) {
      note(`Interrupt needs a working or waiting pane; ${shownName(row)} is ${STATE_WORDS[row.state]}`);
      return;
    }
    row.terminal.sendText(ESCAPE, false);
    log(`${LOG_PREFIX}sent Esc to ${labelOf(row)}, to interrupt it`);
  };

  /** Close Pane: asks, finds the row again, then closes its terminal. */
  const closePane = async (id: string): Promise<void> => {
    const row = liveRow(id, 'Close Pane');
    if (row === undefined) return;
    const answer = await window.showWarningMessage(
      `Close ${shownName(row)}?`,
      { modal: true, detail: CLOSE_DETAIL },
      CLOSE_ACTION,
    );
    if (answer !== CLOSE_ACTION) return;
    const again = liveRow(id, 'Close Pane');
    if (again === undefined) return;
    again.terminal.dispose();
    log(`${LOG_PREFIX}closed the terminal of ${labelOf(again)}, as confirmed`);
  };

  context.subscriptions.push(
    window.registerWebviewViewProvider(VIEW_ID, panelView),
    panelView,
    statusBar,
    panelView.onDidChangeVisibility(followVisibility),
    window.onDidChangeActiveTerminal((terminal) => {
      highlighted = terminal;
      controller.activeTerminalChanged(terminal);
      render();
    }),
    window.onDidChangeWindowState((state) => controller.windowStateChanged(state.focused)),
    window.onDidOpenTerminal((terminal) => {
      mapper.terminalOpened();
      events.rescan();
      watchProcessId(terminal);
    }),
    window.onDidCloseTerminal((terminal) => {
      controller.terminalClosed(terminal);
      mapper.terminalClosed(terminal);
      events.rescan();
    }),
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SETTINGS_SECTION}.${DISABLE_INDICATOR_SETTING}`)) {
        void indicator.sync();
      }
      if (!event.affectsConfiguration(SETTINGS_SECTION)) return;
      settings = readSettings();
      render();
    }),
    commands.registerCommand(
      SHOW_PANES_COMMAND,
      guarded('Show Panes', () => commands.executeCommand(`workbench.view.extension.${CONTAINER_ID}`)),
    ),
    // The gear: VS Code's own Settings, filtered to this extension's own (R12, P2).
    commands.registerCommand(
      OPEN_SETTINGS_COMMAND,
      guarded('Settings', () =>
        commands.executeCommand(OPEN_WORKBENCH_SETTINGS, `@ext:${context.extension.id}`),
      ),
    ),
    // The row menu's nine, each handed the row's context by VS Code (webview/context).
    commands.registerCommand(
      OPEN_PANE_COMMAND,
      guarded('Open Pane', (arg) => openPane(paneIdOf(arg), 'Open Pane')),
    ),
    commands.registerCommand(
      MARK_SEEN_COMMAND,
      guarded('Mark as Seen', (arg) => markSeen(paneIdOf(arg))),
    ),
    commands.registerCommand(
      MUTE_PANE_COMMAND,
      guarded('Mute Status', (arg) => setMuted(paneIdOf(arg), true)),
    ),
    commands.registerCommand(
      UNMUTE_PANE_COMMAND,
      guarded('Unmute Status', (arg) => setMuted(paneIdOf(arg), false)),
    ),
    commands.registerCommand(
      RENAME_PANE_COMMAND,
      guarded('Rename', (arg) => renamePane(paneIdOf(arg))),
    ),
    commands.registerCommand(
      COPY_REPLY_COMMAND,
      guarded('Copy Last Reply', (arg) => copyLastReply(paneIdOf(arg))),
    ),
    commands.registerCommand(
      CLEAR_CONTEXT_COMMAND,
      guarded('/Clear Context', (arg) => clearContext(paneIdOf(arg))),
    ),
    commands.registerCommand(
      INTERRUPT_PANE_COMMAND,
      guarded('Interrupt', (arg) => interruptPane(paneIdOf(arg))),
    ),
    commands.registerCommand(
      CLOSE_PANE_COMMAND,
      guarded('Close Pane', (arg) => closePane(paneIdOf(arg))),
    ),
  );

  context.subscriptions.push(...registerCommands(context, log));

  for (const terminal of window.terminals) watchProcessId(terminal);
  events.start();
  liveness.start();
  refresh();
}

/** Nothing of its own: everything activate() built is disposed through context.subscriptions. */
export function deactivate(): void {
  // Intentionally empty; see above.
}
