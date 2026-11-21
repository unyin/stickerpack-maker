// A small modal built on <dialog>: the Pack Manager's confirmations and
// forms that need more than a native message box (previews, inputs, lists).
import { el } from "../../ui";

export interface DialogButton<T> {
  label: string;
  value: T;
  variant?: "primary" | "danger" | "secondary";
  /**
   * Runs on press; the dialog closes with `value` only when it resolves true,
   * so a failure can be shown in place. Without it, pressing closes at once.
   */
  action?: () => Promise<boolean>;
}

export interface DialogHandle<T> {
  dialog: HTMLDialogElement;
  /** Resolves with the chosen button's value, or `cancel` on Esc. */
  result: Promise<T>;
  close(value: T): void;
  buttons: Map<T, HTMLButtonElement>;
}

/**
 * Open a modal with a title, body content and buttons. `cancel` is the value
 * for Esc. `options.defaultChoice` names the button that takes initial focus
 * (so Enter presses it); without it the browser's default focus applies.
 */
export function openDialog<T>(
  title: string,
  body: Array<Node | string>,
  buttons: DialogButton<T>[],
  cancel: T,
  options: { defaultChoice?: T } = {},
): DialogHandle<T> {
  const dialog = el("dialog", { class: "pm-dialog" }) as HTMLDialogElement;
  const map = new Map<T, HTMLButtonElement>();
  let resolve!: (value: T) => void;
  const result = new Promise<T>((r) => (resolve = r));
  let done = false;
  const close = (value: T) => {
    if (done) return;
    done = true;
    dialog.close();
    dialog.remove();
    resolve(value);
  };
  const row = el("div", { class: "actions pm-dialog-actions" });
  for (const b of buttons) {
    const btn = el("button", { class: b.variant ?? "secondary", type: "button" }, b.label) as HTMLButtonElement;
    btn.addEventListener("click", async () => {
      if (!b.action) return close(b.value);
      btn.disabled = true;
      try {
        if (await b.action()) close(b.value);
      } finally {
        btn.disabled = false;
      }
    });
    map.set(b.value, btn);
    row.append(btn);
  }
  dialog.append(el("h2", {}, title), el("div", { class: "pm-dialog-body" }, ...body), row);
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close(cancel);
  });
  document.body.append(dialog);
  dialog.showModal();
  if (options.defaultChoice !== undefined) map.get(options.defaultChoice)?.focus();
  return { dialog, result, close, buttons: map };
}

/** A yes/no confirmation; resolves true on confirm. */
export function confirmDialog(
  title: string,
  body: Array<Node | string>,
  confirmLabel: string,
  danger = false,
): Promise<boolean> {
  return openDialog<boolean>(
    title,
    body,
    [
      { label: "Cancel", value: false },
      { label: confirmLabel, value: true, variant: danger ? "danger" : "primary" },
    ],
    false,
  ).result;
}

/** True while any Pack Manager dialog is open (keyboard shortcuts pause). */
export function dialogOpen(): boolean {
  return document.querySelector("dialog.pm-dialog[open]") !== null;
}
