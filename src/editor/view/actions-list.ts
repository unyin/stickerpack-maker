// The Actions tab's read-only list (SPEC §6 Layout, SPM-15 D3): every
// undoable document action, oldest first, with the present marked, plus the
// selection's own steps (SPM-23) nested under one "Select" row after the
// last document action. A clickable jump to a state is a planned later
// promotion, so nothing here is interactive and nothing is a button.
//
// The document trail comes from EditorSession.actionTrail(); the selection
// states from EditorSession.selectionTrail(). Each Region state carries the
// contributions it was built from, so a nested step's wording is derived
// from the state itself: a plain Rectangle/Lasso says which it is, and a
// composed step is its LAST contribution — the one that step added.
//
// The SPM-23 lifetime rules do the clearing: a document edit empties the
// selection trail, so the Select row and its steps vanish with the next
// refresh; this module only renders what the session holds.
//
// The rendered list is always ACTION_LIST_ROWS lines tall: real lines first,
// blank striped rows filling the rest (owner, from the test, 2026-11-25), so
// a fresh session reads as lined paper rather than a bare box.
import { el } from "../../ui";
import type { ActionTrail } from "../model/history";
import type { Contribution, PolyContribution, Region } from "../model/region";
import type { SelectionTrail } from "../model/session";

/** One row of the list. */
export interface ActionRow {
  /** The row's text ("Opened image" for the session start). */
  readonly text: string;
  /** The trail's present position (a document state; the selection steps are current by construction). */
  readonly current: boolean;
  /** Rendered indented under the Select row (a selection step). */
  readonly nested: boolean;
  /** The Select entry that owns the nested steps. */
  readonly select: boolean;
}

/** The list as the panel renders it. */
export interface ActionListModel {
  readonly rows: readonly ActionRow[];
  /** The session has done nothing yet: the muted "No actions yet." line says so. */
  readonly empty: boolean;
}

/** The session start's label (the trail's null entry, SPEC §6 Layout). */
export const SESSION_START = "Opened image";

/**
 * The list's height in rows: real lines are topped up with blank striped
 * rows to this many, so a fresh session already shows the lined-notepad
 * look (owner, from the test, 2026-11-25). Seven matches the Layers box's
 * row cap; with more real lines than this there are no blanks and the box
 * scrolls as before.
 */
export const ACTION_LIST_ROWS = 7;

/** The list's rows for the session's two trails: the document's, then the selection's. */
export function actionList(trail: ActionTrail, selection: SelectionTrail): ActionListModel {
  const rows: ActionRow[] = trail.labels.map((label, index) => ({
    text: label ?? SESSION_START,
    current: index === trail.currentIndex,
    nested: false,
    select: false,
  }));
  const steps: string[] = [];
  for (const state of selection.states) {
    const text = stepText(state);
    if (text !== null) steps.push(text);
  }
  // One Select entry, after the last document action, holding every
  // selection step; with no selection and no trail there is no entry.
  if (steps.length > 0) {
    rows.push({ text: "Select", current: false, nested: false, select: true });
    for (const text of steps) rows.push({ text, current: false, nested: true, select: false });
  }
  return { rows, empty: trail.labels.length <= 1 && steps.length === 0 };
}

/** A selection state's own step row, or none for the empty state (a step to no selection). */
function stepText(state: Region | null): string | null {
  if (state === null) return null;
  if (state.kind !== "compose") return `+ ${state.kind === "rect" ? "rectangle region" : "lasso region"}`;
  const own = state.contributions[state.contributions.length - 1];
  return own ? contributionText(own) : null;
}

/** One contribution's row: its sign and the tool's region name. */
function contributionText(contribution: Contribution): string {
  const sign = contribution.op === "subtract" ? "−" : "+";
  return `${sign} ${contribution.kind === "wand" ? "wand region" : polygonName(contribution)}`;
}

/**
 * A polygon step's name, from the tool that drew it; a contribution without
 * one (a plain region carried into a compose) falls back to the geometry:
 * Rectangle draws an axis-aligned four-corner box, anything else is a Lasso.
 */
function polygonName(contribution: PolyContribution): string {
  if (contribution.shape) return `${contribution.shape} region`;
  const points = contribution.points;
  const box =
    points.length === 4 &&
    points.every((p, i) => {
      const next = points[(i + 1) % 4];
      return p.x === next.x || p.y === next.y;
    });
  return box ? "rectangle region" : "lasso region";
}

/** Fill the tab's list: one row per label, the present marked, the selection nested under Select,
 * blank striped rows up to ACTION_LIST_ROWS (decoration: hidden from assistive tech). */
export function renderActionList(list: HTMLElement, model: ActionListModel): void {
  const items: HTMLElement[] = [];
  let sub: HTMLElement | null = null;
  for (const row of model.rows) {
    const item = el("li", {}, row.text);
    if (row.current) {
      item.classList.add("is-current");
      item.setAttribute("aria-current", "step");
      item.append(el("span", { class: "editor-actions-badge" }, "current"));
    }
    if (row.select) {
      sub = el("ol", { class: "editor-actions-sub" });
      item.append(sub);
    } else if (row.nested) {
      sub?.append(item); // the model always places a Select row first
      continue;
    }
    items.push(item);
  }
  if (model.empty) items.push(el("li", { class: "editor-actions-empty muted" }, "No actions yet."));
  // Top up to the notepad's row count; the nested steps count as lines too,
  // since they are what the user sees. The blanks carry no text or listener:
  // the CSS gives them a line box and the same zebra as a real row.
  const lines = model.rows.length + (model.empty ? 1 : 0);
  for (let i = lines; i < ACTION_LIST_ROWS; i++) {
    items.push(el("li", { class: "editor-actions-fill", "aria-hidden": "true" }));
  }
  list.replaceChildren(...items);
}
