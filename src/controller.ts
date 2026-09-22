// The controller: where a hook event, a tab click, the menu's Mute Status, the window's focus
// and Claude Code's session registry meet one pane.
//
// Every judgement the extension makes between VS Code and the model lives here, and none of
// them is a state. A pane's next state, and whether its mark must go, is always reduce()'s
// answer in model.ts; whether looking clears a pane is always clearsOnFocus()'s in decision.ts.
// The one clear this file decides for itself is a mute's (below), and it changes no state: a
// muted tab carries no mark, whatever its pane is doing. What this file owns is when to ask,
// and about which pane, and each rule below is here because VS Code or the hook makes it easy
// to get wrong:
//
//   * WHICH PANE AN EVENT IS. The event source asks owns() before it takes a file; owns() asks
//     the mapper and keeps the Mapping it answered, so the event that follows arrives knowing
//     its terminal and its pty. A Mapping whose terminal is no longer open is ignored: the
//     mapper can answer, uncached, with a terminal that closed while its walk was in flight.
//   * ONE MARK PER TAB (ruling 16). Two claudes can share a terminal (one exits and another
//     starts, or one runs inside the other), and the tab shows only the mark printed last. So
//     only the terminal's newest claude may ever be cleared: when a pid starts speaking on a
//     terminal (its first event, or its first since it went), every other live pane there goes
//     gone first. A pane that goes, for that reason or any other (its SessionEnd, its terminal
//     closing), takes its timers and held clear with it, and the mapper forgets its pid.
//   * NOTHING CLEARS ON A GUESS (ruling 17, Rob's decision). A mark goes when Rob does something
//     to its pane, and only then: its tab is selected, its row in the pane list is clicked, or
//     he marks it seen. A pane that finishes while its tab is already the selected one keeps its
//     mark until one of those, or until the next prompt there replaces it with the spinner.
//     Clearing it because it is the active terminal of a focused window would be a guess, and a
//     wrong guess is a finished mark that disappears unseen: VS Code cannot tell looking at a
//     terminal from reading a file with that terminal still selected, and gives no signal at all
//     for a hidden panel. So a window-focus change goes to the model, which changes nothing for
//     it, and no timer here ever ends in a clear of its own accord.
//   * A CLEAR NEVER OVERTAKES THE MARK IT CANCELS (ruling 5). hook/hook.js writes its event
//     file before it prints its terminalSequence, and Claude Code prints that only once the
//     hook exits, so an event can land here before its mark reaches the pty. A clear written
//     then, a click's or a mute's, would arrive first and leave a stuck mark on the very pane
//     it was for. So every event that printed a mark arms one settle timer for its pane
//     (SETTLE_MS), superseded by that pane's next mark, and a clear decided inside it is held
//     until it ends: a click inside it marks the row read at once but holds the write. A mute
//     can clear a pane in any state, so the settle cannot wait for the marks a click could
//     clear; it waits for every mark. Holding a clear is all the settle is for: one that ends
//     with none held does nothing. A newer mark inside it drops a held clear, which would
//     otherwise wipe that newer mark. An event that printed nothing, which is every no-op and
//     every mark a mute held back, leaves the timers alone: it brings no mark to wait for, and
//     supersedes no clear already decided.
//   * FOCUS IS WEAK. onDidChangeActiveTerminal dedupes on object identity, so it reports
//     nothing when focus comes back from an editor, nor for a click on the tab already
//     selected. A pane-list row click (focusPane) is the covering path: it sends the same
//     `gained` a tab click does.
//   * MARK AS SEEN IS A ROW CLICK THAT OPENS NOTHING (ruling 17). markSeen() sends its one pane
//     the same `gained` a row click sends, down the same road, so only an unseen pane moves (it
//     goes idle, muted or not) and its clear is written, or held while its settle runs, exactly
//     as a click's is (ruling 5). It is the member's own act on that pane, so it joins the tab
//     selection and the row click as the only looks that clear; any other pane is left as it is.
//   * THE REGISTRY SEEDS A STATE, NEVER A CLEAR OR A MARK (R11). discover() lists the claudes
//     already running when the extension started, from Claude Code's session registry, as a
//     first event would list them, seeded busy as thinking, waiting as waiting, idle as idle.
//     It prints nothing, so no tab is written and no settle is armed, and a pane that finished
//     unseen before the restart reads idle until its next event. A pid already known is left
//     alone, since its own events win, and a pane already listed keeps its tab against one
//     from the registry (ruling 16: only speaking takes a tab). A marker still down for a pid
//     mutes its terminal again, as that pid's first event would (C13).
//   * LOOKING ASKS FOR NEWS (ruling 19). An OS watch can drop a notification, and a mark it
//     carried then waits on disk for the next change in the folder. A tab click, a row click,
//     Mark as Seen and a window-focus change each poke the event source for a pass. The pass is
//     asynchronous, so what it finds lands after that click has been judged, as any event does.
//   * A CLEAR THAT FAILS AT THE DEVICE IS UNDONE (ruling 18). reduce() marks a pane read before
//     the write, so a write that fails would leave the mark on the tab and a row with nothing
//     left to clear. When a device was tried and failed, the pane goes back to what it was a
//     moment earlier, so the next click retries. That is an undo of the controller's own last
//     step, never a state decided here. With no device known at all a retry cannot help, so the
//     pane stays read and the failure is logged.
//   * A MUTE BELONGS TO THE TERMINAL (D5). The menu's Mute Status mutes a pane's terminal, not
//     its pid, until Unmute Status unmutes it or the terminal closes, so a claude started there
//     later (a loop that relaunches claude in the same tab) starts muted. Muting puts down the
//     marker of each live pane there, so its hook prints no further mark, then clears the tab
//     through the same road a click's clear takes, so a running settle holds it (ruling 5). A
//     pane muted by PANE_PULSE_IGNORE in its own environment refuses Mute Status and Unmute
//     Status alike: the menu cannot change a process's environment. A reload forgets the set,
//     never the choice (C13): the first event this controller ever sees for a pid, if it says a
//     marker held its mark back, mutes that pid's terminal again. Only a pid never seen before
//     re-adopts, so an event written a moment before an unmute can never undo it.
//   * A MARKER IS DOWN ONLY WHILE ITS PID LIVES ON A MUTED TERMINAL (D1, D5). A pid can be
//     reused, and a stale marker silences whichever claude gets that pid next. So a marker is
//     put down when a live pane is on a muted terminal, once, and taken up at that pid's
//     SessionEnd, its terminal's close, the unmute and its death, and at nothing else but a
//     retry of one of those. A pane retired because a newer claude spoke on its tab keeps its
//     marker: its process still runs on a muted terminal, and if it speaks again its marks must
//     stay quiet. The pids with a marker down are remembered, so a retired pane's is still found
//     when it dies, and one whose take-up failed stays remembered until a later one succeeds.
//   * EVERY EVENT SQUARES A PANE'S MARKER WITH ITS TERMINAL (C23). A marker that did not land,
//     or would not go, reaches this file as a throw (mute.ts's controllerMarkers, C22). So each
//     event from a live pane puts its marker down when its terminal is muted and takes it up
//     when its terminal is not and the marker is still remembered: a take-up that failed at the
//     unmute is tried again at the pane's next event, rather than leaving the pane silent under
//     a row that reads unmuted. Only a terminal that is not muted ever loses a marker this way,
//     so a retired pane on a muted one keeps its own (D5); a pane muted by its environment is
//     never touched either way.
//   * A MARK THAT REACHES A MUTED TAB IS CLEARED (C14). A writer that looked for the marker a
//     moment before it was down still prints its mark, and its event says so in `sequence`.
//     That is a fact, never a guess, so the pane gets a clear through the same road as a click's,
//     held by the settle its own mark armed. No timer of its own is needed.
//   * A DEAD PROCESS IS A FACT (D4). Claude Code fires no hook when claude crashes or is killed,
//     so sweep() asks the host whether each live pane's claude still runs, and only a plain no
//     is dead. A dead pane goes through the model's processGone, which retires it and asks for a
//     clear. That clear is written at once, since a dead claude prints no mark that could
//     overtake it, and it is never undone (C17): ruling 18's undo is for a pane the next click
//     can retry, and a dead one stays gone. Its marker is taken up and its mapping let go
//     either way.
//
// No vscode import, no clock, no fs: the host hands in the terminals, the mapper, the writer,
// the event source's poke, the refresh, the timers, the liveness check and the markers, so
// tests/controller.test.mjs can drive every rule above with a fake host and a fake clock.
// Nothing the host, the model or a malformed event throws escapes a public method or a timer.
// It is logged instead, because a throw here would land in the event source or in the
// extension host's own event loop.
import type { PaneState, SequenceName } from './decision.ts';
import type { MuteSource, PaneEvent } from './events.ts';
import type { Mapping, TerminalLike } from './mapping.ts';
import { reduce } from './model.ts';
import type { FocusInputKind, Pane, Reduction } from './model.ts';
import type { PaneRow } from './view.ts';
import type { ClearResult, ClearTarget } from './writer.ts';

