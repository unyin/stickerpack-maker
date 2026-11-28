import type { ViewId } from "../shell-model";

/**
 * The navigation seam: lets code outside the shell (el() views, async
 * continuations) switch screens. Mirrors `setPackManagerListener`: one
 * registered handler, replaced by the next registration.
 */
const noop = (_view: ViewId): void => {};
let navigator: (view: ViewId) => void = noop;

/**
 * Register the handler `navigate` calls. The returned unregister restores the
 * no-op only if `next` is still the registered handler, so a stale cleanup
 * never removes a newer shell's handler.
 */
export function setNavigator(next: (view: ViewId) => void): () => void {
  navigator = next;
  return () => {
    if (navigator === next) navigator = noop;
  };
}

/** Switch the shell to `view` (a no-op while no shell is registered). */
export function navigate(view: ViewId): void {
  navigator(view);
}
