import { createLibrary, getDefaultLibraryPath, pickFolder } from "../api";
import { clear, el, errorMessage, withMessage } from "../ui";

/**
 * First-run flow: no Library path configured yet. Suggests the default
 * Documents\Stickerpack Library, lets the user pick another folder, then
 * creates the folder + database and persists the path (SPEC §3).
 */
export function renderFirstRun(
  container: HTMLElement,
  onReady: () => void,
): void {
  clear(container);

  let chosenPath: string | null = null;
  let userChose = false;
  const pathDisplay = el("code", { class: "path" }, "Resolving default…");
  const message = el("p", { class: "message", role: "alert" });
  const createBtn = el(
    "button",
    { class: "primary", disabled: true },
    "Create Library",
  ) as HTMLButtonElement;

  async function chooseFolder(): Promise<void> {
    await withMessage(message, async () => {
      const folder = await pickFolder(chosenPath ?? undefined);
      if (!folder) return; // user cancelled
      chosenPath = folder;
      userChose = true;
      pathDisplay.textContent = folder;
      createBtn.disabled = false;
    });
  }

  async function create(): Promise<void> {
    if (!chosenPath) return;
    createBtn.disabled = true;
    message.textContent = "";
    try {
      await createLibrary(chosenPath);
      onReady();
    } catch (err) {
      message.textContent = errorMessage(err);
      createBtn.disabled = false;
    }
  }

  createBtn.addEventListener("click", () => void create());

  container.append(
    el(
      "div",
      { class: "first-run" },
      el("h1", {}, "Welcome to Stickerpack Maker"),
      el(
        "p",
        {},
        "Stickerpack Maker keeps every pack and sticker file in a Library — an app-managed folder containing the SQLite database and one folder per pack. Choose where your Library should live.",
      ),
      el(
        "div",
        { class: "card" },
        el("label", { class: "field-label" }, "Library folder"),
        pathDisplay,
        el(
          "div",
          { class: "actions" },
          el(
            "button",
            { class: "secondary", onclick: () => void chooseFolder() },
            "Choose folder…",
          ),
          createBtn,
        ),
        message,
      ),
      el(
        "p",
        { class: "muted" },
        "You can re-point at another Library or create a fresh one later in Settings.",
      ),
    ),
  );

  // Resolve the suggested default (Documents\Stickerpack Library) — never
  // clobber a folder the user picked while the resolution was in flight.
  void (async () => {
    try {
      const suggested = await getDefaultLibraryPath();
      if (userChose) return;
      chosenPath = suggested;
      pathDisplay.textContent = suggested;
      createBtn.disabled = false;
    } catch (err) {
      if (userChose) return;
      pathDisplay.textContent = "No default available — choose a folder.";
      message.textContent = errorMessage(err);
    }
  })();
}