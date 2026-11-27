# S06: Pack view + controller (Phase 3)

Corrections to the phase file: minor line drift, all re-verified at HEAD:
`views/pack-manager.ts` — `publish` :34, `setPackManagerListener` :41, `packManagerState`
:46, `showPackList` :51, `pendingReveal` :59, `renderPackManager` :76,
`forgetPackManager` :89, `build` :94, `showList` :103, `openPack` :115, `showSticker`
:152, `dispose` :175. `pack-view.ts` — `run()` busy-gate :167-177, `setView` :181,
`importPaths` :284, `persistEmoji` :371, keydown guard :507, document keydown :524,
`renderBanners` :580, `renderPanel` :589, `render` :597, panel guard :638, drain :644-647,
REVEAL_BUSY :657, REVEAL_GONE :668, `scrollIntoView` :676. `editor.ts` is at
`src/views/editor.ts` (`markThumbnailChanged` :1501, `markStickerFileChanged` :1539).

## Goal

The atomic swap: `pack-view.ts`'s 686-LOC closure becomes a `PackViewStore` external
store (same `subscribe()` shape as `EditorSession`, `src/editor/model/session.ts`)
consumed via `useSyncExternalStore` by a React PackView tree, and the singleton cache in
`views/pack-manager.ts` becomes a headless module-level controller plus `mountView()`
root management. `buildPackView` cannot land half-converted — this session lands it in
one change. When S06 ends the whole Pack Manager emits React, both drag systems still
run byte-identical vanilla code behind refs, and the phase's definition of done holds
(build/tests green, CSS byte-identical, drain contract exact, save dialog through the
remaining `packPicker` bridge).

## Preconditions

- S04 and S05 landed: list screen, dialogs, upload list, emoji leaves and panels are
  React behind the bridge; the bridge helper exists. Contingency: if S05 handed
  off `panels.ts` by explicit hand-off, it lands as this session's step 0 (work
  plan below) — not silently assumed converted.
- Phase 2's mount registry: `mountView()` guarantees unmount-before-clear-before-mount
  with exactly one view mounted at a time — S06 relies on it for root swaps and the
  scroll save/restore.
- Phase 3 precondition 2 landed: Settings re-point reaches `forgetPackManager()`
  (shell.ts:88).
- No parallel el()-based UX work (tickets 01/02) on these files.

## Files touched

