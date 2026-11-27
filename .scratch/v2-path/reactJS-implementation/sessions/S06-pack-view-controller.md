# S06: Pack view + controller (Phase 3)

Corrections to the phase file: minor line drift, all re-verified at `11bacb6`:
`views/pack-manager.ts` — `publish` :34, `setPackManagerListener` :41, `packManagerState`
:46, `showPackList` :51, `pendingReveal` :59, `renderPackManager` :76,
`forgetPackManager` :89, `build` :94, `showList` :103, `openPack` :115, `showSticker`
:152, `dispose` :175. `pack-view.ts` — `run()` busy-gate :167-177, `setView` :181,
`importPaths` :284, `persistEmoji` :371, keydown guard :507, document keydown :524,
`renderBanners` :580, `renderPanel` :589, `render` :597, panel guard :638, `reread()`
:643-648 (drain :644-646, then `loadPackView` :647), REVEAL_BUSY :657, REVEAL_GONE :668,
`scrollIntoView` :676. `editor.ts` is at `src/views/editor.ts` (`markThumbnailChanged`
:1501, `markStickerFileChanged` :1539).

All anchors are at commit `11bacb6` (plan.md › Anchor base); a `file.ts:NN` anchor
cites the file as it stood there, before any rename. Renamed to `.tsx` before this
session (S01's rule, extensionless imports so no importer changed): `previews.tsx`,
`dialogs.tsx`, `src/views/pack-manager.tsx` (S04); `upload-list.tsx`,
`emoji-field.tsx`, `panels.tsx` (S05, or this session's step 0 for panels).
`pack-view.ts` stays `.ts` until this session replaces it.

## Goal

The atomic swap: `pack-view.ts`'s 686-LOC closure becomes a `PackViewStore` external
store (same `subscribe()` shape as `EditorSession`, `src/editor/model/session.ts`)
consumed via `useSyncExternalStore` by a React PackView tree, and the singleton cache in
`views/pack-manager.tsx` becomes a headless module-level controller whose one React
view S02's `mountScreen` mounts with `mountView()` (step 6). `buildPackView` cannot
land half-converted — this session lands it in one change. When S06 ends the whole
Pack Manager emits React (bar the el() `packPicker`, a post-adoption follow-up), both drag systems still
run byte-identical vanilla code behind refs, and the phase's definition of done holds
(build/tests green, CSS byte-identical, drain contract exact, the Editor's save dialog
through the still-el() `packPicker`). The list side is light: S04's controller-owned
`PackListStore` already holds the list's state, so S06 lifts no list state — it only
drops the list's in-place root.

## Preconditions

- S04 and S05 landed: `PackList` renders from the controller-owned `PackListStore`
  through an in-place root on the list section (views/pack-manager.tsx, unmounted in
  `dispose()`); panels render through an in-place
  root on pack-view's `aside.pm-panel` (unmounted in pack-view's `destroy()`); every
  Pack Manager dialog body except `packPicker`'s is bridged with `bridgeDialog`/
  `bridgedConfirm` (`src/react/bridge.ts`); React twins `PreviewImage`, `StatusBadge`
  and `NewPackFields` exist beside the still-exported el() `previewImage`,
  `statusBadge`, `reservedLabel` and `newPackFields`; `packPicker` is el().
  Contingency: if S05 handed off `panels.ts` by explicit hand-off, it lands as this
  session's step 0 (work plan below) — not silently assumed converted.
- Phase 2's mount registry: `mountView()` guarantees unmount-before-clear-before-mount
  with exactly one view mounted at a time — S06 relies on it for the Pack Manager's
  one view mount (from `mountScreen`, step 6) and the scroll save/restore.
- Phase 3 precondition 2 landed: Settings re-point reaches `forgetPackManager()`
  (shell.ts:88).
- No parallel el()-based UX work (tickets
  [01](../../issues/01-pack-manager-interactions.md) /
  [02](../../issues/02-editor-tools-and-layers.md)) on these files.

## Files touched

| Path | Status |
|---|---|
| `src/pack-manager/view/pack-view.ts` (686 LOC) | closure → `PackViewStore` + React tree; replaced by `src/pack-manager/view/pack-view.tsx` (new), old file deleted |
| `src/views/pack-manager.tsx` (renamed by S04; 184 LOC) | singleton cache → headless module-level controller; `renderPackManager` returns the `<PackManager/>` element, `shown()` exported as `packManagerShown()` (step 6) |
| `src/shell.tsx` (from S02) | `mountScreen`'s pack-manager branch only: `mountDomView` → `mountView` + `packManagerShown()` (step 6) |
| `src/pack-manager/view/pack-list.tsx` (from S04) | the in-place root goes: `PackList` becomes a plain JSX child of the Pack Manager tree, still rendering from `PackListStore` (step 8); no state moves |
| `src/pack-manager/view/reorder-drag.ts` (91 LOC) | NOT edited — wiring only (JSX `onPointerDown` + `nativeEvent`) |
| `src/react/bridge.ts` | `bridgeInPlace` removed with its last callers (step 8); `bridgeDialog`/`bridgedConfirm` stay |
| `src/pack-manager/view/previews.tsx` (renamed by S04) | el() `previewImage` deleted (pack-view was its last el() consumer) |
| `src/pack-manager/view/dialogs.tsx` (renamed by S04) | `StatusBadge` gains `reserve`, a `ReservedLabel` twin added; el() `statusBadge` stays for `packOption` (:373, no `reserve`); el() `reservedLabel` stays only as the callee of `statusBadge`'s now-unused `reserve` branch (:39) — kept rather than editing `statusBadge` |
| `src/pack-manager/view/panels.tsx` (renamed from `panels.ts` in step 0), `emoji-field.tsx` (renamed by S05) | contingency step 0 only (S05 hand-off): panels port, el() `bindEmojiSave`/`copyButton` deleted |
| `src/pack-manager/model/` , `src/editor/`, `src/shared/`, all `*.css` | untouched (grep-verified in exit criteria) |

## Work plan

0. **Contingency step 0 — only if S05 handed off `panels.ts`** (explicit
   hand-off per S05's fallback): `git mv` `panels.ts` → `panels.tsx` and land it first as S05 planned it
   (near-mechanical JSX, the emoji-box fit math untouched), including its
   in-place panel root unmounted in `destroy()`, and delete the el()
   `bindEmojiSave`/`copyButton` (emoji-field.tsx) that S05 kept for it, before the
   write-site audit below. Otherwise skip.
1. **Write-site audit first** (phase risk 1's mitigation): enumerate every direct DOM
   write in today's pack-view closure — 42 lines, reproducible with
   `git show 11bacb6:src/pack-manager/view/pack-view.ts | grep -nE '<pattern>'`:
   - core writes, pattern `\.textContent = |\.classList\.(add|remove|toggle)\(|\.disabled = |\.title = `
     → 28 lines (the message-title mirror :150, the busy class :170/:176, the message
     :202/:415/:657, the drop-target class :295-298, and `render()`'s header/toolbar
     writes :602-631);
   - swaps and other writes, pattern `replaceChildren\(|setAttribute\(|\.value = |\.hidden = `
     → 14 lines (`aria-invalid` :198, the Title / Short Name input values
     :214/:230/:600/:601, the banners :586, the panel :591-594, `badgeHost` :606,
     `statusButton` :608, `aria-pressed` :614, the grid :634);
   - one indirect writer neither grep finds: `run()`'s `withMessage(message, action)`
     (:173; ui.ts:47 clears the message, :51 writes the error) — the audit lists it,
     and the store's `run()` sets `message` the same two ways.
   Produce the audit list as a review-cycle artifact; every site maps to a store field
   or a derived render — nothing maps to "left as a direct write".
   **Split decision, at the end of this step** (recorded on the Trekker task): split
   the session per the fallback in Risks and fallbacks if the audit finds more than 6
   write sites beyond the counted 42, or the agent judges the store + tree port too
   large for one review cycle. Otherwise S06 runs atomic — and lighter than first
   sized, since the list side only drops a root (S04 owns its store). The decision is
   made here, before any port code, never mid-review.
2. **`PackViewStore`**: `{ view, mode, selection, busy, notice, rejected, message }`
   plus `subscribe()`/`getSnapshot()`, mutable-store pattern (`getSnapshot` returns the version counter,
   bumped + notify on every mutation; components read the store's fields), mirroring the `EditorSession` pattern (`src/editor/model/session.ts`).
   Commands live outside React, event-driven never effect-driven (binding contract #4).
   `Previews` ownership moves to the store so blob URLs survive root unmounts exactly as
   long as today.
3. **Port action bodies verbatim** — each named behavior keeps its exact semantics:
   - `run()`'s busy-gate (:167-177: `if (busy) return; busy = true;
     root.classList.add("busy")`, finally `busy = false` + remove) — the `busy` class
     on the root element becomes a store-derived class on the React root node;
   - `setView` (:181) with `pruneSelection(selection, order())` (model, untouched);
   - `importPaths` (:284) and the drop-event effect (`payload.paths` →
     `void run(() => importPaths(...))` :299) with cleanup;
   - `persistEmoji` (:371) and the "not behind the busy guard" change/blur save path
     (:408-413);
   - `reread()`'s drain (:644-646, then `loadPackView` :647): drain *before* `loadPackView`, per-id
     `previews.forget`, thumbnail only when `takeChangedThumbnails().includes(packId)`
     — ported verbatim, never called from a second site (driven by the Editor's
     `markStickerFileChanged` :1539 / `markThumbnailChanged` :1501);
   - `reveal()`'s REVEAL_BUSY (:657) / REVEAL_GONE (:668) paths;
   - the keydown guard ladder: `if (!root.isConnected || dialogOpen() || busy) return`
     (:507) + `document.addEventListener("keydown", onKey)` (:524) as an effect with
     cleanup;
   - the drop listener's guard `if (!root.isConnected || dialogOpen()) return` (:293)
     with its cleanup — `onDragDropEvent` resolves its unlisten asynchronously, so a
     cleanup that runs first unlistens on resolve.
   React-era equivalent of `root.isConnected` in both guards: `rootRef.current?.isConnected
   === true` on the `.pm-pack` root's ref — React nulls the ref on unmount, so the guard
   also refuses events arriving between unmount and the listener's removal.
4. **React PackView tree**:
   - header: Title / Short Name as uncontrolled inputs (refs) with two writers of
     their value, both today's: (a) a `useLayoutEffect` with **no dependency array**
     (runs on every commit, as `render()` writes both inputs on every render,
     :600-601) that sets each input's value from `view.pack` only when the input is
     not focused — a background `reload()` never clobbers a half-typed input (phase
     risk 2); (b) each input's native `change` handler awaits the store's commit command
     and in its `finally` writes the input's value from the store's
     `view.pack.title` / `shortName` unconditionally, focused or not, as :214/:230
     do — so a rejected or failed edit reverts the typed text even while the input
     keeps focus (Enter commits without blurring). The handler is an event
     continuation outside React and the input is uncontrolled, so React owns no part
     of that write. The `finally` (and its `aria-invalid` reset, :215/:231) writes to
     the element **captured at event time** (`const input = e.currentTarget`), never
     `ref.current`: tab clicks ignore busy (`tabClickAction` returns `"show"`,
     shell-model.ts:29-31), so a commit fired by the blur of a tab click routinely
     finishes after the PackView unmounted — `ref.current` is then null, the write
     would throw inside `run()`, and `withMessage` would store "Cannot set properties
     of null" as the message. The detached input takes the write harmlessly; the
     remounted input gets the stored value from (a). An effect keyed on `pack.title` alone is wrong: a rejected edit leaves
     `pack.title` unchanged, so it would never fire. The `badgeHost` and
     `statusButton` swaps (:606/:608) become `<StatusBadge status={…} reserve/>` and
     `<ReservedLabel shown={…} other={…}/>` (React twins of dialogs.ts:37/:50, same
     `.pm-reserve`/`.pm-reserve-twin` markup); the el() `statusBadge` stays for
     `packOption` (dialogs.ts:373, el() `packPicker`, post-adoption follow-up), and el()
     `reservedLabel` stays only because `statusBadge`'s unused `reserve` branch (:39)
     still calls it;
   - toolbar: disabled/title/tone-class derivations from store state (:623-631:
     refresh/Add/reveal/status disabled when busy; upload additionally blocked by
     `uploadBlocker`; title input disabled when busy; `shortInput.disabled = true`
     when busy);
   - notices: the single-banner rule (`renderBanners` :580 — one banner shows, the
     rule that picks it ported verbatim);
   - grid: a stable `<ol>` node (ref, never remounted — reorder-drag queries
     `.pm-tile[data-id]` each move), tiles keyed by sticker id, thumbnail slot last;
   - panel: keyed by `panelFor(selection)` + selected id (panels.tsx is React since
     S05) — stable keys replace the `document.activeElement` panel guard (:638) by
     construction; delete the guard, don't keep both;
   - tiles and the thumbnail slot use `PreviewImage`, which reads an already-settled
     preview promise synchronously at render (S04 step 2's `settledPreview`), so a
     remount over the store's `Previews` paints the cached thumbnails in its first
     frame — no blank tiles; the el() `previewImage`
     (previews.ts:62-72) is deleted, pack-view (:430/:469) being its last el() consumer;
   - pack-view's own `showRejected` dialog (:551-578) bridges its body with
     `bridgeDialog` like S05's dialogs.
5. **Reveal scroll**: `render(); tile?.scrollIntoView({ block: "nearest" })` (:676)
   becomes a pending reveal in the store (`{ id }`, set by `reveal()`), consumed once
   by a `useLayoutEffect` that queries the same selectors, scrolls, and clears it —
   commit-before-paint, so no visible jump. Both this effect and the grid `scrollTop`
   restore (step 6) live in the same component — the one that renders the grid
   `<ol>` — with this effect declared after the restore, so it runs after it (React
   runs a component's layout effects in declaration order, but a child's before its
   parent's, so splitting them across components breaks the order); a remount on a tab switch finds no
   pending reveal and never re-applies a consumed one.
6. **Controller** (`views/pack-manager.tsx`): the singleton survives headless —
   - `opening` race counter (:100-101), `disposed` (:99), `pendingReveal` (:59)
     verbatim;
   - the handle-guard and publish-on-change contracts verbatim: `publish` drops
     no-change reports (:34-38); a report counts only from the handle that is the
     open pack (:123-124 `handleRef !== null && handleRef === pack`); the superseded
     open destroys its handle (`disposed || mine !== opening` :129-131) and a
     superseded failure stays silent (:144);
   - **mounting** (contract #1): the Pack Manager is one React view, mounted only by
     S02's `mountScreen` in `src/shell.tsx`, whose pack-manager branch changes from
     `mountDomView(content, "pack-manager", renderPackManager(…))` to
     `mountView(content, "pack-manager", renderPackManager(state.libraryPath, nav));
     packManagerShown();`. `renderPackManager(library, nav)` keeps its
     forget-on-library-change and `cached ??= build(…)` lines, no longer calls
     `shown()`, and returns the `<PackManager/>` element. `packManagerShown()` runs
     `cached.shown()` (:164-174: consume `pendingReveal` → `showSticker`, else
     `pack.reload()`, else clear + reload the list) from the navigation handler,
     outside React, after `mountView`'s `flushSync` render. Its list calls
     (`clearMessage()`, `reload()`) are `PackListStore` mutations (S04 step 3) — no
     imperative handle exists, so nothing waits on a component being attached. Never
     from a mount effect: that would make a command effect-driven (contract #4) and run it inside
     a React commit (contract #1);
   - **list ↔ pack switching** (`showList` :103, `openPack`'s success path :141) is
     store state inside the PackManager view (which of list / open pack shows),
     never a `mountView()` call or root swap — `openPack`'s async continuation only
     sets that state, and React re-renders. `PackList` becomes a plain JSX child of
     the Pack Manager tree;
   - grid `scrollTop` saved on unmount and restored in a layout effect (four lines;
     without it mountView's unmount-on-switch regresses today's cached-DOM scroll
     preservation), in the same component as step 5's reveal effect;
   - **remount-surviving UI state** (lead ruling, 2026-11-27, corrected): today the
     cached Pack Manager DOM keeps what the owner sees across a shell tab switch and
     open-pack-and-back; under `mountView` the root unmounts, so each such piece lives
     in the controller or a store, never in component `useState`:
     - which of list / open pack shows; the pack view's selection and mode; the grid
       `scrollTop` (above);
     - the `.pm-panel` `scrollTop`: today the `aside.pm-panel` node is kept and only
       its children are replaced (pack-view.ts:152, :589-594), and it scrolls itself
       (pack-manager.css:836-838) — saved on unmount and restored in a layout effect
       like the grid's, the aside itself unkeyed (the keys sit on its content);
     - the list's search text and filter, the `pm-notice` (pack-list.ts:98-100,
       including the leftover-folder path) and the loaded `packs` — all already in
       S04's `PackListStore`, so a remount paints the last rows at once, never the
       "No packs yet. Create one to start." item (pack-list.ts:202/:228) — before a
       first load has painted, the childless `<ul>` (S04 step 4) — until
       `shown()`'s reload repaints.
     Deliberately not on the list: the **message lines** live in the stores but every
     show clears them today, and S06 keeps both clears — the list's by `shown()`
     (:171) and `showList` (:111; pack-list.ts:37-38 "each show of the list starts
     clear"), the pack view's by `shown()` → `reload()` → `run()` → `withMessage`
     (pack-view.ts:653, ui.ts:47). The **list's scroll**: the list has no scroll
     container (`.pm-pack-list` has no overflow, pack-manager.css:122-129); the
     scroller is the shell's `main.content` (styles.css:212-215), which never
     unmounts, and today it clamps to 0 on both round trips — unchanged. A
     half-typed Title / Short Name or Emoji String is the one exception: leaving the
     tab blurs the field, which commits or reverts it as today (component-local
     drafts are fine for exactly this), so nothing is left half-typed to keep;
   - exported contracts unchanged in name and shape: `setPackManagerListener`/
     `packManagerState`/`revealStickerOnShow`/`revealThumbnailOnShow`/`showPackList`/
     `forgetPackManager`; `renderPackManager` keeps its name and parameters but
     returns a `ReactElement` and no longer runs `shown()`; `packManagerShown()` is
     new. Callers: `src/shell.tsx` only (`mountScreen`, the `onLibraryChanged`
     closure's `forgetPackManager()`, the navigator).
7. **Reorder-drag wiring**: `ReorderDragHost` (reorder-drag.ts:8-17: `grid`,
   `enabled()`, `indexOf()`, `drop()`) rebuilt into a ref each render so
   `enabled()` reads `mode === "reorder" && !busy` live; `onPointerDown={(e) =>
   startReorderDrag(e.nativeEvent, id, hostRef.current)}`. The module code is
   byte-identical.
8. **In-view bridge removal**: the two `bridgeInPlace` roots (S04's `PackList` on the
   list section, S05's panels on `aside.pm-panel`) become plain JSX children now that
   the Pack Manager is React, and `bridgeInPlace` is deleted from `bridge.ts`.
   `PackList` keeps its `store` prop (the controller's `PackListStore`) and renders
   as before; no list state moves. The
   dialog bridges (`bridgeDialog`/`bridgedConfirm`) remain — dialogs stay imperative
   islands for the whole adoption (binding contract #2). `packPicker` stays el() with
   no bridge (save-dialog.ts:14/:102; see the out-of-scope note below).
9. **Land per plan.md › Session protocol**, with this session's byte-identity checks:
   `git diff --stat <session base> -- src/pack-manager/view/pack-list-drag.ts
   src/pack-manager/view/reorder-drag.ts` empty; the Editor save dialog flow is re-checked in
   the delta review (phase risk 5); the checklist below.

## Deliberately out of scope

- `<StrictMode>`: none anywhere in `src/` (double-invoked effects would double-drain `takeChangedStickers` —
  binding contract #3).
- The Editor, the drag modules' code, or any model file.
- `packPicker` and the el() helpers only it uses (`newPackFields`, `statusBadge`,
  `reservedLabel`): el() through the whole adoption (S11 puts the pack picker out of
  scope); their port is a named post-adoption follow-up (S12 records it).
- Any CSS/class change; no new aria/role attributes, existing ones kept as they are (AGENTS.md › UI audience).
- Phase 4's `EditorController` extraction (S07) — no anticipatory refactoring of
  editor.ts.

## Exit criteria

- `bun run build` and `bun test` pass; `git diff --stat <session base>` over the code
  pathspec (plan.md › Session protocol) lists nothing under `src/pack-manager/model/`,
  `src/editor/`, `src/shared/`, `src/pack-manager/view/pack-list-drag.ts`,
  `src/pack-manager/view/reorder-drag.ts` or any `*.css`.
- Grep: `grep -rn "bridgeInPlace" src` → no hits; `grep -rlE "bridgeDialog|bridgedConfirm" src`
  lists exactly `src/react/bridge.ts`, `src/pack-manager/view/dialogs.tsx`,
  `src/pack-manager/view/upload-list.tsx`, `src/pack-manager/view/pack-list-store.ts`
  (its `deletePack` confirm) and `src/pack-manager/view/pack-view.tsx` (its `showRejected`); no `<StrictMode>`
  anywhere in `src/`.
- The Pack Manager mounts only from `mountScreen` (`mountView(content,
  "pack-manager", …)` then `packManagerShown()`); `grep -rn "mountView\|mountDomView"
  src/views/pack-manager.tsx src/pack-manager` → no hits (list ↔ pack is store
  state); no effect calls `shown()`/`packManagerShown()`.
- Focus preserved while typing Title / Short Name through a background `reload()`
  (uncontrolled + every-commit focused-guard effect); an invalid Title / Short Name
  committed with Enter reverts to the stored value while the input keeps focus.
- A Title / Short Name commit whose `finally` runs after unmount (type, click another
  tab at once) writes to the captured element: no error reaches the message line, and
  on return the input shows the stored value.
- Focus + half-typed Emoji String preserved through a `persistEmoji` render
  (component-local draft).
- The panel never rebuilds under the cursor (stable `panelFor(selection)`+id keys —
  the old `document.activeElement` guard is gone, not needed).
- Drain exact: edit a sticker in the Editor → save → follow the saved-note link → the
  sticker's tile shows the new image exactly once, no stale blob (drain before
  `loadPackView`, per-id `forget`, thumbnail variant included). Tiles, the thumbnail
  slot and the panel are not re-keyed for this: S04's `PreviewImage` swaps to the new
  promise on the same node.
- Replace, folder rename and a thumbnail change (each drops a previews-cache entry)
  show the new image on the tile, thumbnail slot and detail panel — never the old
  revoked blob.
- Reveal selects and scrolls (pending reveal consumed once by a layout effect after
  the `scrollTop` restore, `scrollIntoView({block:"nearest"})`); a tab switch away and
  back does not re-scroll to it; REVEAL_BUSY and REVEAL_GONE messages unchanged.
- The `dialogOpen()` guards hold (contract #6): with a dialog open, Esc/Delete do
  nothing to the pack view (keydown :507) and a file drop imports nothing (drop :293);
  both guards use `rootRef.current?.isConnected` for today's `root.isConnected`.
- Busy-gating: double-click Add images runs one import.
- Tab-switch-and-back keeps the open pack, its scroll position, and re-reads without
  a Missing scan (`reload()`, not `openPack()` — SPEC §4).
- Tab-switch-and-back and open-pack-and-back from the **Pack list** keep its search
  text, the filtered rows, the loaded packs (no "No packs yet" flash) and the
  `pm-notice`, as today's cached-DOM re-attach does (views/pack-manager.ts:110/:141/
  :159) — state in `PackListStore` (step 6); the message line starts clear on each
  show, as today (:111/:171). Tab-switch-and-back with a pack open keeps the
  `.pm-panel` scroll position.
- Settings → re-point disposes everything: `forgetPackManager()` → `dispose()`
  (disposed=true, pack destroyed, `publish(NO_PACK_MANAGER)`).
- Windows checklist passed; PR merged with `gh pr merge <N> --merge`.

## Review-cycle coverage

- The write-site audit list (step 1) checked off line by line — all 42 lines (28
  core writes + 14 swaps/other writes, step 1's two grep patterns) accounted for as
  store field or derived render; the reviewer re-runs the greps on the old closure
  and confirms none was dropped (phase risk 1).
- Every `key=` that can change while an input inside is focused (phase risk 2's
  named review finding); each of the three focus guards (Risks and fallbacks) uses
  its own mechanism.
- Async races across unmount (phase risk 3): an `openPack` in flight at tab-switch
  hits `disposed || mine !== opening`, destroys its handle, never publishes.
- The drain is single-site and ordered (drain → forget → loadPackView); no second
  caller of `takeChangedStickers` introduced.
- `run()` busy-gate and keydown guard ladder exact; effects have cleanups that today's
  explicit calls imply.
- The two outside consumers re-checked: the Editor's save dialog (through the el()
  `packPicker`) and the shell's listener (`publish` shape unchanged).
- Stable-node identity: the grid `<ol>` and the root `.pm` element survive re-renders
  (drag modules re-query them per move).

## Owner / Windows checklist

1. Type in Title (then Short Name) while Refresh lands — the half-typed text survives,
   focus stays.
2. Type an Emoji String and save it — focus and the half-typed text survive the
   persist render.
3. Type inside the panel — it never rebuilds under the cursor.
4. Reorder mode: ghost follows the cursor, drop markers show, Esc cancels, the
   "Moved sticker #x to #y" notice appears.
5. Reveal from the Editor's saved-note link: opens the pack if closed, selects,
   scrolls, leaves Reorder.
6. **The drain**: edit a pack sticker in the Editor, save, follow the link — the
   sticker's tile shows the new image; repeat with the thumbnail variant. Also
   Replace a sticker, rename the folder, and change the thumbnail — tile, thumbnail
   slot and detail panel each show the new image, no broken/stale one.
7. Double-click Add images — exactly one import runs.
8. Reveal while the view is busy — REVEAL_BUSY message, then the reveal.
9. Tab away and back — the open pack, its grid and panel scroll positions are
   preserved, the thumbnails don't blank for a frame, and the pack re-reads without
   a Missing scan. From the Pack list with a search typed and a delete notice
   showing, tab away and back and open a pack and back — the search, filtered rows
   and notice stay, no "No packs yet" flash.
10. Settings → re-point the Library — the Pack Manager is fully forgotten (empty list
    or fresh state, no stale open pack, top bar shows no pack).
11. With Send to pack open, press Esc/Delete and drop a file on the window — the pack
    view ignores both.
12. After a reveal, tab away and back — no second scroll jump.
13. Edit the Title and click another tab straight away — on return no error shows
    in the message line and the Title is the stored one.

## Risks and fallbacks

- **Missing a write site shows stale chrome** (phase risk 1): the audit list is the
  mitigation; it is produced before the port and checked off during review.
- **Focus preservation is the signature failure mode** (phase risk 2): three guards,
  one mechanism each, no mixing — (1) the header's Title / Short Name: uncontrolled
  inputs + the every-commit focused-guard effect + the event-time `finally` write
  (step 4); (2) the panel's fields (Emoji String): stable `panelFor(selection)`+id
  keys + a component-local draft that commits or reverts on blur, as today; (3) the
  list's Search: a controlled input on a node that never remounts across reloads,
  its value in `PackListStore` (S04). Component-local state is allowed only for
  half-typed drafts like (2), never for owner-visible state that must survive a
  remount (step 6).
- **Async races across unmount** (phase risk 3): nothing unmounts mid-action today;
  mountView's unmount-on-switch introduces the case — the `disposed ||
  mine !== opening` path and handle destruction are the mitigation; owner test 9 and
  the "switch tabs immediately after clicking a pack" scenario.
- **Drag-node churn** (phase risk 4): stable `<ol>`/`<ul>` identity, host objects via
  refs, `cancelRowDrag()` at the same logical points.
- **Cross-phase breakage** (phase risk 5): the Editor's save dialog and the shell's
  listener are the two outside consumers — both frozen; the save-dialog flow is
  re-checked in this session's delta review.
- Fallback if S06 overruns: no scope slips to Phase 4 (S07 must start from a
  converged Phase 3). The split is decided once, at the end of step 1 (the audit's
  rule there), not mid-review; using it means S06 did not land clean (plan.md ›
  Clean landing). If split, the S06 agent proceeds as phase-3.md's recorded
  asymmetry decision names:
  first a store-extraction-only PR (`PackViewStore` driving the still-el() view, zero
  behavior change, like S07), then the tree/controller swap as a second PR, each
  through the Session protocol. The extra session is paid from the Phase 3
  compression lever when S04+S05 merged (both landed clean, plan.md › Clean landing);
  otherwise it adds one session to Phase 3's count, recorded on the Trekker task.
