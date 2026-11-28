import "./styles.css";
import "./dialog.css";
import { createElement } from "react";
import { getAppState } from "./api";
import { applyEmojiStyle } from "./emoji-style";
import { renderShell } from "./shell";
import { initTheme } from "./theme";
import { mountView, unmountShell, unmountViews } from "./react/mount";
import { FirstRun } from "./views/first-run";
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
      unmountShell();
      mountView(
        root,
        "first-run",
        createElement(FirstRun, { onReady: () => void boot() }),
      );
    } else {
      // The persisted emoji style (SPM-17), before any view can render
      // emoji; a broken custom file falls back to Android with a problem
      // shown in Settings (applyEmojiStyle never throws).
      await applyEmojiStyle(state.emojiStyle, state.customEmojiFontPath);
      unmountViews();
      renderShell(root, state, () => void boot());
    }
  } catch (err) {
    unmountViews();
    unmountShell();
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