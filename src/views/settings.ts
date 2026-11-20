import {
  createLibrary,
  LIBRARY_DB_FILE_NAME,
  pickFolder,
  pickLibraryDb,
  repointLibrary,
  resolveLibraryDbSelection,
  type AppState,
} from "../api";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  getThemePreference,
  setThemePreference,
  type ThemePreference,
} from "../theme";
import { clear, el, withMessage } from "../ui";

/**
 * Settings: show the Library path, re-point at another intact Library, or
 * create a fresh Library in an empty folder (SPEC §3). No auto-migration,
 * no reconstruction from orphaned files.
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
      const confirmed = await ask(
        `Create a fresh Library in:\n${folder}\n\nThe folder must be empty. Existing files are never migrated or reconstructed.`,
        { title: "Create fresh Library", kind: "warning" },
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
            " file inside the Library folder; the app uses its folder. A fresh Library can be created in any empty folder. There is no auto-migration, and metadata is never reconstructed from orphaned image files.",
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
              setThemePreference(value as ThemePreference);
            },
          },
          el(
            "option",
            { value: "system", selected: getThemePreference() === "system" },
            "Follow system",
          ),
          el(
            "option",
            { value: "light", selected: getThemePreference() === "light" },
            "Light",
          ),
          el(
            "option",
            { value: "dark", selected: getThemePreference() === "dark" },
            "Dark",
          ),
        ),
        el(
          "p",
          { class: "muted" },
          "The app follows your system dark/light setting by default. Choose Light or Dark to override it on this machine.",
        ),
      ),
    ),
  );
}