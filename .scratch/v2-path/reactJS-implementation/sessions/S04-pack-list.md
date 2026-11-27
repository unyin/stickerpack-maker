# S04: Pack list screen (Phase 3)

Corrections to the phase file: (a) the drag modules live at
`src/pack-manager/view/pack-list-drag.ts` / `reorder-drag.ts`, not a `drag/` subdirectory.
(b) Line drift since the phase was measured: `forgetPackManager()` is called at
`src/shell.ts:88` (phase said :97), alongside `resetPackMemory()` (:89) and
`forgetEditorOrigin()` (:90). (c) `pack-list-drag.ts`'s module-level singletons sit at
`clickSuppressed` :50, `disarmRelease` :62, `activeDrag` :93 (phase said :60/:76/:100);
`rowClickSuppressed()` is consumed at `pack-list.ts:178` (phase said :188).
(d) `RowDragHost` has 2 members (`list`, `drop` — pack-list-drag.ts:9-14), not 4;
`ReorderDragHost` has 4 (`grid`, `enabled()`, `indexOf()`, `drop()` — reorder-drag.ts:8-15).

## Goal

The Pack Manager's list screen emits React 19: `pack-list.ts`'s closure becomes a
`PackList` component (list state in React, an imperative handle for the not-yet-converted
controller), `previewImage` becomes a `PreviewImage` component, and the create-pack
dialog subset of `dialogs.ts` renders React bodies inside the still-imperative
`openDialog` via a temporary bridge helper. When S04 ends the owner sees a pixel-identical
pack list that opens, filters, drags, creates and deletes packs exactly as today, the
controller in `views/pack-manager.ts` still drives it through
`reload()/showError()/clearMessage()`, and all CSS is byte-identical.

## Preconditions

- S01 (Phase 1) landed: React 19 deps, Vite JSX config, the `mountView()` root-tracking
  helper in `src/react/`.
- S02–S03 (Phase 2) landed: shell converted, heterogeneous mount registry (React roots +
  el() DOM mounts, unmount-before-clear-before-mount), navigation seam, dialog/combobox
  imperative-island decision recorded as binding contract #2.
- Library re-point invalidation reaches `forgetPackManager()` (shell.ts:88) alongside
  `resetPackMemory()`/`forgetEditorOrigin()` — Phase 3 precondition 2, landed in Phase 2.
- No parallel el()-based UX work (tickets 01/02) on these files.
- Compression lever (plan.md): if S04 and S05 both converge in one review
  round, S05 absorbs S04's leftovers and Phase 3 finishes in two sessions —
  decide at S05's start, not mid-session.

## Files touched

