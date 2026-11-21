// The app's one modal, built on <dialog>: every two-option confirmation and
// every form that needs more than a native message box. Styles: dialog.css.
import { CANCEL_CHOICE, confirmButtons, type ConfirmSpec } from "./dialog-model";
import { el } from "./ui";

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
  const dialog = el("dialog", { class: "app-dialog" }) as HTMLDialogElement;
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
  const row = el("div", { class: "actions app-dialog-actions" });
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
  dialog.append(el("h2", {}, title), el("div", { class: "app-dialog-body" }, ...body), row);
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close(cancel);
  });
  document.body.append(dialog);
  dialog.showModal();
  if (options.defaultChoice !== undefined) map.get(options.defaultChoice)?.focus();
  return { dialog, result, close, buttons: map };
}

/**
 * The two-option confirmation, used for every two-option question in the app
 * (SPEC §5): title, body, the action and keep labels. The safe choice (keep)
 * is focused and primary unless `defaultChoice` says otherwise; Esc and close
 * always keep. Resolves true only for the action.
 */
export async function confirmChoice(
  title: string,
  body: Array<Node | string>,
  spec: ConfirmSpec,
): Promise<boolean> {
  const defaultChoice = spec.defaultChoice ?? "keep";
  const chosen = await openDialog(title, body, confirmButtons(spec), CANCEL_CHOICE, { defaultChoice }).result;
  return chosen === "action";
}

/** True while any dialog is open (keyboard shortcuts pause). */
export function dialogOpen(): boolean {
  return document.querySelector("dialog.app-dialog[open]") !== null;
}
