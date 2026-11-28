import { useState } from "react";
import {
  createLibrary,
  LIBRARY_DB_FILE_NAME,
  openLicenceTexts,
  pickEmojiFont,
  pickFolder,
  pickLibraryDb,
  repointLibrary,
  resolveLibraryDbSelection,
  type AppState,
  type EmojiStyle,
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
import { useMessage } from "../react/use-message";
import { el } from "../ui";

/**
 * Settings: show the Library path, re-point at another intact Library, or
 * create a fresh Library in an empty folder (SPEC §3). An older Library's
 * database is upgraded when opened; no reconstruction from orphaned files.
 * Also the emoji font choice (SPM-17), which applies in place via a runtime
 * font stack and never re-boots the app.
 */
export function SettingsView({
  state,
  onLibraryChanged,
}: {
  state: AppState;
  onLibraryChanged: () => void;
}) {
  return (
    <section className="view">
      <h1>Settings</h1>
      <LibraryCard state={state} onChanged={onLibraryChanged} />
      <AppearanceCard />
      <EmojiCard />
      <CreditsCard />
    </section>
  );
}

function LibraryCard({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  const message = useMessage();

  async function repoint(): Promise<void> {
    await message.run(async () => {
      // Option A (SPM-13): pick the library.db file itself — folder pickers
      // hide files, making the marker invisible while browsing.
      const file = await pickLibraryDb(state.libraryPath ?? undefined);
      const selection = resolveLibraryDbSelection(file);
      if (selection.kind === "cancelled") return;
      if (selection.kind === "invalid-name") {
        message.set(`Please select the ${LIBRARY_DB_FILE_NAME} file inside your Library folder.`);
        return;
      }
      await repointLibrary(selection.folder);
      onChanged();
    });
  }

  async function createFresh(): Promise<void> {
    await message.run(async () => {
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

  return (
    <div className="card">
      <label className="field-label">Library path</label>
      <code className="path">{state.libraryPath ?? "Not configured"}</code>
      <p className="muted">{`Status: ${statusText}`}</p>
      <div className="actions">
        <button className="secondary" onClick={() => void repoint()}>
          Re-point to another Library…
        </button>
        <button className="secondary" onClick={() => void createFresh()}>
          Create fresh Library…
        </button>
      </div>
      <p className="message" role="alert">{message.text}</p>
      <p className="muted">
        {"Re-pointing expects an intact Library (database included) — for example a moved or restored Library. Select the " +
          LIBRARY_DB_FILE_NAME +
          " file inside the Library folder; the app uses its folder. A fresh Library can be created in any empty folder. An older Library's database is upgraded to the current version when it is opened, but metadata is never reconstructed from orphaned image files."}
      </p>
    </div>
  );
}

function AppearanceCard() {
  const [theme, setTheme] = useState(getThemePreference);
  return (
    <div className="card">
      <label className="field-label">Appearance</label>
      <select
        className="theme-select"
        value={theme}
        onChange={(event) => {
          const next = parseThemePreference(event.target.value);
          setThemePreference(next);
          setTheme(next);
        }}
      >
        {THEME_CHOICES.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <p className="muted">
        The app follows your system dark/light setting by default. Choose Light or Dark to override it on this machine.
      </p>
    </div>
  );
}

/**
 * The emoji style card (SPM-17). Live state reads from the emoji-style
 * module, not the boot-time snapshot: the style can change in place without
 * re-booting the app (unlike the Library, which re-points). The card derives
 * what it shows at render time; `bump()` re-renders it after a change.
 */
function EmojiCard() {
  const [, setVersion] = useState(0);
  const bump = (): void => setVersion((v) => v + 1);
  // The value picked while the async choice runs (today the native select
  // already shows it); cleared in the `finally` so the select re-syncs.
  const [pending, setPending] = useState<EmojiStyle | null>(null);
  const styleMessage = useMessage();

  const preference = getEmojiStylePreference();
  const problem = emojiStyleProblem();
  const customPath = getCustomEmojiFontPath();

  function choose(value: EmojiStyle): void {
    setPending(value);
    void styleMessage.run(async () => {
      try {
        // Custom is picked THROUGH a file — but a REMEMBERED one is
        // reused without a picker (owner, from the test, 2026-11-24:
        // switching away and back must not force a re-pick; the config
        // keeps the path). The picker runs for a first-time Custom
        // choice, and again when a remembered file no longer loads —
        // with the choice rolled back, a fresh file is the only
        // in-session recovery (review round 3, same date).
        if (value === "custom") {
          const remembered = getCustomEmojiFontPath();
          if (remembered) {
            try {
              await chooseEmojiStyle("custom"); // the stored path
            } catch (err) {
              const replacement = await pickEmojiFont();
              if (!replacement) throw err; // keep the load error
              await chooseEmojiStyle("custom", replacement);
            }
          } else {
            const file = await pickEmojiFont();
            if (!file) return; // cancelled: keep the current style
            await chooseEmojiStyle("custom", file);
          }
        } else {
          await chooseEmojiStyle(value);
        }
      } finally {
        // Refresh on success AND failure: a failed choice must not
        // strand the select on a value that never applied (onchange
        // only fires on a change, so a stale select cannot be rechosen
        // — review round 3, 2026-11-24).
        setPending(null);
        bump();
      }
    });
  }

  function repick(): void {
    void styleMessage.run(async () => {
      const file = await pickEmojiFont();
      if (!file) return; // user cancelled: keep the current font
      await chooseEmojiStyle("custom", file);
      bump();
    });
  }

  return (
    <div className="card">
      <label className="field-label">Emoji font</label>
      <select
        className="emoji-style-select"
        aria-label="Emoji font"
        value={pending ?? preference}
        onChange={(event) => choose(parseEmojiStyle(event.target.value))}
      >
        {EMOJI_STYLE_CHOICES.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      {/* The choice, the custom file row, the problem and any message all
          sit under the select: eye order is use-case order. */}
      <p className="muted" hidden={preference !== "custom"}>
        {"Using: "}
        <code className="path">{customPath ?? "no file chosen"}</code>
      </p>
      {/* "Custom font file…" only fires onchange when the value CHANGES, so an
          active Custom needs its own route to a different file. */}
      <button className="secondary" type="button" hidden={preference !== "custom"} onClick={repick}>
        Choose another file…
      </button>
      <p className="message" role="alert" hidden={problem === null}>{problem ?? ""}</p>
      <p className="message" role="alert">{styleMessage.text}</p>
      <p className="muted">
        How emoji are drawn everywhere in the app. Android bundles Noto Color Emoji; Windows uses the system's Segoe UI Emoji; Custom uses a font file of yours, read from where it is — a broken or deleted file falls back to Android.
      </p>
    </div>
  );
}

function CreditsCard() {
  const licencesMessage = useMessage();
  return (
    // The owner, from the SPM-17 test (2026-11-24): credits stand in their
    // own box with a prominent title, like Library path and Appearance.
    <div className="card">
      <label className="field-label">Credits</label>
      <p className="muted">
        Noto Color Emoji by Google, licensed under the SIL Open Font License 1.1.
      </p>
      <p className="muted">
        Twemoji graphics by the Twemoji project, licensed CC-BY 4.0 (https://github.com/jdecked/twemoji).
      </p>
      <p className="muted">
        Background removal uses the ISNet model (DIS, by Xuebin Qin and colleagues), licensed under the Apache License 2.0 (https://github.com/xuebinqin/DIS).
      </p>
      <p className="muted">
        ONNX Runtime by Microsoft, licensed under the MIT License (https://github.com/microsoft/onnxruntime).
      </p>
      <p className="muted">
        The fonts' full licence texts ship with the app beside the bundled font files.
      </p>
      {/* SPM-29: every shipped component's licence text, one file beside the exe. */}
      <button
        className="secondary"
        type="button"
        onClick={() => void licencesMessage.run(openLicenceTexts)}
      >
        Open licence texts
      </button>
      <p className="message" role="alert">{licencesMessage.text}</p>
    </div>
  );
}