/**
 * How long a clear waits after the event that printed its pane's mark (ruling 5): long enough
 * for the hook to exit and Claude Code to print the mark, short enough to read as immediate.
 * Only a clear decided inside it, a click's or a mute's, ever waits on it; its end clears
 * nothing by itself.
 */
export const SETTLE_MS = 400;

/** A pending timer, as the host's setTimer hands it back. */
export type Timer = { readonly cancel: () => void };

/**
 * Everything the controller reaches outside itself. The binding builds it from VS Code, the
 * mapper and the writer; tests build it from plain objects and a fake clock.
 */
export type ControllerHost<T> = {
  /** The mapper's answer for a claude pid: `mapper.resolve`. Never expected to reject. */
  readonly resolve: (claudePid: number) => Promise<Mapping<T> | undefined>;
  /** The terminals open in this window now: `window.terminals`. */
  readonly terminals: () => readonly T[];
  /** Writes one pane's clear: `clearIndicator`. Never expected to throw. */
  readonly clear: (target: ClearTarget) => ClearResult;
  /** Something about the panes changed: refresh the tree, the status bar and the empty message. */
  readonly changed: () => void;
  /** One line to the output channel. */
  readonly log: (line: string) => void;
  /** Runs `run` once after `ms`, unless cancelled first. */
  readonly setTimer: (run: () => void, ms: number) => Timer;
  /** A pane has gone: drop its claude pid's mapping, `mapper.forget`. Never expected to throw. */
  readonly forget: (claudePid: number) => void;
  /** Run an event pass without forgetting skipped files: `events.poke`. Never expected to throw. */
  readonly poke: () => void;
  /**
   * Whether a claude pid's process still runs: mute.ts's isAlive. Only a plain `false` is read
   * as dead, and a throw is read as alive. Never expected to throw.
   */
  readonly isAlive: (claudePid: number) => boolean;
  /**
   * The skip markers the hook stats, mute.ts's MuteMarkers: `add` puts `<root>/mute/<pid>`
   * down, `remove` takes it up, and either one twice is harmless. Never expected to throw.
   */
  readonly markers: {
    readonly add: (claudePid: number) => void;
    readonly remove: (claudePid: number) => void;
  };
};

/** The one wait, overridable for a test that wants another number. */
export type ControllerOptions = {
  /** Defaults to SETTLE_MS. */
  readonly settleMs?: number;
};

/**
 * One claude that was already running when the extension started, as Claude Code's session
 * registry lists it (`<config>/sessions/<pid>.json`), for discover(). `state` is what its
 * registry status seeds: busy is thinking, waiting is waiting, idle is idle; the registry never
 * says a turn finished unseen, so nothing else can be seeded. `sessionId` and `cwd` are its
 * registry's, when it gives them. `marked` is whether a mute marker is down for its pid now
 * (mute.ts's MuteMarkers.list), the record of a mute the member made before the restart.
 */
export type DiscoveredPane = Readonly<{
  pid: number;
  state: 'idle' | 'thinking' | 'waiting';
  sessionId?: string;
  cwd?: string;
  marked: boolean;
}>;

/**
 * One pane the controller knows: its model state, the Mapping its latest event came with, and
 * whether PANE_PULSE_IGNORE mutes it. That is true from the first event that said so, since a
 * process's environment never changes. Its session id and folder are the latest an event or its
 * registry entry gave (an event without a session id keeps the one before), and `lastEvent` is
 * its latest event's `ts`, absent until its first event.
 */