| Path | Status |
|---|---|
| `src/pack-manager/view/pack-view.ts` (686 LOC) | closure → `PackViewStore` + React tree; replaced by a `.tsx` module (new), old file deleted |
| `src/views/pack-manager.ts` (184 LOC) | singleton cache → headless module-level controller + `mountView()` roots |
| `src/pack-manager/view/reorder-drag.ts` (91 LOC) | NOT edited — wiring only (JSX `onPointerDown` + `nativeEvent`) |
| `src/react/bridge.ts` | call-site removal (packPicker's stays) |
| `src/pack-manager/model/` , `src/editor/`, `src/shared/`, all `*.css` | untouched (grep-verified in exit criteria) |

## Work plan

0. **Contingency step 0 — only if S05 handed off `panels.ts`** (explicit
   hand-off per S05's fallback): land `panels.ts` first as S05 planned it
   (near-mechanical JSX, the emoji-box fit math untouched), including its
   bridge mount with the renderPanel-swap unmount, before the write-site
   audit below. Otherwise skip.
1. **Write-site audit first** (phase risk 1's mitigation): enumerate every direct DOM
   write in today's pack-view closure (38 core-pattern occurrences — ~44 with
   generous matching — `textContent`/`classList`/`disabled`/`title` across
   banners, toolbar, title/short inputs, grid, panel). Produce
   the audit list as a review-cycle artifact; every site maps to a store field or a
   derived render — nothing maps to "left as a direct write".
2. **`PackViewStore`**: `{ view, mode, selection, busy, notice, rejected, message }`
   plus `subscribe()`/`getSnapshot()`, mutable-snapshot pattern (version bump +
   notify), mirroring the `EditorSession` pattern (`src/editor/model/session.ts`).
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
   - `reread()`'s drain (:644-647): drain *before* `loadPackView`, per-id
     `previews.forget`, thumbnail only when `takeChangedThumbnails().includes(packId)`
     — ported verbatim, never called from a second site (driven by the Editor's
     `markStickerFileChanged` :1539 / `markThumbnailChanged` :1501);
   - `reveal()`'s REVEAL_BUSY (:657) / REVEAL_GONE (:668) paths;
   - the keydown guard ladder: `if (!root.isConnected || dialogOpen() || busy) return`
     (:507) + `document.addEventListener("keydown", onKey)` (:524) as effects with
     cleanups;
   - the drop listener with its cleanup.
4. **React PackView tree**:
   - header: Title/Short as uncontrolled inputs + a focused-guard sync effect (a
     background `reload()` must not clobber a half-typed input; sync only when the
     input is not focused — today's guard family, phase risk 2);
   - toolbar: disabled/title/tone-class derivations from store state (:623-631:
     refresh/Add/reveal/status disabled when busy; upload additionally blocked by
     `uploadBlocker`; title input disabled when busy; `shortInput.disabled = true`
     when busy);
   - notices: the single-banner rule (`renderBanners` :580 — one banner shows, the
     rule that picks it ported verbatim);
   - grid: a stable `<ol>` node (ref, never remounted — reorder-drag queries
     `.pm-tile[data-id]` each move), tiles keyed by sticker id, thumbnail slot last;
   - panel: keyed by `panelFor(selection)` + selected id (panels.ts is React since
     S05) — stable keys replace the `document.activeElement` panel guard (:638) by
     construction; delete the guard, don't keep both.
5. **Reveal scroll**: `render(); tile?.scrollIntoView({ block: "nearest" })` (:676)
   becomes a `useLayoutEffect` keyed on a `revealSeq` counter, querying the same
   selectors — commit-before-paint, so no visible jump.
6. **Controller** (`views/pack-manager.ts`): the singleton survives headless —
   - `opening` race counter, `disposed`, `pendingReveal` verbatim (:59, :100-101);
   - the handle-guard and publish-on-change contracts verbatim: `publish` drops
     no-change reports (:34-38); a report counts only from the handle that is the
     open pack (:123-124 `handleRef !== null && handleRef === pack`); the superseded
     open destroys its handle (`disposed || mine !== opening` :129-131) and a
     superseded failure stays silent (:144);
   - root swaps become `mountView()` root management (Phase 2 registry);
   - grid `scrollTop` saved on unmount and restored in a layout effect (four lines;
     without it mountView's unmount-on-switch regresses today's cached-DOM scroll
     preservation);
   - exported contracts unchanged: `setPackManagerListener`/`packManagerState`/
     `revealStickerOnShow`/`revealThumbnailOnShow`/`showPackList` (shell.ts is the
     only external caller).
7. **Reorder-drag wiring**: `ReorderDragHost` (reorder-drag.ts:8-15: `grid`,
   `enabled()`, `indexOf()`, `drop()`) rebuilt into a ref each render so
   `enabled()` reads `mode === "reorder" && !busy` live; `onPointerDown={(e) =>
   startReorderDrag(e.nativeEvent, id, hostRef.current)}`. The module code is
   byte-identical.
8. **Bridge call-site removal**: every S04/S05 bridge call inside the Pack Manager is
   replaced by direct React rendering — except `packPicker`'s, which stays until
   the SaveDialog port decision (S11) resolves (save-dialog.ts:14/:102; see the
   out-of-scope note below).
9. Run `bun run build` + `bun test`; then review-cycle per AGENTS.md, both axes,
   to convergence on this session's delta; the Editor save
   dialog flow is re-checked in the delta review (phase risk 5). The owner
   Windows checklist below gates the session's done-state; the session's PR
   lands with `gh pr merge <N> --merge` (AGENTS.md merge rule).

## Deliberately out of scope

- StrictMode (double-invoked effects would double-drain `takeChangedStickers` —
  binding contract #3).
- The Editor, the drag modules' code, or any model file.
- The `packPicker` bridge: it stays until the SaveDialog port decision (S11)
  resolves; if S11 keeps `save-dialog.ts` imperative, the bridge remains as a
  named post-adoption follow-up (S12 records it).
- Any CSS/class change; any new aria/role attributes (UI-audience rule).
- Phase 4's `EditorController` extraction (S07) — no anticipatory refactoring of
  editor.ts.

## Exit criteria

- `bun run build` and `bun test` pass; `git diff` empty under `src/pack-manager/model/`,
  `src/editor/`, `src/shared/`, `src/pack-manager/view/pack-list-drag.ts`,
  `src/pack-manager/view/reorder-drag.ts` and every `*.css`.
- Grep: no remaining bridge call sites except `packPicker` (e.g.
  `grep -rn "bridge(" src/pack-manager src/views` → only the packPicker site); no
  `StrictMode` anywhere in `src/`.
- Focus preserved while typing Title/Short through a background `reload()`
  (uncontrolled + focused-guard effect).
- Focus + half-typed Emoji String preserved through a `persistEmoji` render
  (component-local draft).
- The panel never rebuilds under the cursor (stable `panelFor(selection)`+id keys —
  the old `document.activeElement` guard is gone, not needed).
- Drain exact: edit a sticker in the Editor → save → follow the saved-note link → the
  tile shows the new image exactly once, no stale blob (drain before
  `loadPackView`, per-id `forget`, thumbnail variant included).
- Reveal selects and scrolls (`revealSeq` layout effect, `scrollIntoView
  ({block:"nearest"})`); REVEAL_BUSY and REVEAL_GONE messages unchanged.
- Busy-gating: double-click Add images runs one import.
- Tab-switch-and-back keeps the open pack, its scroll position, and re-reads without
  a Missing scan (`reload()`, not `openPack()` — SPEC §4).
- Settings → re-point disposes everything: `forgetPackManager()` → `dispose()`
  (disposed=true, pack destroyed, `publish(NO_PACK_MANAGER)`).
- Pack-list state (search text, message, scroll) survives open-pack-and-back
  exactly as today's cached-DOM re-attach does (views/pack-manager.ts:110/
  :141/:159 — the list element is detached on open, re-attached on `showList`,
  DOM state intact). Satisfied by keeping the list root mounted/hidden or by
  lifting the state into the controller.
- Review-cycle converged on this session's delta; the owner Windows checklist
  passed in full (it gates the done-state); the PR lands via
  `gh pr merge --merge`.

## Review-cycle coverage

- The write-site audit list (step 1) checked off line by line — every one of the
  38 core-pattern DOM writes (~44 with generous matching) accounted for as
  store field or derived render; the reviewer greps the
  old closure for writes and confirms none was dropped (phase risk 1).
- Every `key=` that can change while an input inside is focused (phase risk 2's
  named review finding); the three focus mechanisms match their guards.
- Async races across unmount (phase risk 3): an `openPack` in flight at tab-switch
  hits `disposed || mine !== opening`, destroys its handle, never publishes.
- The drain is single-site and ordered (drain → forget → loadPackView); no second
  caller of `takeChangedStickers` introduced.
- `run()` busy-gate and keydown guard ladder exact; effects have cleanups that today's
  explicit calls imply.
- The two outside consumers re-checked: the Editor's save dialog (through the packPicker
  bridge) and the shell's listener (`publish` shape unchanged).
- Stable-node identity: the grid `<ol>` and the root `.pm` element survive re-renders
  (drag modules re-query them per move).

## Owner / Windows checklist

1. Type in Title while Refresh lands — the half-typed text survives, focus stays.
2. Type an Emoji String and save it — focus and the half-typed text survive the
   persist render.
3. Type inside the panel — it never rebuilds under the cursor.
4. Reorder mode: ghost follows the cursor, drop markers show, Esc cancels, the
   "Moved sticker #x to #y" notice appears.
5. Reveal from the Editor's saved-note link: opens the pack if closed, selects,
   scrolls, leaves Reorder.
6. **The drain**: edit a pack sticker in the Editor, save, follow the link — the tile
   shows the new image; repeat with the thumbnail variant.
7. Double-click Add images — exactly one import runs.
8. Reveal while the view is busy — REVEAL_BUSY message, then the reveal.
9. Tab away and back — the open pack and its scroll position are preserved, and the
   pack re-reads without a Missing scan.
10. Settings → re-point the Library — the Pack Manager is fully forgotten (empty list
    or fresh state, no stale open pack, top bar shows no pack).

## Risks and fallbacks

- **Missing a write site shows stale chrome** (phase risk 1): the audit list is the
  mitigation; it is produced before the port and checked off during review.
- **Focus preservation is the signature failure mode** (phase risk 2): three guards
  → three distinct mechanisms (uncontrolled+focused-guard effect; stable keys +
  component-local draft; local state) — one mechanism per guard, no mixing.
- **Async races across unmount** (phase risk 3): nothing unmounts mid-action today;
  mountView's unmount-on-switch introduces the case — the `disposed ||
  mine !== opening` path and handle destruction are the mitigation; owner test 9 and
  the "switch tabs immediately after clicking a pack" scenario.
- **Drag-node churn** (phase risk 4): stable `<ol>`/`<ul>` identity, host objects via
  refs, `cancelRowDrag()` at the same logical points.
- **Cross-phase breakage** (phase risk 5): the Editor's save dialog and the shell's
  listener are the two outside consumers — both frozen; the save-dialog flow is
  re-checked in this session's delta review.
- Fallback if S06 overruns: the swap is atomic, so no scope slips to Phase 4 (S07 must
  start from a converged Phase 3). Instead, non-focus-critical polish (e.g. banner
  text edge cases, notice wording diffs found in review) moves to a Phase-3
  overrun fallback session (store-extraction split per the phase file's recorded
  asymmetry decision) — no new numbered session is created — and the Phase 3
  compression lever (S04+S05 having merged, if it appeared) is the capacity
  source. The store + tree + controller swap itself must land here.
