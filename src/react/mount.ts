import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * React roots currently alive, by view id. The container is kept so "this view
 * is still mounted on this container" is answerable. Invariant: React roots
 * never outlive their view.
 */
const roots = new Map<string, { container: HTMLElement; root: Root }>();

/**
 * Render `element` as the view `id` inside `container`. A view already mounted
 * on this container is re-rendered in place (fresh props on a re-boot); any
 * other tracked root is unmounted first, then a new root is created.
 * Never call from inside a React render or commit.
 */
export function mountView(
  container: HTMLElement,
  id: string,
  element: ReactElement,
): void {
  const existing = roots.get(id);
  if (existing && existing.container === container) {
    existing.root.render(element);
    return;
  }
  unmountViews();
  const root = createRoot(container);
  roots.set(id, { container, root });
  root.render(element);
}

/**
 * Unmount every tracked root. Called before the DOM a root sits in is cleared
 * or replaced. Never call from inside a React render or commit.
 */
export function unmountViews(): void {
  for (const { root } of roots.values()) root.unmount();
  roots.clear();
}
