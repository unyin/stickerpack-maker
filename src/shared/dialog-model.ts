// Pure rules of the app's two-option confirmation (SPEC §2 UI conventions, owner decision
// 2026-11-21): one design for every two-option question. The safe choice is the
// default (focused, primary); Esc and closing choose it.

export type Choice = "action" | "keep";

/** The safe choice: the default button, and what Esc and closing resolve to. */
export const SAFE_CHOICE: Choice = "keep";

export interface ConfirmSpec {
  /** Label of the action button (what the question proposes). */
  actionLabel: string;
  /** Label of the keep/cancel button. */
  keepLabel: string;
  /** Style the action as destructive. */
  danger?: boolean;
}

export interface ConfirmButton {
  label: string;
  value: Choice;
  variant: "primary" | "danger" | "secondary";
}

/** The two buttons, action first, keep last; the keep button is primary. */
export function confirmButtons(spec: ConfirmSpec): ConfirmButton[] {
  return [
    { label: spec.actionLabel, value: "action", variant: spec.danger ? "danger" : "secondary" },
    { label: spec.keepLabel, value: "keep", variant: "primary" },
  ];
}
