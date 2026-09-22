// The status bar's VS Code half: one item summarising every pane, and nothing else.
//
// What the item says is statusSummary() in view.ts, which has no vscode import so node --test
// can hold it to the plan: the marked states that have panes, most urgent first, as the same
// glyphs the tabs show, or the pulse alone when nothing is marked. This file only puts that on
// the item, so it is checked by typecheck and by the manual gate. A click on the item runs
// SHOW_PANES_COMMAND, which the wiring registers to reveal the pane list.
import type { Disposable, StatusBarItem } from 'vscode';
import { StatusBarAlignment, window } from 'vscode';

import { SHOW_PANES_COMMAND, countRows, statusSummary } from './view.ts';
import type { PaneRow } from './view.ts';

/**
 * On the left, where the window-wide items sit. The priority is kept low: a higher number
 * places an item further left, and this one has no claim to push in ahead of VS Code's own.
 */
const STATUS_BAR_PRIORITY = 10;

/** The item's name where VS Code lists status-bar items, so Rob can hide it by name. */
const STATUS_BAR_NAME = 'Pane Pulse';

/** The status-bar item that counts the panes needing Rob. */
export class PaneStatusBar implements Disposable {
  readonly #rows: () => readonly PaneRow<unknown>[];
  readonly #item: StatusBarItem;

  /**
   * `rows` is asked afresh on every refresh. `item` is injected so a caller can hand in its own;
   * left out, a new item is created on the left with a modest priority.
   */
  constructor(
    rows: () => readonly PaneRow<unknown>[],
    item: StatusBarItem = window.createStatusBarItem(StatusBarAlignment.Left, STATUS_BAR_PRIORITY),
  ) {
    this.#rows = rows;
    this.#item = item;
    this.#item.name = STATUS_BAR_NAME;
  }

  /**
   * Puts the current counts on the item and shows it. A screen reader hears the tooltip's words
   * rather than the codicon names the text is made of.
   */
  refresh(): void {
    const summary = statusSummary(countRows(this.#rows()));
    this.#item.text = summary.text;
    this.#item.tooltip = summary.tooltip;
    this.#item.accessibilityInformation = { label: summary.tooltip };
    this.#item.command = SHOW_PANES_COMMAND;
    this.#item.show();
  }

  dispose(): void {
    this.#item.dispose();
  }
}
