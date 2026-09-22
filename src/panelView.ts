// The Panes panel's VS Code half: the webview view in the Pane Pulse sidebar, the page it loads,
// and the two messages that page sends back.
//
// Nothing the panel shows is decided here. panel.ts renders the whole list as one string of HTML,
// and webview/main.ts swaps that string in, places the peek and turns a click into a message. This
// file gives VS Code a page to load it into (the shell: a Content Security Policy, the codicon and
// panel stylesheets, the script), posts each render to it, puts the badge on the activity-bar
// icon, and hands a row's click back to the wiring through the `open` it was built with. So it is
// checked by typecheck, by the build and by the manual gate: logic added here is logic no unit
// test reaches.
//
// Five rules this file is built around:
//
//   * THE PAGE RUNS ONLY WHAT IT SHIPS. The policy is `default-src 'none'`, with styles, fonts and
//     images allowed only from the extension's own files (the webview's cspSource, with dist/ as
//     the one local resource root) and the one script allowed only by a nonce made afresh each
//     time the shell is built. There is no 'unsafe-inline' of any kind, which is why panel.ts
//     writes no style attribute (P1): Chromium would drop every one.
//   * THE PAGE IS BUILT AGAIN, EMPTY, EACH TIME THE VIEW IS SHOWN. retainContextWhenHidden stays
//     off, since a page kept alive while hidden holds memory for nothing a render cannot rebuild,
//     so VS Code throws the page away while the view is collapsed or covered and loads the shell
//     again when it comes back. The page says `ready` once its script runs, and `ready` is always
//     answered with the current render, whatever was posted before (P12).
//   * A RENDER IS POSTED ONLY WHEN IT IS NEWS, AND ONLY TO A PAGE ON SCREEN. The wiring renders on
//     every change and every tick, so HTML equal to the last one posted is not posted again, and a
//     quiet tick moves nothing under the mouse. Nothing is posted while the view is hidden: there
//     is no page to take it, and the next page's `ready` asks for the render anyway. A post VS Code
//     says it did not deliver is forgotten, so the next render goes out.
//   * THE BADGE BELONGS TO THE VIEW. VS Code creates the view the first time the sidebar shows it,
//     and only from then is there a view to carry a badge (P12), so the latest badge is kept here
//     and set the moment a view exists; undefined takes it away. A view the member hides from its
//     title menu is disposed, and the next one VS Code resolves gets the badge and the render
//     afresh.
//   * NOTHING THROWS OUT. A disposed view throws from its setters, and a message from the page is
//     whatever the page sent, so every VS Code call and every handler here is guarded: a failure
//     is logged, opening with LOG_PREFIX, and dropped.
//
// It imports vscode, so no test loads it; src/extension.ts builds one, registers it for VIEW_ID
// and calls show() on every render. The HTML it posts is panel.ts's, escaped there; the only text
// this file puts into markup itself is the shell's own, with each URI and the CSP source escaped.
import { randomBytes } from 'node:crypto';

import type { Disposable, Event, ViewBadge, Webview, WebviewView, WebviewViewProvider } from 'vscode';
import { EventEmitter, Uri } from 'vscode';

import { escapeHtml } from './panel.ts';
import { VIEW_ID } from './view.ts';

/** Every line this module logs opens with this, as the other modules' lines do. */
export const LOG_PREFIX = 'pane-pulse panel: ';

/** The one message this file posts: the whole list, as HTML. */
const RENDER_MESSAGE = 'render';

/** The page's two messages: it can take a render, and a row was clicked or had Enter pressed. */
const READY_MESSAGE = 'ready';
const OPEN_MESSAGE = 'open';

/** The folder the page loads everything from, and the one local resource root it is given. */
const DIST_DIRNAME = 'dist';

/** The page's files, under DIST_DIRNAME, as esbuild.mjs writes them. */
const CODICON_CSS: readonly string[] = Object.freeze(['codicons', 'codicon.css']);
const PANEL_CSS: readonly string[] = Object.freeze(['panel.css']);
const PAGE_SCRIPT: readonly string[] = Object.freeze(['webview.js']);

/** The page's title, which a screen reader announces for the frame. */
const PAGE_TITLE = 'Panes';

/** How many random bytes make a nonce: 128 bits, written as hex. */
const NONCE_BYTES = 16;

/** The longest pane id an `open` is taken with; a pane is named by a claude pid, a few digits. */
const MAX_ID_LENGTH = 32;

/** How much of an unknown message a log line quotes. */
const QUOTE_LIMIT = 120;

/** The activity-bar badge: how many panes need Rob, and the tooltip that says so. */
export type PanelBadge = Readonly<{ value: number; tooltip: string }>;

/** What a PanelView is built with. */
export type PanelViewOptions = Readonly<{
  /** The extension's own folder, whose dist/ holds the page's files. */
  extensionUri: Uri;
  /** A row was clicked, or had Enter pressed: the wiring opens that pane. Named by its id. */
  open: (id: string) => void;
  /** One line to the output channel. */
  log: (line: string) => void;
}>;

