import { useEffect, useRef, useState } from "react";
import { createLibrary, getDefaultLibraryPath, pickFolder } from "../api";
import { errorMessage } from "../ui";

/**
 * First-run flow: no Library path configured yet. Suggests the default
 * Documents\Stickerpack Library, lets the user pick another folder, then
 * creates the folder + database and persists the path (SPEC §3).
 */
export function FirstRun({ onReady }: { onReady: () => void }) {
  const [chosenPath, setChosenPath] = useState<string | null>(null);
  const [pathText, setPathText] = useState("Resolving default…");
  const [message, setMessage] = useState("");
  const [createDisabled, setCreateDisabled] = useState(true);
  // Mirror of "the user picked a folder", read at resolution time by the
  // default-resolution effect (state captured at mount would be stale).
  const userChose = useRef(false);

  // Resolve the suggested default (Documents\Stickerpack Library) — never
  // clobber a folder the user picked while the resolution was in flight.
  useEffect(() => {
    void (async () => {
      try {
        const suggested = await getDefaultLibraryPath();
        if (userChose.current) return;
        setChosenPath(suggested);
        setPathText(suggested);
        setCreateDisabled(false);
      } catch (err) {
        if (userChose.current) return;
        setPathText("No default available — choose a folder.");
        setMessage(errorMessage(err));
      }
    })();
  }, []);

  async function chooseFolder(): Promise<void> {
    setMessage("");
    try {
      const folder = await pickFolder(chosenPath ?? undefined);
      if (!folder) return; // user cancelled
      setChosenPath(folder);
      userChose.current = true;
      setPathText(folder);
      setCreateDisabled(false);
    } catch (err) {
      setMessage(errorMessage(err));
    }
  }

  async function create(): Promise<void> {
    if (!chosenPath) return;
    setCreateDisabled(true);
    setMessage("");
    try {
      await createLibrary(chosenPath);
      onReady();
    } catch (err) {
      setMessage(errorMessage(err));
      setCreateDisabled(false);
    }
  }

  return (
    <div className="first-run">
      <h1>Welcome to Stickerpack Maker</h1>
      <p>
        Stickerpack Maker keeps every pack and sticker file in a Library — an app-managed folder containing the SQLite database and one folder per pack. Choose where your Library should live.
      </p>
      <div className="card">
        <label className="field-label">Library folder</label>
        <code className="path">{pathText}</code>
        <div className="actions">
          <button className="secondary" onClick={() => void chooseFolder()}>
            Choose folder…
          </button>
          <button
            className="primary"
            disabled={createDisabled}
            onClick={() => void create()}
          >
            Create Library
          </button>
        </div>
        <p className="message" role="alert">
          {message}
        </p>
      </div>
      <p className="muted">
        You can re-point at another Library or create a fresh one later in Settings.
      </p>
    </div>
  );
}
