// Minimal DOM helpers. The scaffold uses no UI framework; the Editor's canvas
// library choice is deferred to SPM-5 (SPEC §9).

type Attrs = Record<string, string | boolean | EventListener>;

export function el(
  tag: string,
  attrs: Attrs = {},
  ...children: Array<Node | string>
): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "function") {
      if (key.startsWith("on")) {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      }
    } else if (typeof value === "boolean") {
      if (value) node.setAttribute(key, "");
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) node.append(child);
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

/** Tauri command errors arrive as strings; normalize anything else. */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Run a view action with its message element: clear the message first,
 * route any error into it. For actions needing extra recovery on failure,
 * catch inside the action instead.
 */
export async function withMessage(
  message: HTMLElement,
  action: () => Promise<void>,
): Promise<void> {
  message.textContent = "";
  try {
    await action();
  } catch (err) {
    message.textContent = errorMessage(err);
  }
}