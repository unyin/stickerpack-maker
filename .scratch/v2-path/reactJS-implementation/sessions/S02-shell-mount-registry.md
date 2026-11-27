# S02: Shell chrome in React, mount registry, Settings (Phase 2)

Covers A1 (mount registry + navigation seam), A2 (shell.ts → shell.tsx), A3
(settings.ts → settings.tsx) of [../phases/phase-2.md](../phases/phase-2.md).

Anchors are measured at commit `11bacb6` (plan.md › Anchor base); S01 moves
main.ts lines, so main.ts anchors below are `git show 11bacb6:src/main.ts` lines,
found today by symbol.

Corrections to the phase file:
- Phase 1 does not fix the filename of the `mountView()` module (phase-1.md says
  "shell.ts (or src/react/)"); the master plan's binding contract #1 pins it to
  `src/react/`, and S01's Files-touched table pins the exact name:
  `src/react/mount.ts` — this plan uses it.
- The phase lists `main.ts` as byte-identical; this session adds one
  `unmountShell()` call to two of its boot branches (step 1, "Boot paths") so no
  path can leave the shell root live over a detached node or `createRoot` on a
  live root. That two-call diff (plus the import) is the whole main.ts change
  of this session's own work (with the Preconditions' step-0 contingency, S01's
  step-9 boot wiring lands too).
- The PM-tab tooltip: the phase's `title={tab.tooltip ?? ""}` would emit
  `title=""` on first render, where today's tab has no `title` attribute
  (shell.ts:68-69 writes only when the value differs from the property's `""`
  default). This session omits the attribute when the tooltip is empty (step 4);
  see the recorded deviation there.

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
- S01 (Phase 1) landed and its Windows check passed. Hand-off state: react,
  react-dom deps; `jsx: react-jsx`; plugin-react; `src/views/first-run.tsx`
  (named export `FirstRun`); `src/react/mount.ts` with a module-level
  `Map<string, { container, root }>`, `mountView(container, id, element)` (re-render
  when `id` is tracked on the same container, else unmount every tracked root,
  then createRoot + render) and `unmountViews()`; `src/shell.ts` (still el())
  calling `unmountViews()` right before `clear(content)` in `show()`; `src/main.ts`
  `boot()` calling `mountView(root, "first-run", createElement(FirstRun, …))` in the
  unconfigured branch and `unmountViews()` before `renderShell` and before the
  catch branch's `root.replaceChildren`.
- Contingency (S01's overrun fallback): if S01 landed WP1+WP2 only, the
  first-run pilot plus S01's main.ts boot wiring (S01's WP3) land here as step
  0, before A1, with S01's
  fidelity bar and race-guard shape intact; the pilot's review rides this
  session's review cycle and its Windows check joins this session's. The
  bullet above then holds by this explicit hand-off, not silently — first-run
  never ships half-converted. In that case the Files-touched table also gains
  S01's WP3 rows (`src/views/first-run.ts` deleted, `src/views/first-run.tsx`
  new — off the Do-not-touch list for this session), and the main.ts exit
  check also admits S01's step-9 wiring, checked against S01's step 9.