type Known<T> = {
  readonly pane: Pane;
  readonly mapping: Mapping<T>;
  readonly envMuted: boolean;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly lastEvent?: number;
};

/** A pane's pending settle. The token is how a fired callback knows it is still the current one. */
type Settle = { readonly timer: Timer; readonly token: object };

/**
 * A clear decided, by reduce() or by a mute: the pane it was decided from, and the pane it left
 * in its place. `before` is undefined when there is nothing to go back to: a pane never seen
 * before, or a mute's clear, which changes no state. A write that fails at the device puts
 * `before` back, but only while `after` is still there.
 */
type Decided = { readonly before: Pane | undefined; readonly after: Pane };

/** A clear held until its pane's settle ends: what it was decided from, and why, for the log. */
type Held = { readonly decided: Decided; readonly why: string };

/** A pane Mute Status or Unmute Status reached: its claude pid, and the pane as it stands. */
type Belled<T> = { readonly pid: number; readonly known: Known<T> };

/** Every line this module logs opens with this, as the other modules' lines do. */
const LOG_PREFIX = 'pane-pulse controller: ';

/**
 * The one sequence that draws no mark. A muted pane's writer still prints it, and it brings no
 * mark for a settle to wait on.
 */
const CLEAR_SEQUENCE: SequenceName = 'clear';

/** A muted pane's two reasons, as the event file and the row name them. */
const MUTED_BY_ENV: MuteSource = 'env';
const MUTED_BY_MARKER: MuteSource = 'marker';

/**
 * What a pane is once it has gone: the model's own answer for a closed terminal, asked once here
 * rather than restated, so no judgement in this file names a state. (DiscoveredPane's type
 * spells the three a registry status can seed; nothing here compares against them.)
 */
const GONE: PaneState = reduce(undefined, { kind: 'terminalClosed' }).pane.state;

function fail(message: string): never {
  throw new Error(`pane-pulse controller: ${message}`);
}

function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'an error that could not be printed';
  }
}