| Path | Status |
|---|---|
| `src/pack-manager/view/pack-list.ts` (253 LOC) | converted; replaced by `pack-list.tsx` (new), old file deleted |
| `src/pack-manager/view/previews.ts` (72 LOC) | `Previews` class kept verbatim; `previewImage` (:58-70) replaced by `PreviewImage` component |
| `src/pack-manager/view/dialogs.ts` (531 LOC) | subset only: `statusBadge` (:37), `reservedLabel` (:50), `newPackFields` (:60), `createPackDialog` (:113); `packPicker` and the confirm/send dialogs untouched |
| `src/pack-manager/view/pack-list-drag.ts` (163 LOC) | NOT edited — wiring moves into JSX in `pack-list.tsx` |
| `src/views/pack-manager.ts` (184 LOC) | surgical slice only: the `buildPackList(...)` call becomes a React mount through the bridge; `openPack`/`showSticker`/`pendingReveal`/`showList`/`dispose` untouched |
| `src/react/bridge.ts` | new (~15 LOC, the temporary bridge helper of binding contract #2) |
| `src/react/ImperativeNode.tsx` | new (~15 LOC, ref + useEffect wrapper taking a factory producing a Node) |

## Work plan

1. **Bridge helper** (`src/react/bridge.ts`, new): `bridge(node: ReactElement):
   { element: HTMLElement; unmount(): void }` — `createRoot` into a detached
   `document.createElement("div")`, render, hand back the div's rendered child as the
   body node (never the wrapper div — no extra DOM node, no class-identity drift), and
   expose `unmount()` to be called when the dialog's result settles. This is binding
   contract #2's mechanism; S06 removes every call site except `packPicker`.
   **Ref-embed helper** (`src/react/ImperativeNode.tsx`, new): a ~15-line
   `useRef` + `useEffect` wrapper taking a factory producing a `Node` — appends
   the node on mount, removes it on unmount, never re-diffs its children. It is
   needed now, not first in S08: S05's bridged packPicker bodies embed the
   imperative Combobox and upload-list embeds `makeDragHandle` through it, so it
   lives in `src/react/` and S05/S08 import it from there. The React row
   exercises it immediately via the bridged `statusBadge`.
2. **`PreviewImage`**: port `previewImage(url: Promise<string|null>, alt, className)`
   (previews.ts:58-70) to a component — state `src`, effect resolves the promise:
   fills `src` on a URL, adds the `unreadable` class on null. `alt`, `className`,
   `draggable={false}` preserved. The `Previews` class (blob-URL cache, `forget`,
   `forgetThumbnail`, `clear`, `revoke`) stays byte-identical — it is pure cache logic.
3. **`PackList` component** (pack-list.tsx, replacing pack-list.ts): props
   `{ onOpen(id: number) }`; state: `packs: PackListEntry[]`, search text, message
   `{text, loadFailed}`, `notice` text, per-row `Previews[]` (one cache per row, dropped
   on every reload — today's comment at pack-list.ts:46).
   - `say(text, fromLoad = false)` message-precedence rule ported verbatim
     (pack-list.ts:40-43): a successful reload clears the line only when a failed LOAD
     wrote it; each show of the list starts clear.
   - `useImperativeHandle` on a ref exposes `reload() / showError(text) / clearMessage()`
     so the el() controller keeps driving the list unchanged.
   - `loads` overlap counter ported verbatim (pack-list.ts:199): only the latest load
     paints, failures included — keep it in a ref, not state.
4. **Rows as JSX**: `<li class="pm-pack-row" data-id={String(pack.id)}>` with, in order:
   grip, thumbnail cell, open button, status cell, `statusBadge(pack.status)`, folder
   button, Delete — the exact tree of `row()` (pack-list.ts:141-181). Rows keyed by
   `data-id`. The row click handler keeps `rowClickOpens({ onControl, endsDrag:
   rowClickSuppressed() })` (:176-179); the grip's pointerdown keeps the
   `reorderAllowed(search.value)` guard then `startRowDrag(e, item, pack.id, { list, drop })`
   — in JSX: `onPointerDown={(e) => { if (!reorderAllowed(search)) return;
   startRowDrag(e.nativeEvent, itemRef.current!, pack.id, hostRef.current); }}`.
5. **Drag host**: `RowDragHost` is `{ list: HTMLElement; drop(packId, position) }`
   (pack-list-drag.ts:9-14). Rebuild the host object into a ref each render so `drop()`
   always reads the latest state; `list` is the stable `<ul class="pm-pack-list">` node
   via ref. `pack-list-drag.ts` itself is byte-identical.
6. **Filtering**: port `applyFilter()` (pack-list.ts:210-222) as a render over
   `hidden` attributes — rows are NOT rebuilt on typing; `searchView(packs, query)`
   (model) decides `shownIds`; `cancelRowDrag()` when `view.filtering`; `paint()`
   (full redraw on reload) also calls `cancelRowDrag()` first (:225). Zero new preview
   fetches while typing — the per-row `Previews` caches live across filter changes.
7. **Create-pack subset** (dialogs.ts): `openDialog` stays imperative; the dialog body is
   React via the bridge, unmounted when the handle's result settles. `newPackFields`
   becomes a component exposing `{ title, problem(), read() }` through a ref: port the
   `suggestShortName` request-counter race guard verbatim (dialogs.ts:70-77: `request`
   counter, `edited` flag, `if (mine === request && !edited)`), the `hint.textContent`
   flip on manual edit (:85-91), Enter → `onEnter` (:92-96), and `createPackDialog`'s
   button gating (`create.disabled = why !== null; create.title = why ?? ""` :121-122,
   message rule :123). `statusBadge`/`reservedLabel` stay el()-exported — the React row
   embeds `statusBadge`'s el() output through `ImperativeNode`
   (src/react/ImperativeNode.tsx) until S06 converts the el() pack header.
8. **Controller wiring** (views/pack-manager.ts): the `buildPackList((id) =>
   void openPack(id))` call site (:96) becomes a bridge/mountView mount of `PackList`;
   the controller keeps calling `list.clearMessage() / list.reload() / list.showError(...)`
   through the handle (showList :103-113, openPack's error path :146). Nothing else in
   this file changes.
9. Run `bun run build` + `bun test`; then review-cycle per AGENTS.md, both axes,
   to convergence on this session's delta (coverage below) before any owner test.
   The owner Windows checklist below gates the session's done-state; the session's
   PR lands with `gh pr merge <N> --merge` (AGENTS.md merge rule).

## Deliberately out of scope

- `openPack`/`showSticker`/`pendingReveal` in the controller (S06).
- Converting `pack-list-drag.ts` or `reorder-drag.ts` code — wiring only, ref-wrap
  decision (phase file, "The drag decision").
- Converting `statusBadge`'s el() body for the el() pack header (embedded via
  `ImperativeNode` for the React row until S06).
- Any CSS/class change; any `model/` change (`searchView`, `rowSlotAt`, `dropPosition`,
  `reorderAllowed`, `names.ts` untouched).
- The rest of `dialogs.ts` (`packPicker`, `sendDialog`, confirm dialogs — S05).
- No `<StrictMode>` anywhere (binding contract #3).

## Exit criteria

- `bun run build` and `bun test` pass; `git diff` empty under `src/pack-manager/model/`,
  `src/editor/`, `src/shared/` and every `*.css`.
- The `<ul class="pm-pack-list">` node never remounts across reloads/filters (the drag
  ghost reads `getComputedStyle(list).gridTemplateColumns` off that exact node,
  pack-list-drag.ts:35); `packRows(list)` still finds `:scope > .pm-pack-row[data-id]`.
- Filtering sets `hidden` without rebuilding rows: typing in Search fires zero new
  preview fetches (caches reused, no `Previews` re-instantiation on filter).
- `cancelRowDrag()` still runs when the filter narrows mid-drag and on every `paint()`.
- Create-pack's `suggestShortName` race guard survives fast typing (only the latest
  request writes the Short Name field; manual edit still freezes derivation).
- Drag-end click suppression intact: a click right after a drop opens the pack
  (`rowClickSuppressed()` consumed at the row click; `clickSuppressed` cleared via
  `setTimeout(..., 0)`, pack-list-drag.ts:58).
- Grep: no `StrictMode` import anywhere in `src/`.
- `src/react/ImperativeNode.tsx` exists and is exercised by the bridged
  `statusBadge` in the React row (S05 imports it from `src/react/`).
- Review-cycle converged on this session's delta; the owner Windows checklist
  passed in full (it gates the done-state); the PR lands via
  `gh pr merge --merge`.

## Review-cycle coverage

- Class-identity diff: rendered DOM of the list (rows, badges, empty items, message
  `<p class="message" role="alert">`, notice `<p class="pm-notice" role="status">`)
  compared node-for-node against the el() tree — same classes, same attribute order
  tolerance, same aria attributes (UI-audience rule: existing aria stays, nothing added).
- The `say` precedence rule and `loads` counter against pack-list.ts:40-43/:199-243.
- Every `key=` in the row list cannot change while a drag is active; the `<ul>` ref is
  the mounted node, not a re-created one.
- Bridge usage: every `bridge()` call has a matching `unmount()` on dialog settle.
- The NOT list above (especially: drag module byte-identical, `git diff` on
  `pack-list-drag.ts` empty).

## Owner / Windows checklist

1. Type in Search: rows hide/show, thumbnails must not flash or refetch, a mid-drag
   filter cancels the drag cleanly.
2. Drag a row by the grip to the first and last position and drop — order persists.
3. Press Esc mid-drag — drag aborts, no ghost left behind.
4. Click the row right after a drag — it must open the pack, not swallow the click.
5. Create a pack typing Title fast — the auto Short Name keeps up with fast typing.
6. Delete a Draft pack and a Live pack — confirm dialogs, folder-removal notice.
7. Rapid PM tab switches during load — only the latest load paints, no stale rows.

## Risks and fallbacks

- **Drag-node churn** (phase risk 4): React reconciliation must never replace row nodes
  mid-drag — mitigated by `data-id` keys, `hidden`-attr filtering (no rebuild), and the
  stable `<ul>` ref; review checks every re-render trigger.
- **Interleaving with the drag singletons** (phase risk 4): `clickSuppressed`/
  `disarmRelease`/`activeDrag` are module-level exactly-once state; React state must
  not re-fire pointerdown handlers — single `onPointerDown`, no synthetic re-dispatch.
- **Explicit-paint discipline** (phase risk 1): the list's reload path decides when rows
  rebuild (`paint()`); make sure no derived re-render duplicates or skips it.
- Fallback if S04 overruns: the create-pack dialog subset (step 7) slips to
  S05's step 0 by explicit hand-off — S05 already owns the rest of `dialogs.ts`,
  and its Preconditions carry the matching contingency line — so sequencing
  survives because the controller does not touch `createPackDialog`. The list
  screen itself (steps 1-6, 8) must land.
