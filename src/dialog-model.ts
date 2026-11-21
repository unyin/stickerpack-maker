// Pure rules of the app's two-option confirmation (SPEC §5, owner decision
// 2026-11-21): one design for every two-option question. The safe choice is
// the default (focused, primary); Esc and close resolve to it.

export type Choice = "action" | "keep";

export interface ConfirmSpec {
  /** Label of the action button (what the question proposes). */
  actionLabel: string;
  /** Label of the keep/cancel button. */
  keepLabel: string;
  /** The default (focused, primary) button. Defaults to "keep", the safe one. */
  defaultChoice?: Choice;
  /** Style the action as destructive (when it is not the default). */
  danger?: boolean;
}

export interface ConfirmButton {
  label: string;
  value: Choice;
  variant: "primary" | "danger" | "secondary";
}

/** The two buttons, action first, keep second; the default one is primary. */
export function confirmButtons(spec: ConfirmSpec): ConfirmButton[] {
  const def = spec.defaultChoice ?? "keep";
  return [
    {
      label: spec.actionLabel,
      value: "action",
      variant: def === "action" ? "primary" : spec.danger ? "danger" : "secondary",
    },
    { label: spec.keepLabel, value: "keep", variant: def === "keep" ? "primary" : "secondary" },
  ];
}

/** What Esc and closing the dialog resolve to: always keep (the safe choice). */
export const CANCEL_CHOICE: Choice = "keep";
