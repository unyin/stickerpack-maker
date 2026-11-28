import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

/**
 * The mount registry: one content view at a time, plus the shell root that
 * hosts it. `createRoot` is called only here (and in other src/react/ files).
 *
 * Switch order, always: (a) unmount every tracked React root, (b)
 * `container.replaceChildren()`, (c) mount the next. React 19 warns on a dirty
 * container, so nothing is mounted over leftover nodes.
 *
 * None of these functions is ever called from inside a React render or commit:
 * `root.unmount()` there warns and cannot flush, and `flushSync` there warns
 * and cannot flush either. Callers are DOM/React event handlers, the navigator
 * (el() handlers and `await` continuations) and main.ts's `boot()`
 * continuation. The shell's content leaf has no JSX children by construction;
 * this registry is the only writer of its contents.
 */

/** A view the registry tracks: a React root, or el() DOM that dies with `replaceChildren`. */
type Entry =
  | { kind: "react"; container: HTMLElement; root: Root }
  | { kind: "dom"; container: HTMLElement };

/** Views currently mounted, by view id. Invariant: React roots never outlive their view. */
const views = new Map<string, Entry>();

/** The shell's own root, tracked apart from the views it hosts. */
let shellRoot: Root | null = null;

/**
 * Render `element` as the React view `id` inside `container`. A view already
 * mounted on this container is re-rendered in place (fresh props on a
 * re-boot); otherwise every tracked view is unmounted, the container emptied
 * and a new root rendered inside `flushSync`, so the first paint is complete
 * on return.
 */
export function mountView(
  container: HTMLElement,
  id: string,
  element: ReactElement,
): void {
  const existing = views.get(id);
  if (existing && existing.kind === "react" && existing.container === container) {
    existing.root.render(element);
    return;
  }
  unmountViews();
  container.replaceChildren();
  const root = createRoot(container);
  views.set(id, { kind: "react", container, root });
  flushSync(() => root.render(element));
}

/** Mount an el()-built view: unmount every tracked view, then replace the container's children with `node`. */
export function mountDomView(container: HTMLElement, id: string, node: Node): void {
  unmountViews();
  container.replaceChildren(node);
  views.set(id, { kind: "dom", container });
}

/**
 * Unmount every tracked React root and drop every entry (DOM entries are just
 * dropped). Never touches the shell root.
 */
export function unmountViews(): void {
  for (const entry of views.values()) {
    if (entry.kind === "react") entry.root.unmount();
  }
  views.clear();
}

/**
 * Render the shell into `container` as its own root, replacing any previous
 * shell (and the views it hosted). The render runs inside `flushSync`, so the
 * shell's refs are attached on return.
 */
export function mountShell(container: HTMLElement, element: ReactElement): void {
  unmountShell();
  container.replaceChildren();
  const root = createRoot(container);
  shellRoot = root;
  flushSync(() => root.render(element));
}

/** Unmount the shell root; its views die first, before the shell that hosts them. */
export function unmountShell(): void {
  unmountViews();
  shellRoot?.unmount();
  shellRoot = null;
}
