# S02: Shell chrome in React, mount registry, Settings (Phase 2)

Covers A1 (mount registry + navigation seam), A2 (shell.ts → shell.tsx), A3
(settings.ts → settings.tsx) of [../phases/phase-2.md](../phases/phase-2.md).

Corrections to the phase file:
- The tooltip-site split is off at HEAD ca0b993: `grep -rnoE '\.title ?=' src
  --include=*.ts` finds **81** `.title =` property writes (phase says ~97), and
  `title:` attr sites number **67** (sum 148 vs the phase's 147). No decision
  depends on the split; Phase 2's actionable tooltip scope is unchanged (the two
  shell sites; settings.ts has zero `title` attributes — verified).
- Phase 1 does not fix the filename of the `mountView()` module (phase-1.md says
  "shell.ts (or src/react/)"); the master plan's binding contract #1 pins it to
  `src/react/`. This plan refers to it as "the S01 mountView module" — read the
  S01 diff for the exact filename before extending it.

## Goal
Deliver the phase's mixed boundary: `src/shell.ts` becomes `src/shell.tsx`
rendering the top bar, banner and an empty content leaf as React; the Phase 1
`mountView()` helper grows into the heterogeneous registry (React roots + el()
DOM mounts, exactly one view at a time); `src/views/settings.ts` becomes
`settings.tsx` with a React twin of `withMessage`; Pack Manager and Editor stay
el() views mounted through the registry. When the session ends, all three
screens render with today's exact class names, the shell survives re-boot with
no dirty-container warning, the build and all 25 test files pass, and every
file on the do-not-touch list is byte-identical.

## Preconditions
- Phase 0 decisions landed: framework ADR (React 19, adoption-only), ticket 08
  look-and-feel verdict, sequencing call (master plan hard constraints).
- S01 (Phase 1) landed and its Windows check passed: react/react-dom deps,
  `jsx: react-jsx`, plugin-react, `src/views/first-run.tsx` pilot, and the
  `mountView()` root-tracking helper + `unmountViews()` in `src/react/` (exact
  filename per the S01 diff).
- Nothing of Phase 2 exists in the tree today (verified at ca0b993: no
  `src/react/`; `src/shell.ts` 156 lines and `src/views/settings.ts` 306 lines,
  both el()-built).
- Only `src/main.ts` imports `renderShell` (main.ts:5, extensionless — survives
  the `.tsx` rename); only `src/shell.ts` calls `renderSettings` (shell.ts:97);
  no test file imports shell or settings (tests/shell-model.test.ts touches
  only the pure `shell-model.ts`, which is untouched).

## Files touched
| Path | Status |
|---|---|
| `src/react/<S01 mountView module>` (the file S01 created for `mountView`/`unmountViews`) | exists after S01 — verify exact name in the S01 diff; modified (registry extension) |
| `src/react/navigation.ts` | new (~20 LOC) |
| `src/react/Icon.tsx` | new |
| `src/shell.ts` → `src/shell.tsx` | rename + rewrite (old file deleted, not dead code) |
| `src/icons.ts` | one-word edit: line 8 `const PATHS` → `export const PATHS` (the only edit) |
| `src/views/settings.ts` → `src/views/settings.tsx` | rename + rewrite (old file deleted) |
| `src/react/use-message.ts` | new (~15 LOC) |

Verified untouched (byte-identical at exit): `src/dialog.ts` (93), `src/combobox.ts`
(266), `src/theme.ts` (65), `src/shell-model.ts` (38), `src/ui.ts` (52),
`src/main.ts` (44), `src/views/editor.ts`, `src/views/pack-manager.ts`,
`src/editor/**`, `src/pack-manager/**`, all five CSS files, `index.html`,
`tests/**`.

