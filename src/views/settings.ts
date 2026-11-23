import {
  createLibrary,
  LIBRARY_DB_FILE_NAME,
  pickEmojiFont,
  pickFolder,
  pickLibraryDb,
  repointLibrary,
  resolveLibraryDbSelection,
  type AppState,
} from "../api";
import {
  chooseEmojiStyle,
  EMOJI_STYLE_CHOICES,
  emojiStyleProblem,
  getCustomEmojiFontPath,
  getEmojiStylePreference,
  parseEmojiStyle,
} from "../emoji-style";
import { confirmChoice } from "../dialog";
import {
  getThemePreference,
  parseThemePreference,
  setThemePreference,
  THEME_CHOICES,
} from "../theme";
import { clear, el, withMessage } from "../ui";

/**
 * Settings: show the Library path, re-point at another intact Library, or
 * create a fresh Library in an empty folder (SPEC §3). An older Library's
 * database is upgraded when opened; no reconstruction from orphaned files.
 * Also the emoji font choice (SPM-17), which applies in place via a runtime
 * font stack and never re-boots the app.
 */
export function renderSettings(
  container: HTMLElement,
  state: AppState,
  onChanged: () => void,
): void {
  clear(container);

  const message = el("p", { class: "message", role: "alert" });

  async function repoint(): Promise<void> {
    await withMessage(message, async () => {
      // Option A (SPM-13): pick the library.db file itself — folder pickers
      // hide files, making the marker invisible while browsing.
      const file = await pickLibraryDb(state.libraryPath ?? undefined);
      const selection = resolveLibraryDbSelection(file);
      if (selection.kind === "cancelled") return;
      if (selection.kind === "invalid-name") {
        message.textContent = `Please select the ${LIBRARY_DB_FILE_NAME} file inside your Library folder.`;
        return;
      }
      await repointLibrary(selection.folder);
      onChanged();
    });
  }

  async function createFresh(): Promise<void> {
    await withMessage(message, async () => {
      const folder = await pickFolder();
      if (!folder) return; // user cancelled
      const confirmed = await confirmChoice(
        "Create fresh Library",
        [
          el("p", {}, "Create a fresh Library in:"),
          el("code", { class: "path" }, folder),
          el("p", {}, "The folder must be empty. Existing files are never migrated or reconstructed."),
        ],
        { actionLabel: "Create Library", keepLabel: "Cancel" },
      );
      if (!confirmed) return;
      await createLibrary(folder);
      onChanged();
    });
  }

  const statusText =
    state.libraryStatus === "ready"
      ? "Ready"
      : state.libraryStatus === "invalid"
        ? `Not usable: ${state.libraryError ?? "unknown problem"}`
        : "Not configured";

  // The emoji style card (SPM-17). Live state reads from the emoji-style
  // module, not the boot-time snapshot: the style can change in place
  // without re-booting the app (unlike the Library, which re-points).
  const styleMessage = el("p", { class: "message", role: "alert" });
  const styleProblem = el("p", { class: "message", role: "alert" });
  const customPathRow = el("p", { class: "muted" });
  const repickButton = el(
    "button",
    { class: "secondary", type: "button" },
    "Choose another file…",
  ) as HTMLButtonElement;
  repickButton.addEventListener("click", () => {
    void withMessage(styleMessage, async () => {
      const file = await pickEmojiFont();
      if (!file) return; // user cancelled: keep the current font
      await chooseEmojiStyle("custom", file);
      refreshEmojiCard();
    });
  });
  const styleSelect = el(
    "select",
    {
      class: "emoji-style-select",
      "aria-label": "Emoji font",
      onchange: (event) => {
        const value = parseEmojiStyle((event.target as HTMLSelectElement).value);
        void withMessage(styleMessage, async () => {
          // Custom is picked THROUGH a file: the choice applies only after a
          // font has loaded from a real file, so the option never lands
          // without one. Cancelling the picker keeps the previous style.
          if (value === "custom") {
            const file = await pickEmojiFont();
            if (!file) {
              styleSelect.value = getEmojiStylePreference();
              return;
            }
            await chooseEmojiStyle("custom", file);
          } else {
            await chooseEmojiStyle(value);
          }
          refreshEmojiCard();
        });
      },
    },
    ...EMOJI_STYLE_CHOICES.map(({ value, label }) =>
      el(
        "option",
        { value, selected: getEmojiStylePreference() === value },
        label,
      ),
    ),
  ) as HTMLSelectElement;
  /** Refresh the in-place card bits: the choice, the problem line, the
   * custom file row and its re-pick button. The style itself is the runtime
   * var, not a re-render. */
  function refreshEmojiCard(): void {
    styleSelect.value = getEmojiStylePreference();
    const problem = emojiStyleProblem();
    styleProblem.textContent = problem ?? "";
    styleProblem.hidden = problem === null;
    const customPath = getCustomEmojiFontPath();
    customPathRow.replaceChildren(
      "Using: ",
      el("code", { class: "path" }, customPath ?? "no file chosen"),
    );
    // "Custom font file…" only fires onchange when the value CHANGES, so an
    // active Custom needs its own route to a different file.
    repickButton.hidden = getEmojiStylePreference() !== "custom";
    customPathRow.hidden = getEmojiStylePreference() !== "custom";
  }
  refreshEmojiCard();

  container.append(
    el(
      "section",
      { class: "view" },
      el("h1", {}, "Settings"),
      el(
        "div",
        { class: "card" },
        el("label", { class: "field-label" }, "Library path"),
        el(
          "code",
          { class: "path" },
          state.libraryPath ?? "Not configured",
        ),
        el("p", { class: "muted" }, `Status: ${statusText}`),
        el(
          "div",
          { class: "actions" },
          el(
            "button",
            { class: "secondary", onclick: () => void repoint() },
            "Re-point to another Library…",
          ),
          el(
            "button",
            { class: "secondary", onclick: () => void createFresh() },
            "Create fresh Library…",
          ),
        ),
        message,
        el(
          "p",
          { class: "muted" },
          "Re-pointing expects an intact Library (database included) — for example a moved or restored Library. Select the " +
            LIBRARY_DB_FILE_NAME +
            " file inside the Library folder; the app uses its folder. A fresh Library can be created in any empty folder. An older Library's database is upgraded to the current version when it is opened, but metadata is never reconstructed from orphaned image files.",
        ),
      ),
      el(
        "div",
        { class: "card" },
        el("label", { class: "field-label" }, "Appearance"),
        el(
          "select",
          {
            class: "theme-select",
            onchange: (event) => {
              const value = (event.target as HTMLSelectElement).value;
              setThemePreference(parseThemePreference(value));
            },
          },
          ...THEME_CHOICES.map(({ value, label }) =>
            el(
              "option",
              { value, selected: getThemePreference() === value },
              label,
            ),
          ),
        ),
        el(
          "p",
          { class: "muted" },
          "The app follows your system dark/light setting by default. Choose Light or Dark to override it on this machine.",
        ),
      ),
      el(
        "div",
        { class: "card" },
        el("label", { class: "field-label" }, "Emoji font"),
        styleSelect,
        // The choice, the custom file row, the problem and any message all
        // sit under the select: eye order is use-case order.
        customPathRow,
        repickButton,
        styleProblem,
        styleMessage,
        el(
          "p",
          { class: "muted" },
          "How emoji are drawn everywhere in the app. Android bundles Noto Color Emoji; Windows uses the system's Segoe UI Emoji; Custom uses a font file of yours, read from where it is — a broken or deleted file falls back to Android.",
        ),
      ),
      // The owner, from the SPM-17 test (2026-11-24): credits stand in their
      // own box with a prominent title, like Library path and Appearance.
      el(
        "div",
        { class: "card" },
        el("label", { class: "field-label" }, "Credits"),
        el(
          "p",
          { class: "muted" },
          "Noto Color Emoji by Google, licensed under the SIL Open Font License 1.1.",
        ),
        el(
          "p",
          { class: "muted" },
          "Twemoji graphics by the Twemoji project, licensed CC-BY 4.0 (https://github.com/jdecked/twemoji).",
        ),
        el(
          "p",
          { class: "muted" },
          "The full licence texts ship with the app beside the bundled font files.",
        ),
      ),
    ),
  );
}