- Nothing of Phase 2 exists yet: `src/react/` holds only S01's `mount.ts`;
  `src/shell.ts` (156 lines at 11bacb6, plus S01's one call) and
  `src/views/settings.ts` (306 lines) are both el()-built.
- Only `src/main.ts` imports `renderShell` (its `./shell` import, extensionless —
  survives the `.tsx` rename); only `src/shell.ts` calls `renderSettings`
  (shell.ts:87);
  no test file imports shell or settings (tests/shell-model.test.ts touches
  only the pure `shell-model.ts`, which is untouched).

## Files touched
| Path | Status |
|---|---|
| `src/react/mount.ts` (the S01 `mountView`/`unmountViews` module) | exists after S01 — modified (registry extension) |
| `src/react/navigation.ts` | new (~20 LOC) |
| `src/react/Icon.tsx` | new |
| `src/shell.ts` → `src/shell.tsx` | rename + rewrite (old file deleted, not dead code) |
| `src/icons.ts` | one-word edit: line 8 `const PATHS` → `export const PATHS` (the only edit) |
| `src/views/settings.ts` → `src/views/settings.tsx` | rename + rewrite (old file deleted) |
| `src/react/use-message.ts` | new (~20 LOC) |
| `src/main.ts` | exists — two added `unmountShell()` calls + the import (step 1) |

**Do-not-touch** (byte-identical at exit; the one copy — exit criteria, review
and Out of scope refer here): `src/dialog.ts` (93), `src/combobox.ts` (266),
`src/theme.ts` (65), `src/shell-model.ts` (38), `src/ui.ts` (52),
`src/views/first-run.tsx`, `src/views/editor.ts`, `src/views/pack-manager.ts`,
`src/editor/**`, `src/pack-manager/**`, all five CSS files, `index.html`,
`tests/**`; `src/icons.ts` apart from its one-word edit.

## Work plan
1. **A1 — extend the registry** in `src/react/mount.ts` (S01's module; shape
   in Preconditions). Phase 2 extension (master plan binding contract #1).
   `createRoot` is called only in `src/react/` (mount.ts — view roots and the
   shell root alike; S04 adds `bridge.ts`). API — these five functions, no others:
   - `mountView(container, id, element: ReactElement)` — a React view. Keeps
     S01's re-render case (same `id` tracked on the same container); otherwise
     (a) `unmountViews()`, (b) `container.replaceChildren()`, (c) `createRoot`
     + `render` inside `flushSync` (the view's first paint is complete on
     return), tracked as a React entry `{ kind: "react", container, root }`.
   - `mountDomView(container, id, node: Node)` — an el() view: (a)
     `unmountViews()`, (b) `container.replaceChildren(node)`, tracked as
     `{ kind: "dom", container }` — "not a root, dies with replaceChildren".
   - `unmountViews()` — unmount every tracked React root, drop every entry
     (DOM entries are just dropped). Never touches the shell root.
   - `mountShell(container, element)` — `unmountShell()` first, then
     `container.replaceChildren()`, `createRoot(container)`, `render(element)`
     inside `flushSync` (the content leaf's ref is attached on return);
     the root is held in a module-level `shellRoot`, separate from the views map.
   - `unmountShell()` — `unmountViews()` first (views die before the shell that
     hosts them), then `shellRoot?.unmount()` and clear the handle.
   Exactly one view at a time; switch order, always: (a) unmount every tracked
   React root, (b) `container.replaceChildren()`, (c) mount the next. Document
   this order, and the rule that none of these functions is ever called from
   inside a React render or commit (plan.md contract #1: `root.unmount()` there
   warns and cannot flush), in a doc comment on the module (A1's named exit). The
   content leaf has zero JSX children by construction; the registry is the only
   writer of `contentRef.current` (phase risk 2).
   **Boot paths** (main.ts after S01; React 19 warns on a dirty container —
   phase risk 1). Which function each `boot()` branch calls, just before it
   writes `#app`:
   - `unconfigured`: add `unmountShell()` before S01's `mountView(root,
     "first-run", …)` — a re-boot from a live shell must not `createRoot` on
     `#app` under the live shell root. (`mountView` then drops any view root.)
   - `ready`/`invalid`: S01's `unmountViews()` stays; `renderShell` →
     `mountShell` calls `unmountShell()` itself. No change in this branch.
   - `catch`: add `unmountShell()` after S01's `unmountViews()`, before
     `root.replaceChildren(...)` — otherwise a failed re-boot leaves the shell
     root live over detached nodes.
   Add `unmountShell` to main.ts's `./react/mount` import. All three run in
   `boot()`'s async continuation, after `await getAppState()` — outside any
   React render or commit.
2. **A1 — `src/react/navigation.ts`** (~20 LOC), the module-level seam mirroring
   `setPackManagerListener`: `setNavigator(next: (view: ViewId) => void)` and
   `navigate(view: ViewId)`. Default handler is a no-op. Registration returns an
   unregister that restores the no-op **only if `next` is still the registered
   handler** (the same replace-semantics pack-manager.ts:40 documents —
   phase risk 3). Import `ViewId` from `../shell-model` (type-only import;
   shell-model.ts untouched).
3. **A2 — icons.** One-word edit in `src/icons.ts:8`: `export const PATHS`.
   New `src/react/Icon.tsx` emitting byte-identical markup to `icon()`
   (icons.ts:57-68): `<svg class="icon icon-{name}" viewBox="0 0 24 24"
   aria-hidden="true" focusable="false">` with one `<path d>` per PATHS entry.
   JSX attribute order must match `icon()`'s set order (class, viewBox,
   aria-hidden, focusable) so the emitted `outerHTML` compares equal.
   Rationale (phase): React cannot take a raw `SVGSVGElement` as a JSX child; a
   ref-append would add a stray node. `icon()`/`explorerLabel()`/`IconName` stay
   for un-migrated sites.
4. **A2 — `src/shell.tsx`.** Keep the exported signature exactly:
   `renderShell(container: HTMLElement, state: AppState, onChanged: () => void)`
   (main.ts's `renderShell` import and call need no change).
   **The one shape** (every bullet below agrees with it): `renderShell`'s scope
   builds `contentRef` (a `createRef`), the `onLibraryChanged` closure, the
   `PackManagerNav` closures and `mountScreen(view: ViewId)` — a closure over
   `state`, `onLibraryChanged`, the nav closures and `contentRef` (not a hook,
   never called from render). The body is two statements:
   `mountShell(container, <Shell state={state} contentRef={contentRef}
   mountScreen={mountScreen}/>)` (rendered inside `flushSync`; the registry
   unmounts the previous shell root and its views first), then
   `mountScreen(initialScreen(state))`. `Shell` receives `mountScreen` as a prop
   because its `show()` calls it.
   `<Shell state contentRef mountScreen>` renders:
   - `<header className="topbar">` with children in today's order (shell.ts:132-139):
     `<span className="tb-slot">` (back button), `<nav className="nav">`
     (Editor + Pack Manager tabs), `<span className="brand">Stickerpack
     Maker</span>`, and the Settings tab button appended directly to the header
     (not inside `nav`). Move the TABS table and PM_TAB into shell.tsx
     unchanged (shell.ts:21-26).
   - The banner exactly when `state.libraryStatus === "invalid"`
     (shell.ts:142-152): `<div className="banner" role="alert">` with
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
   - Tab buttons: `className` `"nav-btn"`, plus `" active"` for the current
     screen (today's `classList.toggle("active", …)`, shell.ts:56),
     `data-view={id}`, children `{icon}{label}` with no whitespace between
     them (as today's el() appends them), e.g. `<Icon name={...}/>{tab.label}`
     on one line. Click handler (shell.ts:122-126): `const
     action = tabClickAction(item.id, screen, pm)`; `"list"` → `showPackList()`,
     `"show"` → `show(item.id)`, `"none"` → nothing (busy-pack refusal).
   - The PM tab renders `<Icon name="layers"/>{"Pack Manager"}` — no
     whitespace between icon and label, or JSX would emit a leading space and
     break the `.topbar` byte-equality — plus, when
     `packTabLabel(screen, pm.open).packTitle !== null`:
     `<span className="tab-sep" aria-hidden="true">›</span>` and
     `<span className="tab-pack">{tab.packTitle}</span>`. The tooltip is
     `title={tab.tooltip || undefined}`: the attribute is omitted while the
     tooltip is empty. Today (shell.ts:68-69) the tab has no `title` attribute
     on first render (the write is skipped while the value equals the
     property's `""` default); once a pack was opened then closed, today leaves
     `title=""` where React leaves no attribute. **Recorded accepted
     deviation**: empty `title` and no `title` show nothing on hover, so the
     owner sees no difference; the `.topbar` byte-equality check runs in the
     fresh-boot state, where both trees have no `title` on the PM tab.
   - PM state via `useSyncExternalStore(subscribe, packManagerState)` — a thin
     adapter over `setPackManagerListener` living inside shell.tsx. The
     subscribe callback is installed with `setPackManagerListener(cb)` and its
     cleanup restores a no-op only if `cb` is still the registered listener
     (track the installed listener module-level; `setPackManagerListener` has
     no unset API — pack-manager.ts:40-43). `packManagerState()` returns a
     stable reference replaced only on `publish` (changed() gate), so it is a
     valid snapshot. `refreshChrome` and its `shownTitle`/`pmTab.title` guards
     die — the render is the refresh. Publishes fired mid-mount by
     `renderPackManager` land as listener callbacks → re-render, replacing
     today's trailing `refreshChrome()` call in `show()` (shell.ts:94).
   - `show(view)` (inside `Shell`) is the one navigation handler, called only
     from event handlers and the navigator — never from render or an effect.
     It runs, in order and outside React (plan.md contract #1):
     `unmountViews(); flushSync(() => setScreen(view)); mountScreen(view)`
     (the prop). `unmountViews()` kills the view roots before the
     state change; the `flushSync` commits the shell (tab `active` classes,
     back button) synchronously, so the content leaf exists and is current
     when the next line mounts into it; the mount runs after the commit, so
     every root a view creates (Settings' own root, and later S04's in-place
     PackList root) is created outside any React commit, and no frame ever
     paints an empty content area. `screen` is useState, initial value
     `initialScreen(state)` = `state.libraryStatus === "invalid" ? "settings" :
     "editor"`. There is **no mount effect**: no `useEffect`/`useLayoutEffect`
     in `Shell` mounts or unmounts a view.
   - `mountScreen(view)` (the `renderShell`-scope closure above) is the one
     place that maps a screen to its registry call, mounting into
     `content = contentRef.current!`; the views map is empty by then (`show()`,
     or on boot `mountShell`, emptied it), so the registry's step (a) is a no-op
     there: editor: `mountDomView(content, "editor", renderEditor())`; pack-manager:
     `mountDomView(content, "pack-manager", renderPackManager(state.libraryPath,
     { openInEditor, openThumbnailInEditor }))`; settings: `mountView(content,
     "settings", <SettingsView state={state} onLibraryChanged={onLibraryChanged}/>)`.
     The el() Pack Manager and Editor mounts take exactly the same path as the
     React Settings mount. `mountView`/`mountShell` render their new root
     inside `flushSync` (legal: every caller is outside React), so the view's
     first paint is complete when the call returns. `renderSettings` is
     deleted; settings.tsx exports the `SettingsView` component.
   - **Boot**: per the one shape above — `mountShell`'s `flushSync` render
     attaches `contentRef` before it returns, so `mountScreen(initialScreen(state))`
     mounts the initial view the same way `show()` does, outside React, and
     reads the leaf without querying the DOM.
     Same-screen re-show must survive the port: today clicking the PM tab
     while the shell is on the pack list re-runs `show` — `tabClickAction`
     returns `"show"` for it (shell-model.ts:31) and `show("pack-manager")`
     re-runs `renderPackManager`, re-reading the pack list. The handler path
     keeps that for free: `show()` always calls `mountScreen`, even when
     `setScreen(currentScreen)` is a state no-op (no counter needed).
   - The re-boot callback stops at the boundary (phase §"mixed boundary" item 5):
     `onLibraryChanged = () => { forgetPackManager(); resetPackMemory();
     forgetEditorOrigin(); onChanged(); }` — exactly today's trio + `onChanged`
     (shell.ts:88-91), with today's three comments. It lives in `src/shell.tsx`
     as the `onLibraryChanged` closure built in `renderShell`'s scope (captured
     by `mountScreen`, which passes it to `SettingsView`); later sessions (S04, S06) find the `forgetPackManager()`
     call there by that name. No keyed `<Shell>` this phase; Phase 2
     deliberately keeps full root unmount/remount per boot.
   - `setEditorNav` wired via the navigator (shell.ts:99-108): register in a
     registration effect `setNavigator(show)` (its cleanup only unregisters —
     no-op only if still ours; it mounts and unmounts nothing), then call `setEditorNav({
     showSticker: (packId, stickerId) => { revealStickerOnShow(packId, stickerId); navigate("pack-manager"); },
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
5. **A3 — `src/react/use-message.ts`** (~20 LOC): the React twin of
   `withMessage` (ui.ts:38-52). `useMessage(): { text: string; set(text:
   string): void; run(action: () => Promise<void>): Promise<void> }` — `run`
   clears the text state, awaits the action, routes `errorMessage(err)` into
   state on throw, never throws; `set` writes a non-error message, for the
   action bodies that write the `<p>` directly today (repoint's "Please select
   the … file inside your Library folder." line, settings.ts:53).
   The caller always renders `<p className="message" role="alert">{text}</p>`
   (empty when unset) so the element holds a stable tree position across
   re-renders (phase risk 4). `withMessage` stays untouched in ui.ts for
   un-migrated views.
6. **A3 — `src/views/settings.tsx`.** Four cards as components in today's order
   (Library path, Appearance, Emoji font, Credits) with identical classes
   (settings.ts:188-306): `view`, `card`, `field-label`, `path`, `muted`,
   `actions`, `secondary`, `message` + `role="alert"`, `theme-select`,
   `emoji-style-select`, `code.path`. Keep existing aria exactly (`aria-label:
   "Emoji font"` on the select); add nothing (UI-audience rule).
   - Library card: `statusText` logic verbatim (settings.ts:90-95); `repoint`
     and `createFresh` flows verbatim via `useMessage` (`run` for the wrapper,
     `set` for settings.ts:53's invalid-name line). `createFresh`'s
     `confirmChoice` call stays the imperative island call — dialog.ts is
     untouched and appends to `document.body`, outside every React root.
   - Appearance card: theme.ts reused verbatim, no store. Select `onChange` →
     `setThemePreference(parseThemePreference(value))`; the selected option is
     component-local state seeded from `getThemePreference()`. React note: the
     options' `selected:` attrs (settings.ts:242) must become a controlled
     `value={...}` on the `<select>` (React warns on `selected` in options).
   - Emoji card as derived state replacing the imperative `refreshEmojiCard()`
     loop (settings.ts:171-186):
     - A version-bump snapshot state; `refreshEmojiCard()` becomes `bump()` and
       the card derives select value, problem line, custom-path row and repick
       visibility from `getEmojiStylePreference()` / `emojiStyleProblem()` /
       `getCustomEmojiFontPath()` at render time.
     - The SPM-17 review-round-3 rule preserved exactly (settings.ts:150-156):
       the bump runs in the `finally` of the onchange flow, on success AND
       failure, so a failed choice cannot strand the select (onchange only
       fires on a change, so a stale select cannot be rechosen).
     - The select is controlled and shows what today shows: the picked value
       at once while the async choice runs (today the native select already
       shows it), then, in the `finally`, whatever `getEmojiStylePreference()`
       is — the new style on success, the previous one on failure or a
       cancelled picker (today's `styleSelect.value =` in `refreshEmojiCard`,
       settings.ts:172). Shape: a `pending` state set in `onChange` and
       cleared in the `finally` next to the bump; `value={pending ??
       getEmojiStylePreference()}`. Options from `EMOJI_STYLE_CHOICES`, labels
       verbatim.
     - The custom branch's remembered-custom-font recovery kept line-for-line
       (settings.ts:131-147): remembered path → `chooseEmojiStyle("custom")`
       without a picker; on throw → `pickEmojiFont()` for a replacement,
       cancelled → rethrow the load error; no remembered path → picker,
       cancelled → return. The repick button ("Choose another file…",
       settings.ts:104-112) and `customPathRow` ("Using: " + `code.path`, "no
       file chosen" fallback) are always rendered and carry the `hidden`
       attribute unless the current preference is "custom"
       (settings.ts:183-184) — `hidden={…}`, not conditional rendering, so the
       DOM stays today's.
     - `styleProblem`: always rendered, text `problem ?? ""`, `hidden={problem
       === null}` (settings.ts:174-175); `styleMessage` and the Library
       message: one `useMessage` each.
   - Credits card: all five `<p className="muted">` texts verbatim
     (settings.ts:275-304); "Open licence texts" button routes
     `openLicenceTexts` errors to its own `useMessage` line
     (settings.ts:80-87).
7. Run `bun run build` and `bun test`; then the S02 exit checks below. Old
   `shell.ts` and `settings.ts` are deleted in the rename, not left as dead
   code.
8. **Land per plan.md › Session protocol.** Session-specific inputs: the review
   covers the Review-cycle coverage list below (the "Deliberately out of scope"
   list is its scope fence); the owner Windows check runs this file's Owner /
   Windows checklist. S03's B2 review is then a delta review from this
   session's owner-tested state.

## Deliberately out of scope
- `dialog.ts` and `combobox.ts`: untouched imperative islands (firm phase
  decisions) — no wrapper, no re-implementation, no ComboboxIsland escape
  hatch. Their consumers stay as they are.
- Everything on the Do-not-touch list (Files touched); main.ts beyond step 1's
  two calls.
- No keyed `<Shell>` / persistent root (Phase 3/4's centralization), no
  dialog-body bridge (Phase 3), no FontPicker work (Phase 4).
- No icon changes (Icons rule), no new aria/role attributes, no Styling.
- The B1 contract sweep (tooltip mechanics, focus checks, stale-navigation
  drill) is S03's work — this session only builds.
- No `<StrictMode>` anywhere in `src/` (binding contract #3).

## Exit criteria
- `bun run build` passes; `bun test` passes (25 files).
- `git diff --stat <session base>` over the code pathspec (both per plan.md ›
  Session protocol, step 3) lists only the Files-touched paths (plus
  `src/views/first-run.ts`/`.tsx` if the step-0 contingency ran; under the
  overrun fallback, without `src/views/settings.ts`/`.tsx` and
  `src/react/use-message.ts`), so every Do-not-touch path and everything else
  (`src/api.ts`, `src/emoji-style.ts`, `src/shared/**`, `src-tauri/**`,
  `package.json`, `bun.lock`, …) is unchanged; icons.ts diff is exactly the one-word
  `export`; main.ts diff is exactly step 1's two `unmountShell()` calls and
  the import (plus S01's step-9 wiring if the step-0 contingency ran).
- `document.querySelector('.topbar').outerHTML` byte-equal before/after in the
  fresh-boot state (attribute order per step 4; the after-open-close `title`
  deviation is recorded in step 4); same check for the banner tree when
  `libraryStatus === "invalid"`.
- All three screens reachable via tab clicks; the PM tab shows `› {Title}` and
  follows pack renames live; back button visibility/disabled per
  `backButtonState` including busy; PM-tab click on an open pack goes to the
  list; busy-pack tab click does nothing.
- A same-screen PM tab click while the pack list is showing still re-reads the
  pack list (today's `show` re-run via `tabClickAction` `"show"`): the React
  `show()` re-runs `mountScreen` for the current screen, not a state
  no-op. No empty-content frame flashes on a screen switch or at boot: views
  mount from `show()`/`renderShell` right after the shell's `flushSync`
  commit, never from an effect (`Shell` has no view-mounting effect — code
  review).
- Broken-library boot lands on Settings with the banner; library re-point →
  re-boot unmounts cleanly — no dirty-container dev warning and no
  "synchronously unmount a root while React was already rendering" warning
  (grep the dev console output for "createRoot" / "unmount" / container
  warnings), across a tab switch away from Settings and a forced boot failure
  (catch branch) from a live shell.
- `unmountViews()`/`unmountShell()` are called only from the navigation
  handler, the registry itself and main.ts's `boot()` — no effect cleanup and
  no render path calls them (code review); `grep -rln "createRoot" src` lists only
  files under `src/react/` (this session: `mount.ts`).
- Settings: four cards render with identical classes in the same order;
  re-point → re-boot; create-fresh shows the imperative confirm from the React
  caller and cancels cleanly; emoji style applies in place without re-boot;
  a broken custom-font choice rolls back without stranding the select (SPM-17);
  "Choose another file…" only visible while Custom is active; "Open licence
  texts" routes errors to its message line.
- No `<StrictMode>` anywhere in `src/` (`grep -rn "StrictMode" src` empty);
  old shell.ts gone (and old settings.ts, unless the overrun fallback ran);
  no JSX children inside the
  `<main className="content">` leaf (code review).
- Review-cycle both axes converged on this session's diff.
- Windows checklist passed (items 1–5 below).
- PR merged with `gh pr merge <N> --merge`.

## Review-cycle coverage
The review-cycle (per AGENTS.md, to convergence before any owner testing) must
specifically examine:
- JSX-vs-el() fidelity line-by-line against the deleted shell.ts/settings.ts:
  class lists, attribute order, exact strings (banner wording, button labels,
  Credits text), the `← Pack list` back button, the `›` separator with
  `aria-hidden`.
- Registry ordering proof: unmount-before-clear-before-mount on every switch
  and re-boot; view roots unmounted from the navigation handler before
  `setScreen`, never from an effect cleanup or render; views mounted only by
  `mountScreen` from `show()`/`renderShell`, after the shell's `flushSync`
  commit, never from an effect; shell root tracked
  separately; each main.ts branch calls the function step 1 names; the content
  leaf written only by the registry; no `createRoot` on a dirty container.
- The PM-tab tooltip: `title={tab.tooltip || undefined}` (attribute absent
  while empty), the recorded open-then-close deviation, and no other
  `title` expression on the tab.
- The PM store adapter's replace semantics (no stale listener after unmount);
  the navigator seam's unregister-still-ours check.
- SPM-17: the `finally` bump on success and failure; the select showing the
  picked value during the choice and re-syncing in the `finally`; the
  remembered-custom-font recovery line-for-line; `hidden` attributes kept.
- Scope fence: nothing outside the touched table; the Do-not-touch list
  byte-identical; icons.ts one word; Icon.tsx byte-identical markup; no new
  aria/role; useMessage parity with `withMessage`'s contract.

## Owner / Windows checklist
Run on Windows after review convergence; this session's PR merges only after
it passes (plan.md › Session protocol). S03's checklist then re-covers the
whole of Phase 2 after the hardening.
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
- `root.unmount()` inside the shell's commit (a view root torn down from an
  effect cleanup) → view roots are unmounted only from `show()` and main.ts's
  boot paths, never from an effect; the "synchronously unmount" dev-warning
  check in Exit criteria catches a regression (plan.md contract #1).
- `flushSync` called during a render or inside an effect warns and cannot
  flush. `show()`'s and the registry's `flushSync` calls are legal only
  because every caller is outside React: a DOM/React event handler, the
  navigator (called from el() handlers and `await` continuations), or
  `boot()`'s async continuation. Review checks no render path or effect
  reaches `show()`, `navigate()` or `mountScreen()`; a `flushSync` dev warning
  in the console is a regression. A `show()` reached from a click inside a
  view root that `unmountViews()` then unmounts is fine (an event handler is
  not a render or commit).
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
  by S03's sweep other than as its subject. S02 then lands with
  `src/views/settings.ts` el() and byte-identical: `mountScreen`'s settings
  branch is `mountDomView(content, "settings", document.createDocumentFragment())`
  (empties the leaf, tracks a DOM entry) then `renderSettings(content, state,
  onLibraryChanged)`; `use-message.ts`, the Settings exit/checklist items and
  the "old settings.ts gone" exit check move to S03 (S03's Preconditions
  record the hand-off).