## Work plan
1. **A1 — extend the registry** in the S01 mountView module. S01's shape: a
   module-level `Map<string, Root>`, `mountView(container, id, element)`
   (re-render into an existing root on re-boot, else unmount and drop every
   tracked root, then createRoot + render) and `unmountViews()`. Phase 2
   extension (master plan binding contract #1):
   - Two entry kinds: React roots, and plain DOM mounts tracked as "not a
     root, dies with replaceChildren".
   - Exactly one view at a time. Switch order, always: (a) unmount every
     tracked React root, (b) `container.replaceChildren()`, (c) mount the next.
     Document this order in a doc comment on the module (A1's named exit).
   - Track the shell root separately: one `createRoot` per `renderShell` call;
     on re-boot unmount the previous shell root (and all view roots) before
     touching the container — React 19 warns on a dirty container (phase risk 1).
   - API (adjust names to S01's): `mountView(...)` unchanged shape for React
     views, plus a DOM-mount entry point (e.g. `mountDomView(container, id,
     node)`) and a shell-root entry point with unmount-first semantics. The
     content leaf has zero JSX children by construction; the registry is the
     only writer of `contentRef.current` (phase risk 2).
2. **A1 — `src/react/navigation.ts`** (~20 LOC), the module-level seam mirroring
   `setPackManagerListener`: `setNavigator(next: (view: ViewId) => void)` and
   `navigate(view: ViewId)`. Default handler is a no-op. Registration returns an
   unregister that restores the no-op **only if `next` is still the registered
   handler** (the same replace-semantics pack-manager.ts:41-43 documents —
   phase risk 3). Import `ViewId` from `../shell-model` (type-only import;
   shell-model.ts untouched).
3. **A2 — icons.** One-word edit in `src/icons.ts:8`: `export const PATHS`.
   New `src/react/Icon.tsx` emitting byte-identical markup to `icon()`
   (icons.ts:59-68): `<svg class="icon icon-{name}" viewBox="0 0 24 24"
   aria-hidden="true" focusable="false">` with one `<path d>` per PATHS entry.
   JSX attribute order must match `icon()`'s set order (class, viewBox,
   aria-hidden, focusable) so the emitted `outerHTML` compares equal.
   Rationale (phase): React cannot take a raw `SVGSVGElement` as a JSX child; a
   ref-append would add a stray node. `icon()`/`explorerLabel()`/`IconName` stay
   for un-migrated sites.
4. **A2 — `src/shell.tsx`.** Keep the exported signature exactly:
   `renderShell(container: HTMLElement, state: AppState, onChanged: () => void)`
   (main.ts:5,30 needs no change). Body: unmount the previous shell root if one
   is tracked (re-boot), `container.replaceChildren()`, createRoot, render
   `<Shell/>`; the shell root is tracked separately from view roots.
   `<Shell state onChanged>` renders:
   - `<header className="topbar">` with children in today's order (shell.ts:127-134):
     `<span className="tb-slot">` (back button), `<nav className="nav">`
     (Editor + Pack Manager tabs), `<span className="brand">Stickerpack
     Maker</span>`, and the Settings tab button appended directly to the header
     (not inside `nav`). Move the TABS table and PM_TAB into shell.tsx
     unchanged (shell.ts:23-27).
   - The banner exactly when `state.libraryStatus === "invalid"`
     (shell.ts:135-146): `<div className="banner" role="alert">` with
     `<strong>Library problem. </strong>`, then `state.libraryError ?? "The
     configured Library is not usable."`, then the literal `" Open Settings to
     re-point at an intact Library or create a fresh one."` (leading space is
     part of the string).
   - `<main className="content" ref={contentRef}/>` — an empty ref-leaf with no
     JSX children, ever.
   - Back button (shell.ts:49): class `secondary tb-back`, `type="button"`,
     `title={BACK_TO_LIST_TITLE}` (static), text `← Pack list`. Visibility by
     toggling `tb-hidden` per `backButtonState(screen, pm).visible`; `disabled`
     per `.disabled` (busy included). Click → `showPackList()` directly —
     `showPackList` never switches the shell screen (the back button is only
     visible while the shell is already on pack-manager), so it stays a direct
     call, not a `navigate` call.
   - Tab buttons: `className="nav-btn" data-view={id}`, children
     `<Icon name={...}/>` + label. Click handler (shell.ts:123-126): `const
     action = tabClickAction(item.id, screen, pm)`; `"list"` → `showPackList()`,
     `"show"` → `show(item.id)`, `"none"` → nothing (busy-pack refusal).
   - The PM tab renders `<Icon layers/> Pack Manager` plus, when
     `packTabLabel(screen, pm.open).packTitle !== null`:
     `<span className="tab-sep" aria-hidden="true">›</span>` and
     `<span className="tab-pack">{tab.packTitle}</span>`. The tooltip is
     `title={tab.tooltip ?? ""}` — the `?? ""` is load-bearing: today's code
     sets the empty string, not attribute removal (shell.ts:77-78); JSX
     `title={tab.tooltip}` would remove the attribute on null.
   - PM state via `useSyncExternalStore(subscribe, packManagerState)` — a thin
     adapter over `setPackManagerListener` living inside shell.tsx. The
     subscribe callback is installed with `setPackManagerListener(cb)` and its
     cleanup restores a no-op only if `cb` is still the registered listener
     (track the installed listener module-level; `setPackManagerListener` has
     no unset API — pack-manager.ts:41-43). `packManagerState()` returns a
     stable reference replaced only on `publish` (changed() gate), so it is a
     valid snapshot. `refreshChrome` and its `shownTitle`/`pmTab.title` guards
     die — the render is the refresh. Publishes fired mid-mount by
     `renderPackManager` land as listener callbacks → re-render, replacing
     today's trailing `refreshChrome()` call in `show()` (shell.ts:104).
   - `show(view)` becomes `setScreen(view)` (useState, initial value
     `state.libraryStatus === "invalid" ? "settings" : "editor"`) plus a mount
     effect keyed on `screen`: teardown runs `unmountViews()`; the body clears
     `contentRef` and mounts through the registry — editor:
     `mountDomView(content, renderEditor())`; pack-manager: `mountDomView(content,
     renderPackManager(state.libraryPath, { openInEditor, openThumbnailInEditor }))`;
     settings: `mountView(content, <SettingsView state={state}
     onLibraryChanged={...}/>)`. `renderSettings` keeps its signature
     (settings.tsx) as the registry-mount wrapper the effect calls.
   - The re-boot callback stops at the boundary (phase §"mixed boundary" item 5):
     `onLibraryChanged = () => { forgetPackManager(); resetPackMemory();
     forgetEditorOrigin(); onChanged(); }` — exactly today's trio + `onChanged`
     (shell.ts:97-101). No keyed `<Shell>` this phase; Phase 2 deliberately
     keeps full root unmount/remount per boot.
   - `setEditorNav` wired via the navigator (shell.ts:105-113): register in a
     mount effect `setNavigator(show)` (cleanup unregisters — no-op only if
     still ours), then call `setEditorNav({ showSticker: (packId, stickerId) =>
     { revealStickerOnShow(packId, stickerId); navigate("pack-manager"); },
     showThumbnail: (packId) => { revealThumbnailOnShow(packId);
     navigate("pack-manager"); } })`. Route the closures' view switches through
     `navigate` so a re-boot makes previously-registered closures safe.
   - `openInEditor`/`openThumbnailInEditor` (shell.ts:111-118) become
     `PackManagerNav` closures calling `void openFileInEditor(path, () =>
     navigate("editor"), origin)` / `void openThumbnailFileInEditor(path, () =>
     navigate("editor"), origin)`; `navigate` is module-stable, so per-render
     closure recreation is safe.
   - JSX uses `className` (emits `class`); attribute order per element must
     match today's el() insertion order (back button: class, type, title; tab
     buttons: class, data-view; banner: class, role) for the outerHTML
     byte-equality check.
5. **A3 — `src/react/use-message.ts`** (~15 LOC): the React twin of
   `withMessage` (ui.ts:41-52). `useMessage(): { text: string; run(action:
   () => Promise<void>): Promise<void> }` — `run` clears the text state, awaits
   the action, routes `errorMessage(err)` into state on throw, never throws.
   The caller always renders `<p className="message" role="alert">{text}</p>`
   (empty when unset) so the element holds a stable tree position across
   re-renders (phase risk 4). `withMessage` stays untouched in ui.ts for
   un-migrated views.
6. **A3 — `src/views/settings.tsx`.** Four cards as components in today's order
   (Library path, Appearance, Emoji font, Credits) with identical classes
   (settings.ts:206-306): `view`, `card`, `field-label`, `path`, `muted`,
   `actions`, `secondary`, `message` + `role="alert"`, `theme-select`,
   `emoji-style-select`, `code.path`. Keep existing aria exactly (`aria-label:
   "Emoji font"` on the select); add nothing (UI-audience rule).
   - Library card: `statusText` logic verbatim (settings.ts:74-78); `repoint`
     and `createFresh` flows verbatim via `useMessage`. `createFresh`'s
     `confirmChoice` call stays the imperative island call — dialog.ts is
     untouched and appends to `document.body`, outside every React root.
   - Appearance card: theme.ts reused verbatim, no store. Select `onChange` →
     `setThemePreference(parseThemePreference(value))`; the selected option is
     component-local state seeded from `getThemePreference()`. React note: the
     options' `selected:` attrs (settings.ts:222-226) must become a controlled
     `value={...}` on the `<select>` (React warns on `selected` in options).
   - Emoji card as derived state replacing the imperative `refreshEmojiCard()`
     loop (settings.ts:177-204):
     - A version-bump snapshot state; `refreshEmojiCard()` becomes `bump()` and
       the card derives select value, problem line, custom-path row and repick
       visibility from `getEmojiStylePreference()` / `emojiStyleProblem()` /
       `getCustomEmojiFontPath()` at render time.
     - The SPM-17 review-round-3 rule preserved exactly (settings.ts:169-176):
       the bump runs in the `finally` of the onchange flow, on success AND
       failure, so a failed choice cannot strand the select (onchange only
       fires on a change, so a stale select cannot be rechosen).
     - The select is controlled (`value={getEmojiStylePreference()}`) and
       re-syncs on the bump; options from `EMOJI_STYLE_CHOICES`, labels
       verbatim.
     - The custom branch's remembered-custom-font recovery kept line-for-line
       (settings.ts:139-157): remembered path → `chooseEmojiStyle("custom")`
       without a picker; on throw → `pickEmojiFont()` for a replacement,
       cancelled → rethrow the load error; no remembered path → picker,
       cancelled → return. The repick button ("Choose another file…",
       settings.ts:104-112) and `customPathRow` ("Using: " + `code.path`, "no
       file chosen" fallback) are hidden unless the current preference is
       "custom".
     - `styleProblem`: problem text or hidden; `styleMessage` and the Library
       message: one `useMessage` each.
   - Credits card: all five `<p className="muted">` texts verbatim
     (settings.ts:253-275); "Open licence texts" button routes
     `openLicenceTexts` errors to its own `useMessage` line
     (settings.ts:80-87).
7. Run `bun run build` and `bun test`; then the S02 exit checks below. Old
   `shell.ts` and `settings.ts` are deleted in the rename, not left as dead
   code.

## Deliberately out of scope
- `dialog.ts` and `combobox.ts`: untouched imperative islands (firm phase
  decisions) — no wrapper, no re-implementation, no ComboboxIsland escape
  hatch. Their consumers stay as they are.
- `theme.ts`, `shell-model.ts`, `ui.ts`, `main.ts`, `views/editor.ts`,
  `views/pack-manager.ts`, `src/editor/**`, `src/pack-manager/**`, all five CSS
  files, `index.html`, `tests/**`: byte-identical.
- No keyed `<Shell>` / persistent root (Phase 3/4's centralization), no
  dialog-body bridge (Phase 3), no FontPicker work (Phase 4).
- No icon changes (Icons rule), no new aria/role attributes, no Styling.
- The B1 contract sweep (tooltip mechanics, focus checks, stale-navigation
  drill) is S03's work — this session only builds.
- No `<StrictMode>` anywhere (binding contract #3).

## Exit criteria
- `bun run build` passes; `bun test` passes (25 files).
- `git diff --stat` shows zero bytes for: dialog.ts, combobox.ts, theme.ts,
  shell-model.ts, ui.ts, main.ts, views/editor.ts, views/pack-manager.ts,
  src/editor/**, src/pack-manager/**, all five .css, index.html; icons.ts diff
  is exactly the one-word `export`.
- `document.querySelector('.topbar').outerHTML` byte-equal before/after
  (attribute order per step 4); same check for the banner tree when
  `libraryStatus === "invalid"`.
- All three screens reachable via tab clicks; the PM tab shows `› {Title}` and
  follows pack renames live; back button visibility/disabled per
  `backButtonState` including busy; PM-tab click on an open pack goes to the
  list; busy-pack tab click does nothing.
- Broken-library boot lands on Settings with the banner; library re-point →
  re-boot unmounts cleanly — no dirty-container dev warning (grep the dev
  console output for "createRoot" / container warnings).
- Settings: four cards render with identical classes in the same order;
  re-point → re-boot; create-fresh shows the imperative confirm from the React
  caller and cancels cleanly; emoji style applies in place without re-boot;
  a broken custom-font choice rolls back without stranding the select (SPM-17);
  "Choose another file…" only visible while Custom is active; "Open licence
  texts" routes errors to its message line.
- `grep -rn "StrictMode" src` empty; old shell.ts and settings.ts gone; no JSX
  children inside the `<main className="content">` leaf (code review).

## Review-cycle coverage
The review-cycle (per AGENTS.md, to convergence before any owner testing) must
specifically examine:
- JSX-vs-el() fidelity line-by-line against the deleted shell.ts/settings.ts:
  class lists, attribute order, exact strings (banner wording, button labels,
  Credits text), the `← Pack list` back button, the `›` separator with
  `aria-hidden`.
- Registry ordering proof: unmount-before-clear-before-mount on every switch
  and re-boot; shell root tracked separately; the content leaf written only by
  the registry; no `createRoot` on a dirty container.
- The `?? ""` tooltip semantics (no `title={tab.tooltip}` anywhere in shell.tsx).
- The PM store adapter's replace semantics (no stale listener after unmount);
  the navigator seam's unregister-still-ours check.
- SPM-17: the `finally` bump on success and failure; the controlled select's
  re-sync; the remembered-custom-font recovery line-for-line.
- Scope fence: nothing outside the touched table; icons.ts one word; Icon.tsx
  byte-identical markup; no new aria/role; CSS byte-identical; useMessage parity
  with `withMessage`'s contract.

## Owner / Windows checklist
Per the phase file, one Windows check covers the whole of Phase 2 and runs in
S03 (B2) after its review cycle. If the owner instead tests S02 standalone,
its items are:
1. All three screens via tab clicks; the PM tab follows an open pack's Title;
   back button appears/disables per the open pack and its busy state.
2. Broken-library boot lands on Settings with the banner.
3. Library re-point → the app re-boots into the shell cleanly (no double top
   bar, no dead chrome); create-fresh confirm opens and cancels cleanly.
4. Emoji style change applies in place (no re-boot); a broken custom font
   rolls back and does not strand the select; "Choose another file…" only
   while Custom is active.
5. Theme switch: the native Windows title bar follows.

## Risks and fallbacks
- Dirty container / double shell on re-boot → module-level shell-root handle +
  unmount-first; the dev-console exit check catches it (phase risk 1).
- React clobbering el() DOM in the content leaf → zero JSX children by
  construction; registry is the only writer; review checks the JSX (risk 2).
- Stale `setPackManagerListener`/`setEditorNav` slots after unmount → adapters
  unregister with still-ours checks (risk 3).
- Async message elements held across re-renders → `useMessage` keeps text in
  state, the `<p>` always rendered at a stable position (risk 4).
- Emoji-select stranding (SPM-17 regression) → the `finally` bump is an
  explicit exit criterion (risk 5).
- Overrun fallback: A3 (Settings) slips whole into S03 ahead of B1; A1+A2 are
  what Phase 3 mounts through, so sequencing survives. Nothing of A3 is needed
  by S03's sweep other than as its subject.
