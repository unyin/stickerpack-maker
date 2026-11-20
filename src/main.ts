import "./styles.css";
import { getAppState } from "./api";
import { renderShell } from "./shell";
import { initTheme } from "./theme";
import { renderFirstRun } from "./views/first-run";
import { el, errorMessage } from "./ui";

const rootElement = document.getElementById("app");
if (!rootElement) throw new Error("missing #app root element");
const root: HTMLElement = rootElement;

/**
 * Boot / re-boot the app from the current Rust-side state:
 * - unconfigured -> first-run Library chooser
 * - ready        -> app shell (Editor / Pack Manager / Settings)
 * - invalid      -> app shell with a banner, starting on Settings
 */
async function boot(): Promise<void> {
  try {
    const state = await getAppState();
    if (state.libraryStatus === "unconfigured") {
      renderFirstRun(root, () => void boot());
    } else {
      renderShell(root, state, () => void boot());
    }
  } catch (err) {
    root.replaceChildren(
      el(
        "div",
        { class: "fatal" },
        el("h1", {}, "Stickerpack Maker could not start"),
        el("p", {}, errorMessage(err)),
      ),
    );
  }
}

initTheme();
void boot();