/** A wait from the options, or its default. A negative or non-finite wait is refused by name. */
function durationOf(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${name} must be a finite number of milliseconds, 0 or more, got ${String(value)}`);
  }
  return value;
}

/**
 * Keeps every pane's state for one window and decides when to ask the model about it. Generic
 * over the terminal, so a real `vscode.Terminal` goes in unchanged and tests pass plain objects.
 * A pane is keyed by its claude pid, from its first event on; a gone pane keeps its row, and
 * view.ts is the one that hides it.
 */
export class PaneController<T extends TerminalLike> {
  readonly #host: ControllerHost<T>;
  readonly #settleMs: number;

  /** Every pane seen, by claude pid. */
  readonly #panes = new Map<number, Known<T>>();
  /** owns()'s answers, latest wins: the Mapping the next event for that pid is taken with. */
  readonly #mappings = new Map<number, Mapping<T>>();
  /** At most one pending settle per pane. */
  readonly #settles = new Map<number, Settle>();
  /** Clears already decided during a pane's settle (a click's, a mute's), written when it ends. */
  readonly #heldClears = new Map<number, Held>();
  /** The terminals Mute Status has muted. A mute belongs to the terminal until it closes. */
  readonly #mutedTerminals = new Set<T>();
  /** The pids whose marker this window has put down and not yet taken up. */
  readonly #marked = new Set<number>();

  #active: T | undefined;
  #started = false;
  #disposed = false;

  /** Throws only on a wait that is not milliseconds: a wiring fault, never a runtime one. */
  constructor(host: ControllerHost<T>, options: ControllerOptions = {}) {
    this.#host = host;
    this.#settleMs = durationOf(options.settleMs, SETTLE_MS, 'settleMs');
  }

  /**
   * Activation. `active` is `window.activeTerminal`, read once: with onStartupFinished the first
   * active-terminal change may already have fired. It is recorded, never treated as a click, so
   * nothing is dispatched when VS Code echoes it. Nothing is armed: no timer runs until an event
   * arrives.
   */
  start(active: T | undefined): void {
    this.#guard('start', undefined, () => {
      if (this.#started) {
        this.#log('start() ran a second time and was ignored');
        return;
      }
      this.#started = true;
      this.#active = active;
    });
  }

  /**
   * The event source's ownership question: whether `claudePid` runs in one of this window's
   * terminals. A yes keeps the Mapping it found, for the event that follows. Never rejects: a
   * failure is logged and answers no, so the file waits for the next rescan.
   */
  async owns(claudePid: number): Promise<boolean> {
    if (this.#disposed) return false;
    try {
      const mapping = await this.#host.resolve(claudePid);
      if (this.#disposed || mapping === undefined) return false;
      this.#mappings.set(claudePid, mapping);
      return true;
    } catch (error) {
      const why = messageOf(error);
      this.#log(`resolving claude pid ${claudePid} failed, so it is not ours for now: ${why}`);
      return false;
    }
  }

  /** One owned event, from the event source. Anything wrong with it is logged, never thrown. */
  onEvent(event: PaneEvent): void {
    this.#guard('an event', undefined, () => this.#applyEvent(event));
  }

  /**
   * The active terminal changed: a tab click, or VS Code moving focus. Panes on the terminal
   * left behind get `lost`, panes on the new one get `gained`; a clear the model returns is
   * written at once, unless that pane's settle is still running. The terminal already recorded
   * as active dispatches nothing: VS Code never repeats one, so that is start()'s read echoed.
   * Either way the event source is poked for a pass.
   */
  activeTerminalChanged(terminal: T | undefined): void {
    this.#guard('the active-terminal change', undefined, () => {
      this.#poke();
      const previous = this.#active;
      if (terminal === previous) return;
      this.#active = terminal;
      if (previous !== undefined) this.#dispatch(previous, 'lost', 'its tab lost focus');
      if (terminal !== undefined) this.#dispatch(terminal, 'gained', 'its tab was selected');
      this.#changed();
    });
  }

  /**
   * The window gained or lost OS focus: `window.state.focused`. Every pane gets `windowFocused`
   * or `windowBlurred`, which the model leaves as it is: the window coming to the front is not a
   * pane being read (ruling 17). The event source is poked for a pass.
   */
  windowStateChanged(focused: boolean): void {
    this.#guard('the window-state change', undefined, () => {
      this.#poke();
      const kind: FocusInputKind = focused ? 'windowFocused' : 'windowBlurred';
      for (const [pid, known] of this.#panes) this.#focus(pid, known, kind, 'the window');
      this.#changed();
    });
  }

  /**
   * A terminal closed. Its panes become gone, their timers stop, their markers are taken up, the
   * mapper forgets their pids, its mute is forgotten, and every Mapping pointing at it is
   * dropped, so a late event for it finds nothing to land on.
   */
  terminalClosed(terminal: T): void {
    this.#guard('the terminal close', undefined, () => {
      this.#takeUpOn(terminal, 'its terminal closed');
      for (const [pid, known] of this.#panes) {
        if (known.mapping.terminal !== terminal || known.pane.state === GONE) continue;
        this.#focus(pid, known, 'terminalClosed', 'its terminal closed');
        this.#letGo(pid);
      }
      for (const [pid, mapping] of this.#mappings) {
        if (mapping.terminal === terminal) this.#mappings.delete(pid);
      }
      if (this.#mutedTerminals.delete(terminal)) {
        this.#log(`terminal ${JSON.stringify(terminal.name)} closed, so its mute is forgotten`);
      }
      if (this.#active === terminal) this.#active = undefined;
      this.#changed();
    });
  }

  /**
   * A pane-list row click. The pane gets `gained`, exactly as a tab click would send, so an
   * unread mark clears by our own hand even when focus came back from an editor, or the pane
   * finished while its tab was already selected, and VS Code reported nothing. A click inside
   * the pane's settle is held, as a tab click is. Answers the terminal for the binding to show;
   * a waiting pane's terminal comes back too, with its mark left where it is. An unknown id, or
   * a pane whose terminal has closed, is logged and answers undefined. The event source is
   * poked for a pass either way.
   */
  focusPane(id: string): T | undefined {
    return this.#guard('the pane-list click', undefined, (): T | undefined => {
      this.#poke();
      for (const [pid, known] of this.#panes) {
        if (String(pid) !== id) continue;
        const { terminal } = known.mapping;
        if (!this.#host.terminals().includes(terminal)) {
          this.#log(`${labelOf(pid, known)} was clicked, but its terminal has closed`);
          return undefined;
        }
        this.#focus(pid, known, 'gained', 'its row was clicked');
        this.#changed();
        return terminal;
      }
      this.#log(`a row click named ${JSON.stringify(id)}, which is no pane here; nothing opened`);
      return undefined;
    });
  }

  /**
   * Mark as Seen: the member's own act on one pane, a row click that shows no terminal. The pane
   * gets `gained` down the same road a row click takes, so an unseen pane goes idle and its
   * clear is written at once, or held while its settle runs (ruling 5), exactly as a click's is;
   * a muted one too, since a click clears it the same way. Answers whether the pane changed.
   * False, each logged, for a pane that is not unseen (the model leaves any other as it is), an
   * id that names no pane here, and a pane whose terminal has closed; false as well when its
   * clear failed at the device and was undone, which logs itself and leaves the pane unseen for
   * the next try (ruling 18). The event source is poked for a pass either way (ruling 19).
   */
  markSeen(id: string): boolean {
    return this.#guard('Mark as Seen', false, (): boolean => {
      this.#poke();
      for (const [pid, known] of this.#panes) {
        if (String(pid) !== id) continue;
        const label = labelOf(pid, known);
        if (!this.#host.terminals().includes(known.mapping.terminal)) {
          this.#log(`${label} was marked seen, but its terminal has closed`);
          return false;
        }
        const before = known.pane;
        this.#focus(pid, known, 'gained', 'it was marked seen');
        const now = this.#panes.get(pid);
        if (now?.pane !== before) {
          this.#changed();
          return true;
        }
        // The same Known still there means the model left the pane as it was. A new one holding
        // the same pane is ruling 18's undo of a failed clear, which has logged its own line.
        if (now === known) this.#log(`${label} is not unseen, so there was nothing to mark`);
        return false;
      }
      this.#log(`Mark as Seen named ${JSON.stringify(id)}, which is no pane here; nothing changed`);
      return false;
    });
  }

  /**
   * A row's Mute Status: mute the pane's terminal. Every live pane there has its marker put
   * down, so its hook prints no further mark, and then its tab cleared, held while its settle
   * runs (ruling 5); a gone pane is skipped, and a claude that starts there later is muted from
   * its first event. The state of every pane stays as it was: a muted pane is still followed.
   * Answers whether the mute reached a pane: false for an id that names no pane here, a pane
   * whose terminal has closed, or one its own environment mutes, each logged. Muting a terminal
   * already muted changes nothing, logged, and still answers true.
   */
  mute(id: string): boolean {
    return this.#guard('the mute', false, (): boolean => {
      const belled = this.#bellTarget(id, 'muted');
      if (belled === undefined) return false;
      const { terminal } = belled.known.mapping;
      const label = labelOf(belled.pid, belled.known);
      if (this.#mutedTerminals.has(terminal)) {
        this.#log(`${label} was muted again; its terminal already is, so nothing changed`);
      } else {
        this.#mutedTerminals.add(terminal);
        this.#log(`${label} was muted: its terminal's tab gets no mark until it is unmuted`);
        for (const [pid, known] of this.#panes) {
          if (known.mapping.terminal !== terminal || known.pane.state === GONE) continue;
          if (!known.envMuted) this.#putDown(pid, known);
          this.#clear(pid, 'Mute Status was chosen', decidedFrom(undefined, { pane: known.pane }));
        }
      }
      this.#changed();
      return true;
    });
  }

  /**
   * A row's Unmute Status: unmute the pane's terminal. The marker of every pane there that may
   * have one down is taken up, so marks come back from each pane's next event; nothing is
   * written to the tab. Answers as mute() does. Unmuting a terminal that is not muted changes
   * nothing, logged, and still answers true.
   */
  unmute(id: string): boolean {
    return this.#guard('the unmute', false, (): boolean => {
      const belled = this.#bellTarget(id, 'unmuted');
      if (belled === undefined) return false;
      const { terminal } = belled.known.mapping;
      const label = labelOf(belled.pid, belled.known);
      if (this.#mutedTerminals.delete(terminal)) {
        this.#takeUpOn(terminal, 'its terminal was unmuted');
        this.#log(`${label} was unmuted: its marks come back from its next event`);
      } else {
        this.#log(`${label} was unmuted, but its terminal is not muted, so nothing changed`);
      }
      this.#changed();
      return true;
    });
  }

  /**
   * The liveness sweep, on the binding's timer (D4). Claude Code fires no hook when claude
   * crashes or is killed, so every live pane whose claude the host calls dead goes through the
   * model's processGone: it is retired, its clear is written at once and never undone (C17),
   * its marker is taken up, and its mapping is let go. A retired pane that kept its marker (D5)
   * has only that marker taken up once it is dead too. No panes, or none dead, does nothing.
   */
  sweep(): void {
    this.#guard('the liveness sweep', undefined, () => {
      let moved = false;
      for (const [pid, known] of this.#panes) {
        const live = known.pane.state !== GONE;
        if ((!live && !this.#marked.has(pid)) || this.#alive(pid)) continue;
        if (live) {
          this.#processGone(pid, known);
          moved = true;
        }
        this.#takeUp(pid, 'its process is gone');
      }
      if (moved) this.#changed();
    });
  }

  /**
   * Lists the claudes that were already running when the extension started, from Claude Code's
   * session registry, so a restart shows every pane at once rather than each at its next event
   * (R11). Each entry whose pid is not already known is asked of owns(), and a pid that no
   * terminal here has is skipped without a word. The rest are taken in as a first event would
   * take them, seeded with the state their registry status gives, with nothing written to any
   * tab: no clear, no settle, no sequence (ruling 17). So a pane that finished unseen before the
   * restart reads idle until its next event. A pid that became known while its lookup was out is
   * left alone, since its own event wins. A marker still down for a pid mutes its terminal again
   * (C13), and a pane on a terminal that is muted has its marker put down (D5). A pane listed
   * before this call keeps its tab (ruling 16: only speaking takes one), so an entry on a
   * terminal where one is live is kept retired until it speaks; the entries of this one call
   * retire each other as first events would. Safe to run again: a known pid is skipped. Answers
   * how many panes were taken in, and asks for one refresh if that is any. Never rejects: an
   * entry that goes wrong is logged, and the rest go on.
   */
  async discover(entries: readonly DiscoveredPane[]): Promise<number> {
    const fresh = new Set<number>();
    try {
      for (const entry of entries) {
        if (this.#disposed) break;
        try {
          if (await this.#discoverOne(entry, fresh)) fresh.add(entry.pid);
        } catch (error) {
          this.#log(`a session registry entry was skipped: ${messageOf(error)}`);
        }
      }
    } catch (error) {
      this.#log(`listing the panes already running failed, and was dropped: ${messageOf(error)}`);
    }
    if (this.#disposed) return 0;
    if (fresh.size > 0) this.#changed();
    return fresh.size;
  }

  /** One row per known pane, gone ones included: view.ts decides what shows, and in what order. */
  rows(): readonly PaneRow<T>[] {
    return this.#guard('listing the panes', Object.freeze([]), () => {
      const rows: PaneRow<T>[] = [];
      for (const [pid, known] of this.#panes) {
        const { pane, mapping, envMuted, sessionId, cwd, lastEvent } = known;
        const muted = this.#muteOf(envMuted, mapping.terminal);
        rows.push(
          Object.freeze({
            id: String(pid),
            terminal: mapping.terminal,
            name: mapping.terminal.name,
            state: pane.state,
            ...(muted === undefined ? {} : { muted }),
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(cwd === undefined ? {} : { cwd }),
            ...(lastEvent === undefined ? {} : { lastEvent }),
          }),
        );
      }
      return Object.freeze(rows);
    });
  }

  /**
   * Cancels every settle, drops every held clear, and forgets every pane and every mute. Nothing
   * runs after. The markers stay where they are: a reload re-adopts a live pane's from its next
   * event (C13), and the next activation's sweep takes up the ones whose claude has died.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const { timer } of this.#settles.values()) {
      try {
        timer.cancel();
      } catch (error) {
        this.#log(`a timer would not cancel at dispose: ${messageOf(error)}`);
      }
    }
    this.#settles.clear();
    this.#heldClears.clear();
    this.#mappings.clear();
    this.#panes.clear();
    this.#mutedTerminals.clear();
    this.#marked.clear();
  }

  #applyEvent(event: PaneEvent): void {
    const pid = event.claude_pid;
    const mapping = this.#mappings.get(pid);
    if (mapping === undefined) {
      this.#log(`ignored a ${event.event} event for claude pid ${pid}: no terminal here has it`);
      return;
    }
    if (!this.#host.terminals().includes(mapping.terminal)) {
      const name = JSON.stringify(mapping.terminal.name);
      this.#log(`ignored a ${event.event} event for claude pid ${pid}: terminal ${name} closed`);
      return;
    }
    const known = this.#panes.get(pid);
    let next: Reduction;
    try {
      next = reduce(known?.pane, { kind: 'hook', state: event.state });
    } catch (error) {
      this.#log(`ignored a ${event.event} event for claude pid ${pid}: ${messageOf(error)}`);
      return;
    }
    const { terminal } = mapping;
    // A reload forgot the set of muted terminals, not the member's choice (C13): a pid never
    // seen here whose writer says its marker held a mark back mutes its terminal again. A pid
    // already known never re-adopts, so an event written just before an unmute cannot undo it.
    const readopt = known === undefined && event.muted === MUTED_BY_MARKER;
    if (readopt && !this.#mutedTerminals.has(terminal)) {
      this.#mutedTerminals.add(terminal);
      const name = JSON.stringify(terminal.name);
      this.#log(`claude pid ${pid} still has its marker down, so terminal ${name} is muted again`);
    }
    const wasLive = known !== undefined && known.pane.state !== GONE;
    const isLive = next.pane.state !== GONE;
    // This pid starts speaking on its terminal: its first event, or its first since it went. The
    // tab's one mark is its own from here on, so every other live pane there goes first.
    if (isLive && !wasLive) this.#retireOthers(pid, terminal);
    // The shell-shaped writer has no session id to give, so its event keeps the one before.
    const sessionId = event.session_id ?? known?.sessionId;
    const updated: Known<T> = Object.freeze({
      pane: next.pane,
      mapping,
      envMuted: known?.envMuted === true || event.muted === MUTED_BY_ENV,
      ...(sessionId === undefined ? {} : { sessionId }),
      cwd: event.cwd,
      lastEvent: event.ts,
    });
    this.#panes.set(pid, updated);
    if (known?.pane !== next.pane) {
      this.#log(`${labelOf(pid, updated)}: ${event.event} made it ${next.pane.state}`);
    }
    const muted = this.#mutedTerminals.has(terminal);
    // A live pane's marker is squared with its terminal's mute at every event it sends (C23). On
    // a muted terminal it is down before the pane's next mark, whether the pane has just started
    // there or just come back; on one that is not muted, a marker still remembered is a take-up
    // that failed, and is tried again now. Its own environment keeps an env-muted pane quiet, so
    // that one is never touched either way.
    if (isLive && !updated.envMuted) {
      if (muted) this.#putDown(pid, updated);
      else if (this.#marked.has(pid)) this.#takeUp(pid, 'its terminal is not muted');
    }
    const printedMark = event.sequence !== null && event.sequence !== CLEAR_SEQUENCE;
    if (event.sequence !== null) {
      // Something is on its way to the tab. It supersedes whatever this pane was waiting on: a
      // settle, and any clear held in it, which would otherwise wipe a newer mark. A mark arms a
      // settle of its own, so a clear decided before the mark has landed waits for it.
      this.#cancelSettle(pid);
      if (printedMark) this.#armSettle(pid);
    }
    if (next.action === 'clear') {
      this.#clear(pid, `its ${event.event} event`, decidedFrom(known?.pane, next));
    }
    // A mark reached a muted tab (C14): its writer looked for the marker a moment before it was
    // down. The event says the mark went out, so this is a fact, and the clear waits for that
    // mark in the settle it has just armed.
    if (printedMark && muted) {
      this.#clear(pid, `its ${event.event} mark reached a muted tab`, decidedFrom(undefined, next));
    }
    // Its session ended: its marker goes while the pid is still its own.
    if (event.state === GONE) this.#takeUp(pid, 'its session ended');
    // Its session ended (or its first word was that it had): nothing may act for it any more.
    if (!isLive && (known === undefined || wasLive)) this.#letGo(pid);
    this.#changed();
  }

  /**
   * One registry entry for discover(): a pid already known is left alone, one no terminal here
   * has is skipped without a word (owns() logs only a lookup that failed), and the rest are
   * taken in. Answers whether it was taken in.
   */
  async #discoverOne(entry: DiscoveredPane, fresh: ReadonlySet<number>): Promise<boolean> {
    if (this.#panes.has(entry.pid)) return false;
    if (!(await this.owns(entry.pid))) return false;
    return this.#guard('listing a pane already running', false, () => this.#adopt(entry, fresh));
  }

  /**
   * A registry entry taken in as its first event would be, except that it printed nothing: its
   * seeded pane, the retirement of what it takes the tab from, the mute its marker records (C13)
   * and its own marker on a muted terminal (D5), with no clear, no settle and no sequence. Its
   * environment is unknown until its first event says, so it starts as not muted by one. An
   * entry on a terminal where a pane listed before this call is live does not take the tab: it
   * is kept retired until it speaks, and re-adopts no mute, since the pane listed there already
   * settles whether its terminal is muted. `fresh` is the pids this call has taken in, which
   * retire one another as first events would. Answers whether it was taken in.
   */
  #adopt(entry: DiscoveredPane, fresh: ReadonlySet<number>): boolean {
    const { pid } = entry;
    // Its own event landed while owns() was out: the event wins.
    if (this.#panes.has(pid)) return false;
    const mapping = this.#mappings.get(pid);
    if (mapping === undefined) return false;
    const { terminal } = mapping;
    const name = JSON.stringify(terminal.name);
    if (!this.#host.terminals().includes(terminal)) {
      this.#log(`claude pid ${pid} was already running, but terminal ${name} closed: not listed`);
      return false;
    }
    const seeded = reduce(undefined, { kind: 'hook', state: entry.state }).pane;
    if (seeded.state === GONE) {
      this.#log(`claude pid ${pid} came from the registry with no live state, so it is not listed`);
      return false;
    }
    const holder = this.#holderOf(terminal, fresh);
    if (holder === undefined) {
      this.#retireOthers(pid, terminal);
      if (entry.marked && !this.#mutedTerminals.has(terminal)) {
        this.#mutedTerminals.add(terminal);
        const why = `claude pid ${pid} still has its marker down`;
        this.#log(`${why}, so terminal ${name} is muted again`);
      }
    }
    const known: Known<T> = Object.freeze({
      pane: holder === undefined ? seeded : reduce(seeded, { kind: 'terminalClosed' }).pane,
      mapping,
      envMuted: false,
      ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
      ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
    });
    this.#panes.set(pid, known);
    const label = labelOf(pid, known);
    if (holder === undefined) {
      const listed = `so it is listed ${known.pane.state} from Claude Code's session registry`;
      this.#log(`${label} was already running, ${listed}`);
    } else {
      this.#log(
        `${label} was already running, but claude pid ${holder} already holds its tab, ` +
          'so it stays retired until it speaks',
      );
    }
    // A pid alive on a muted terminal has its marker down (D5), a retired one included; one whose
    // marker is down already is written again, so this window is the one that takes it up.
    if (entry.marked || this.#mutedTerminals.has(terminal)) this.#putDown(pid, known);
    if (holder !== undefined) this.#letGo(pid);
    return true;
  }

  /** A live pane on `terminal` that was listed before this discover() call, if one is there. */
  #holderOf(terminal: T, fresh: ReadonlySet<number>): number | undefined {
    for (const [pid, known] of this.#panes) {
      if (known.mapping.terminal !== terminal || known.pane.state === GONE) continue;
      if (!fresh.has(pid)) return pid;
    }
    return undefined;
  }

  /**
   * Every live pane on `terminal` but `pid`'s goes gone, through the model's terminalClosed.
   * That is the right input because the older claude no longer owns the tab, exactly as if its
   * terminal had closed: the one mark on the tab is the newer claude's now, and terminalClosed
   * is the one input that retires a pane from every state and never asks for a clear. A wrong
   * guess here can only leave a spurious mark (a pane that can no longer be cleared by looking),
   * never clear one. If the older claude speaks again it is revived by its own event, and
   * retires the newer one in turn. A retired pane keeps its marker (D5): its process may still
   * run on a muted terminal, and its next mark must stay as quiet as the newer claude's.
   */
  #retireOthers(pid: number, terminal: T): void {
    for (const [other, known] of this.#panes) {
      if (other === pid || known.mapping.terminal !== terminal || known.pane.state === GONE) {
        continue;
      }
      this.#focus(other, known, 'terminalClosed', `claude pid ${pid} took over its tab`);
      this.#letGo(other);
    }
  }

  /**
   * A pane has gone. Its settle and held clear go, since each would act on a mark that is no
   * longer its own; so does the Mapping owns() stashed for it, and the mapper forgets its pid,
   * so a later event for that pid is walked afresh. Its row stays, as gone: view.ts is what
   * hides it.
   */
  #letGo(pid: number): void {
    this.#cancelSettle(pid);
    this.#mappings.delete(pid);
    try {
      this.#host.forget(pid);
    } catch (error) {
      this.#log(`the mapper could not forget claude pid ${pid}: ${messageOf(error)}`);
    }
  }

  /** One focus input to every pane on `terminal`. A gone pane is the model's to leave alone. */
  #dispatch(terminal: T, kind: FocusInputKind, why: string): void {
    for (const [pid, known] of this.#panes) {
      if (known.mapping.terminal === terminal) this.#focus(pid, known, kind, why);
    }
  }

  /** One focus input through the model, the pane stored, and a clear it returns carried out. */
  #focus(pid: number, known: Known<T>, kind: FocusInputKind, why: string): void {
    const next = reduce(known.pane, { kind });
    if (next.pane !== known.pane) {
      this.#panes.set(pid, Object.freeze({ ...known, pane: next.pane }));
      this.#log(`${labelOf(pid, known)}: ${why}, so it is ${next.pane.state}`);
    }
    if (next.action === 'clear') this.#clear(pid, why, decidedFrom(known.pane, next));
  }

  /**
   * A dead claude's pane (D4): the model's processGone retires it and asks for a clear. The
   * pane is let go first, taking any settle and held clear with it, and the clear is written at
   * once, since a dead claude prints no mark that could overtake it. A write that fails is
   * logged and never undone (C17): there is no next click to retry it for a pane that is gone.
   */
  #processGone(pid: number, known: Known<T>): void {
    const next = reduce(known.pane, { kind: 'processGone' });
    this.#panes.set(pid, Object.freeze({ ...known, pane: next.pane }));
    this.#log(`${labelOf(pid, known)}: its process is gone, so it is ${next.pane.state}`);
    this.#letGo(pid);
    if (next.action !== 'clear') return;
    const failed = this.#send(pid, 'its process is gone');
    if (failed !== undefined) {
      const stays = `so it stays ${next.pane.state} and nothing retries it`;
      this.#log(`${failed}; its process is gone, ${stays}`);
    }
  }

  /**
   * A clear decided here or by the model: written now, or held until the pane's settle ends.
   * One held clear already covers the tab, so a clear with no pane to put back (a mute's) never
   * displaces one that has (a click's), whose undo is what lets the next click retry.
   */
  #clear(pid: number, why: string, decided: Decided): void {
    if (this.#settles.has(pid)) {
      if (decided.before !== undefined || !this.#heldClears.has(pid)) {
        this.#heldClears.set(pid, Object.freeze({ decided, why }));
      }
      return;
    }
    this.#write(pid, why, decided);
  }

  /** A clear written, and undone when it reached for a device and failed (ruling 18). */
  #write(pid: number, why: string, decided: Decided): void {
    const failed = this.#send(pid, why);
    if (failed !== undefined) this.#undo(pid, decided, failed);
  }

  /**
   * The write itself, through the host, with whatever it answered logged. Answers the failure,
   * worded for the log, when a device was tried and failed, the one failure a retry could mend;
   * undefined otherwise.
   */
  #send(pid: number, why: string): string | undefined {
    const known = this.#panes.get(pid);
    if (known === undefined) return undefined;
    const { mapping } = known;
    const target: ClearTarget = Object.freeze({
      shell_pid: mapping.shellPid,
      ttyPath: mapping.ttyPath,
      claude_pid: mapping.claudePid,
    });
    const label = labelOf(pid, known);
    let result: ClearResult;
    try {
      result = this.#host.clear(target);
    } catch (error) {
      this.#log(`the clear for ${label} (${why}) threw, so its mark may stay: ${messageOf(error)}`);
      return undefined;
    }
    const detail = result.detail ?? 'no detail given';
    if (result.ok) {
      this.#log(`cleared ${label} (${why}): ${detail}`);
      return undefined;
    }
    const failed = `the clear for ${label} (${why}) did not land, by ${result.how}: ${detail}`;
    if (result.how !== 'tty') {
      this.#log(`${failed}; with no device to write to, a retry cannot help`);
      return undefined;
    }
    return failed;
  }

  /**
   * Put back the pane a failed clear was decided from, so the next click retries the write. An
   * undo, never a decision: the state it restores is the one the model itself held a moment
   * earlier, and only while the pane the clear left is still the one there.
   */
  #undo(pid: number, decided: Decided, failed: string): void {
    const { before, after } = decided;
    const now = this.#panes.get(pid);
    if (before === undefined || now === undefined || now.pane !== after) {
      const why =
        before === undefined ? 'there is no earlier pane to put back' : 'the pane has moved on since';
      this.#log(`${failed}; ${why}, so it is left as it is`);
      return;
    }
    this.#panes.set(pid, Object.freeze({ ...now, pane: before }));
    this.#log(`${failed}; it is ${before.state} again, so the next click retries the clear`);
  }

  /**
   * The pane a Mute Status or Unmute Status names, when either can reach it: a pane here, on a
   * terminal still open, and not muted by its own environment. The menu offers neither for that
   * last one, but a stale menu command must still do nothing. Anything else is logged and
   * answers undefined.
   */
  #bellTarget(id: string, act: string): Belled<T> | undefined {
    // The menu item that asked, by the name the menu shows it under.
    const command = act === 'muted' ? 'Mute Status' : 'Unmute Status';
    for (const [pid, known] of this.#panes) {
      if (String(pid) !== id) continue;
      const label = labelOf(pid, known);
      if (!this.#host.terminals().includes(known.mapping.terminal)) {
        this.#log(`${label} was ${act} by ${command}, but its terminal has closed`);
        return undefined;
      }
      if (known.envMuted) {
        this.#log(
          `${label} is muted by PANE_PULSE_IGNORE in its environment, which the menu cannot ` +
            `change, so it was not ${act}`,
        );
        return undefined;
      }
      return Object.freeze({ pid, known });
    }
    this.#log(`${command} named ${JSON.stringify(id)}, which is no pane here; nothing was ${act}`);
    return undefined;
  }

  /** Why a row is muted: its environment first, then its terminal's mute; undefined if neither. */
  #muteOf(envMuted: boolean, terminal: T): MuteSource | undefined {
    if (envMuted) return MUTED_BY_ENV;
    return this.#mutedTerminals.has(terminal) ? MUTED_BY_MARKER : undefined;
  }

  /** Put a pane's marker down, once, so its hook prints no mark (D1). A failure is logged. */
  #putDown(pid: number, known: Known<T>): void {
    if (this.#marked.has(pid)) return;
    const label = labelOf(pid, known);
    try {
      this.#host.markers.add(pid);
    } catch (error) {
      const why = messageOf(error);
      this.#log(`the marker for ${label} could not be put down, so its tab may be marked: ${why}`);
      return;
    }
    this.#marked.add(pid);
    this.#log(`put down the marker for ${label}, so its hook prints no mark`);
  }

  /**
   * Take a pid's marker up. A pid with none down is asked for anyway, which is harmless; one
   * whose take-up throws stays remembered, so its next take-up tries again.
   */
  #takeUp(pid: number, why: string): void {
    try {
      this.#host.markers.remove(pid);
    } catch (error) {
      const cause = messageOf(error);
      this.#log(`the marker for claude pid ${pid} could not be taken up (${why}): ${cause}`);
      return;
    }
    if (this.#marked.delete(pid)) this.#log(`took up the marker for claude pid ${pid}: ${why}`);
  }

  /**
   * Take up the marker of every pane on `terminal` that may have one down: every live pane, and
   * every retired one this window still has marked (D5). A pane its environment mutes never had
   * one put down, and is left alone unless it is somehow marked.
   */
  #takeUpOn(terminal: T, why: string): void {
    for (const [pid, known] of this.#panes) {
      if (known.mapping.terminal !== terminal) continue;
      const live = known.pane.state !== GONE && !known.envMuted;
      if (live || this.#marked.has(pid)) this.#takeUp(pid, why);
    }
  }

  /** The host's answer on whether a pid runs. Only a plain `false` is dead; a throw reads alive. */
  #alive(pid: number): boolean {
    try {
      return this.#host.isAlive(pid) !== false;
    } catch (error) {
      const why = messageOf(error);
      this.#log(`could not tell whether claude pid ${pid} is alive, so it is left alone: ${why}`);
      return true;
    }
  }

  #armSettle(pid: number): void {
    const token = {};
    const timer = this.#host.setTimer(
      () => this.#fire(`the settle for claude pid ${pid}`, () => this.#settled(pid, token)),
      this.#settleMs,
    );
    this.#settles.set(pid, Object.freeze({ timer, token }));
  }

  /** Stops a pane's settle, and with it any clear it was holding. */
  #cancelSettle(pid: number): void {
    const settle = this.#settles.get(pid);
    this.#settles.delete(pid);
    this.#heldClears.delete(pid);
    settle?.timer.cancel();
  }

  /**
   * A settle ended: the mark it waited for has had time to land. A clear held during it is
   * written now, whatever the focus is by then; a click's was looking and a mute's was Mute
   * Status, each already decided. With nothing held there is nothing to do: a settle ending is
   * time passing, and time alone never clears a mark (ruling 17).
   */
  #settled(pid: number, token: object): void {
    if (this.#settles.get(pid)?.token !== token) return;
    this.#settles.delete(pid);
    const held = this.#heldClears.get(pid);
    if (held === undefined) return;
    this.#heldClears.delete(pid);
    this.#write(pid, `${held.why}, held until its settle ended`, held.decided);
    this.#changed();
  }

  /** A public method's body: nothing once disposed, and nothing thrown, ever. */
  #guard<R>(what: string, fallback: R, body: () => R): R {
    if (this.#disposed) return fallback;
    try {
      return body();
    } catch (error) {
      this.#log(`${what} failed, and was dropped: ${messageOf(error)}`);
      return fallback;
    }
  }

  /**
   * Ask the event source for a pass (ruling 19): a notification may have been dropped, and a
   * mark it carried would otherwise wait on disk until the next change in the folder. A poke
   * that throws is logged; the click that asked is still judged.
   */
  #poke(): void {
    try {
      this.#host.poke();
    } catch (error) {
      this.#log(`asking the event source for a pass failed: ${messageOf(error)}`);
    }
  }

  /** A timer's body: nothing once disposed, and nothing thrown into the event loop. */
  #fire(what: string, body: () => void): void {
    if (this.#disposed) return;
    try {
      body();
    } catch (error) {
      this.#log(`${what} failed, and was dropped: ${messageOf(error)}`);
    }
  }

  #changed(): void {
    try {
      this.#host.changed();
    } catch (error) {
      this.#log(`refreshing the pane list failed: ${messageOf(error)}`);
    }
  }

  #log(line: string): void {
    try {
      this.#host.log(`${LOG_PREFIX}${line}`);
    } catch {
      // Nowhere left to report it, and the controller never throws.
    }
  }
}

/** A clear reduce() just decided, frozen: the pane it was decided from, and the one it left. */
function decidedFrom(before: Pane | undefined, next: Reduction): Decided {
  return Object.freeze({ before, after: next.pane });
}

/** How a pane is named in a log line: its pid, and its terminal's name as written. */
function labelOf<T extends TerminalLike>(pid: number, known: Known<T>): string {
  return `pane ${pid} (${JSON.stringify(known.mapping.terminal.name)})`;
}
