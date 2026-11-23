// The eyedropper beside every colour swatch in the Editor (SPEC §6, owner
// decision 2026-11-23): the browser EyeDropper API samples a colour from
// the whole screen — the canvas included — and the pick lands exactly as
// typing the hex into the picker would. The native input type=color stays
// the visual picker; its own internal eyedropper cannot be repaired. No
// model state lives here: the callers already know what a colour means.
import { el } from "../../ui";
import { icon } from "../../icons";
import { isHexColor } from "../model/text";

/** Why the button is disabled when the webview lacks the API (SPEC section 2). */
const EYEDROPPER_MISSING = "The eyedropper is not available here.";

/** The browser API the button runs, declared here: the DOM lib has no EyeDropper type. */
interface EyeDropperLike {
  open(): Promise<{ sRGBHex: string }>;
}
type EyeDropperConstructor = { new (): EyeDropperLike };

/** The EyeDropper API, or null when this webview does not ship it. */
function eyeDropperApi(): EyeDropperConstructor | null {
  return "EyeDropper" in window ? (window as unknown as { EyeDropper: EyeDropperConstructor }).EyeDropper : null;
}

/**
 * An icon-only button that samples a colour from the screen and hands it to
 * `pick` (lowercase hex, validated): the same path as typing the colour
 * into the picker. A cancelled sample (the promise rejecting) changes
 * nothing, silently. Where the webview lacks the API the button renders
 * disabled with its reason as its tooltip, so the feature stays
 * discoverable (SPEC section 2).
 *
 * `enroll` joins the button with the caller's busy-disable loop: the
 * button pushes itself only when the API exists, since one without it is
 * disabled for good and a re-enabling loop must never pick it up. Passing
 * the loop is all the caller does — a new picker cannot forget the rule.
 */
export function eyedropperButton(
  pick: (hex: string) => void,
  enroll: { disabled: boolean }[] = [],
): HTMLButtonElement {
  const button = el(
    "button",
    { class: "editor-eyedropper", type: "button", title: "Pick a colour from the screen", "aria-label": "Pick a colour from the screen" },
    icon("eyedropper"),
  ) as HTMLButtonElement;
  const api = eyeDropperApi();
  if (!api) {
    button.disabled = true;
    button.title = EYEDROPPER_MISSING;
    return button;
  }
  enroll.push(button);
  button.addEventListener("click", async () => {
    try {
      const { sRGBHex } = await new api().open();
      const hex = sRGBHex.toLowerCase();
      if (isHexColor(hex)) pick(hex);
    } catch {
      // The sample was cancelled: nothing changes, silently.
    }
    // Give up focus once done, so the Editor's shortcuts work at once (as the pickers do).
    button.blur();
  });
  return button;
}