function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'an error that could not be printed';
  }
}

/** A value as a log line shows it, capped; never a throw, whatever the page sent. */
function quote(value: unknown): string {
  try {
    const text = JSON.stringify(value) ?? String(value);
    return text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}...` : text;
  } catch {
    return 'a value that could not be printed';
  }
}

/** Whether two badges say the same thing; two absent badges do. */
function sameBadge(a: PanelBadge | undefined, b: PanelBadge | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.value === b.value && a.tooltip === b.tooltip;
}

/**
 * The Panes view: registered with `window.registerWebviewViewProvider(VIEW_ID, view)`, handed each
 * render through show(), and disposed through the extension's subscriptions. Its visibility, which
 * the wiring's tickers follow, is `visible` and `onDidChangeVisibility`.
 */
export class PanelView implements WebviewViewProvider, Disposable {
  /** The view this provider fills: package.json's `panePulse.panes`, a `webview` view. */
  static readonly viewType = VIEW_ID;

  readonly #extensionUri: Uri;
  readonly #open: (id: string) => void;
  readonly #log: (line: string) => void;
  readonly #visibility = new EventEmitter<boolean>();

  /** Fires with whether the view is on screen: when it is resolved, shown, hidden or disposed. */
  readonly onDidChangeVisibility: Event<boolean> = this.#visibility.event;

  /** The view VS Code resolved, until it is disposed; undefined before the sidebar first shows it. */
  #view: WebviewView | undefined;
  /** The current view's own event subscriptions, let go when it is disposed or replaced. */
  #listeners: Disposable[] = [];
  /** The latest render the wiring handed in: what `ready` is answered with. */
  #html: string | undefined;
  /** The render last posted to the current page, or undefined when the page may hold none. */
  #posted: string | undefined;
  /** The latest badge the wiring handed in, and the one the current view carries now. */
  #badge: PanelBadge | undefined;
  #shownBadge: PanelBadge | undefined;
  #disposed = false;

  constructor(options: PanelViewOptions) {
    this.#extensionUri = options.extensionUri;
    this.#open = options.open;
    const log = options.log;
    this.#log = (line: string): void => {
      try {
        log(`${LOG_PREFIX}${line}`);
      } catch {
        // Nowhere left to report it, and nothing here throws.
      }
    };
  }

  /** Whether the view is on screen now: resolved, expanded and in the sidebar that is showing. */
  get visible(): boolean {
    try {
      return this.#view?.visible === true;
    } catch {
      return false;
    }
  }

  /**
   * VS Code's call, the first time the view is shown and again after a view the member hid comes
   * back: the page's options and shell are set, its messages and visibility followed, and the
   * latest badge put on it. The render itself goes out when the page says `ready`.
   */
  resolveWebviewView(view: WebviewView): void {
    if (this.#disposed) return;
    try {
      this.#release();
      this.#view = view;
      this.#posted = undefined;
      this.#shownBadge = undefined;
      const { webview } = view;
      webview.options = {
        enableScripts: true,
        localResourceRoots: [Uri.joinPath(this.#extensionUri, DIST_DIRNAME)],
      };
      // Followed before the shell is set, so not even the page's first message can be missed.
      this.#listeners = [
        webview.onDidReceiveMessage((message: unknown) => this.#receive(view, message)),
        view.onDidChangeVisibility(() => this.#visibilityChanged(view)),
        view.onDidDispose(() => this.#viewDisposed(view)),
      ];
      webview.html = this.#shell(webview);
      this.#setBadge(view);
      this.#fireVisibility(this.visible);
      this.#log('the Panes view is set up; its list follows once its page says it is ready');
    } catch (error) {
      this.#log(
        `could not set up the Panes view, so it may stay empty until it is shown again: ` +
          messageOf(error),
      );
    }
  }

  /**
   * The wiring's latest render and badge. The badge goes on the view at once, when there is one;
   * the HTML is posted only when it differs from the last one posted and the view is on screen.
   * Either is kept, for a view resolved later and for the next page's `ready`.
   */
  show(html: string, badge: PanelBadge | undefined): void {
    if (this.#disposed) return;
    try {
      this.#html = html;
      this.#badge = badge;
      const view = this.#view;
      if (view === undefined) return;
      this.#setBadge(view);
      if (html !== this.#posted && this.visible) this.#post(view, html);
    } catch (error) {
      this.#log(`could not show the latest list, so the view keeps the one before: ${messageOf(error)}`);
    }
  }

  /** Lets go of the view's events and the visibility event; the view itself is VS Code's. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#release();
    this.#view = undefined;
    this.#posted = undefined;
    try {
      this.#visibility.dispose();
    } catch {
      // An emitter that will not dispose has nobody left listening once the extension stops.
    }
  }

  /** The view was shown or hidden. Shown again with a page that missed renders: they go now. */
  #visibilityChanged(view: WebviewView): void {
    if (view !== this.#view || this.#disposed) return;
    const visible = this.visible;
    // A page VS Code kept through the hide has missed every render since; one it rebuilt says
    // `ready` and is answered in full, so this post is at worst one render early.
    if (visible && this.#html !== undefined && this.#html !== this.#posted) {
      this.#post(view, this.#html);
    }
    this.#fireVisibility(visible);
  }

  /** The member hid the view from its title menu: forget it until VS Code resolves another. */
  #viewDisposed(view: WebviewView): void {
    if (view !== this.#view) return;
    this.#release();
    this.#view = undefined;
    this.#posted = undefined;
    this.#shownBadge = undefined;
    this.#fireVisibility(false);
  }

  /** One message from the page: `ready` is answered with the current render, `open` handed on. */
  #receive(view: WebviewView, message: unknown): void {
    try {
      if (view !== this.#view || this.#disposed) return;
      const fields =
        typeof message === 'object' && message !== null
          ? (message as Readonly<Record<string, unknown>>)
          : undefined;
      if (fields?.type === READY_MESSAGE) {
        // A page that says ready is empty, whatever was posted to the page before it (P12).
        if (this.#html !== undefined) this.#post(view, this.#html);
        return;
      }
      if (fields?.type === OPEN_MESSAGE) {
        const { id } = fields;
        if (typeof id === 'string' && id !== '' && id.length <= MAX_ID_LENGTH) {
          this.#open(id);
          return;
        }
        this.#log(`ignored a row click that named no pane (${quote(id)})`);
        return;
      }
      this.#log(`ignored a message from the Panes view that is none of its own: ${quote(message)}`);
    } catch (error) {
      this.#log(`a message from the Panes view failed, and was dropped: ${messageOf(error)}`);
    }
  }

  /** Posts one render to the page; one VS Code did not deliver is forgotten, so the next goes. */
  #post(view: WebviewView, html: string): void {
    this.#posted = html;
    const forget = (): void => {
      if (this.#view === view && this.#posted === html) this.#posted = undefined;
    };
    try {
      void Promise.resolve(view.webview.postMessage({ type: RENDER_MESSAGE, html })).then(
        (delivered: boolean): void => {
          if (delivered !== true) forget();
        },
        (error: unknown): void => {
          forget();
          this.#log(`the list was not posted, so the next change posts it: ${messageOf(error)}`);
        },
      );
    } catch (error) {
      forget();
      this.#log(`the list could not be posted, so the next change posts it: ${messageOf(error)}`);
    }
  }

  /** The latest badge on the view, unless it already carries that one. */
  #setBadge(view: WebviewView): void {
    if (sameBadge(this.#badge, this.#shownBadge)) return;
    const badge: ViewBadge | undefined = this.#badge;
    try {
      view.badge = badge;
      this.#shownBadge = badge;
    } catch (error) {
      this.#log(`could not set the activity-bar badge, so it may be out of date: ${messageOf(error)}`);
    }
  }

  #fireVisibility(visible: boolean): void {
    try {
      this.#visibility.fire(visible);
    } catch (error) {
      this.#log(`a visibility listener failed: ${messageOf(error)}`);
    }
  }

  /** Lets go of the current view's event subscriptions. */
  #release(): void {
    const listeners = this.#listeners;
    this.#listeners = [];
    for (const listener of listeners) {
      try {
        listener.dispose();
      } catch (error) {
        this.#log(`a view subscription would not let go: ${messageOf(error)}`);
      }
    }
  }

  /**
   * The page: the policy (P1), the codicon font's stylesheet then the panel's, the empty list and
   * the hidden peek webview/main.ts fills, and its script, last, so both elements exist when it
   * runs. The nonce is new every time the shell is built.
   */
  #shell(webview: Webview): string {
    const nonce = randomBytes(NONCE_BYTES).toString('hex');
    const source = escapeHtml(webview.cspSource);
    const href = (parts: readonly string[]): string =>
      escapeHtml(
        webview.asWebviewUri(Uri.joinPath(this.#extensionUri, DIST_DIRNAME, ...parts)).toString(),
      );
    const policy = [
      "default-src 'none'",
      `style-src ${source}`,
      `font-src ${source}`,
      `img-src ${source} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="UTF-8">',
      `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `<link rel="stylesheet" href="${href(CODICON_CSS)}">`,
      `<link rel="stylesheet" href="${href(PANEL_CSS)}">`,
      `<title>${escapeHtml(PAGE_TITLE)}</title>`,
      '</head>',
      '<body>',
      '<div id="list"></div>',
      '<div id="peek" class="peek" hidden></div>',
      `<script nonce="${nonce}" src="${href(PAGE_SCRIPT)}"></script>`,
      '</body>',
      '</html>',
    ].join('\n');
  }
}
