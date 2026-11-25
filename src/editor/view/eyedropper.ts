// The eyedropper beside every colour swatch in the Editor (SPEC §6, owner
// decision 2026-11-23, CMT-296): the pick is CANVAS-ONLY. The browser
// EyeDropper API ships in WebView2 but its sampler does not work in the
// embedded runtime (the owner's Windows test saw no sampler at all), so
// presence-based detection was a false positive and the API route is gone:
// the button starts a canvas pick on the stage instead. The native input
// type=color stays the visual picker. No model state lives here: the
// callers already know what a picked colour means.
import { el } from "../../ui";
import { icon } from "../../icons";

/** The button's meaning, as its tooltip and aria-label (owner-vetoable copy, one place). */
const PICK_FROM_CANVAS = "Pick a colour from the canvas";
/** The §2 tooltip: Name — description (SPEC §6 Layout). */
const PICK_TITLE = `Eyedropper — ${PICK_FROM_CANVAS}`;

/**
 * An icon-only button that starts a canvas colour pick: the view wires
 * `pick` to the stage, and the completed sample lands through the caller's
 * own apply path, exactly as typing the hex into the picker would. The
 * button is always enabled while a session is open; it joins `enroll` -
 * the caller's busy-disable loop - itself, so a third picker cannot forget
 * the rule.
 */
export function eyedropperButton(pick: () => void, enroll: { disabled: boolean }[]): HTMLButtonElement {
  const button = el(
    "button",
    { class: "editor-eyedropper", type: "button", title: PICK_TITLE, "aria-label": PICK_FROM_CANVAS },
    icon("eyedropper"),
  ) as HTMLButtonElement;
  enroll.push(button);
  button.addEventListener("click", () => {
    pick();
    button.blur(); // the Editor's shortcuts work at once, as after a picker commit
  });
  return button;
}
