# S04: Pack list screen (Phase 3)

Corrections to the phase file: (a) the drag modules live at
`src/pack-manager/view/pack-list-drag.ts` / `reorder-drag.ts`, not a `drag/` subdirectory.
(b) Line drift since the phase was measured: `forgetPackManager()` is called at
`src/shell.ts:88` (phase said :97), alongside `resetPackMemory()` (:89) and
`forgetEditorOrigin()` (:90). (c) `pack-list-drag.ts`'s module-level singletons sit at
`clickSuppressed` :50, `disarmRelease` :62, `activeDrag` :93 (phase said :60/:76/:100);
`rowClickSuppressed()` is consumed at `pack-list.ts:178` (phase said :188).
(d) `RowDragHost` has 2 members (`list`, `drop` — pack-list-drag.ts:9-14), not 4;
`ReorderDragHost` has 4 (`grid`, `enabled()`, `indexOf()`, `drop()` — reorder-drag.ts:8-17).
(e) The phase file's "bridge into a detached div" mechanism is superseded by plan.md
binding contract #2. (f) The phase file keys rows by `data-id`; this session keys them
per paint, `${paints}:${id}` (step 5), so a reload mounts fresh rows as `paint()` does.

All anchors are at commit `11bacb6` (plan.md › Anchor base); a `file.ts:NN` anchor
cites the file as it stood there, before this session's renames.

**Renames** (S01's rule: a file that gains JSX becomes `.tsx`): this session
`git mv`s `previews.ts` → `previews.tsx`, `dialogs.ts` → `dialogs.tsx` and
`src/views/pack-manager.ts` → `src/views/pack-manager.tsx`, each in the commit that
first adds JSX to it. No importer changes: every import of them is extensionless
(`"./previews"` at dialogs.ts:34 / pack-list.ts:24 / pack-view.ts:77 / panels.ts:19 /
upload-list.ts:29, `"./dialogs"` at pack-list.ts:22 / pack-view.ts:74 (a multi-line import), `"../../pack-manager/view/dialogs"`
at save-dialog.ts:14, `"./views/pack-manager"` at shell.ts:15) under
`moduleResolution: "bundler"` (tsconfig.json:6), and no test imports them.
`pack-list-store.ts` and `bridge.ts` hold no JSX and stay `.ts`.

## Goal

The Pack Manager's list screen emits React 19: `pack-list.ts`'s closure becomes a
controller-owned `PackListStore` (the list's state and commands, outside React) and a
`PackList` component that renders from it through `useSyncExternalStore`, `PreviewImage` and `StatusBadge` React twins appear beside the el()
`previewImage`/`statusBadge` (which keep serving their el() consumers), and the
create-pack dialog renders a React body inside the still-imperative `openDialog` through
the contract #2 bridge. When S04 ends the owner sees a pixel-identical pack list that
opens, filters, drags, creates and deletes packs exactly as today, the controller in
`views/pack-manager.tsx` still drives it through `reload()/showError()/clearMessage()` —
now store commands — and all CSS is byte-identical. Because the state lives in the
store from the start, S06 only drops the in-place root; it lifts nothing.

## Preconditions

- S01 (Phase 1) landed: React 19 deps, Vite JSX config, the `mountView()` root-tracking
  helper in `src/react/`.
- S02–S03 (Phase 2) landed: shell converted, heterogeneous mount registry with
  `unmountViews()`/`unmountShell()` (the Pack Manager is still mounted as an el() DOM
  mount by `mountScreen`, called from the navigation handler `show()` — or
  `renderShell` at boot — after the shell's `flushSync` commit, outside React;
  plan.md contract #1), navigation seam, dialog/combobox
  imperative-island decision recorded as binding contract #2, and S02's
  `src/react/Icon.tsx` (byte-identical `icon()` markup) — the React row needs it for
  `icon("grip")` and for `explorerLabel()`'s `"Open in explorer"` + `icon("external")`.
- Library re-point invalidation reaches `forgetPackManager()` (shell.ts:88) alongside
  `resetPackMemory()`/`forgetEditorOrigin()` — Phase 3 precondition 2, landed in Phase 2.
- No parallel el()-based UX work on these files (tickets
  [01](../../issues/01-pack-manager-interactions.md) /
  [02](../../issues/02-editor-tools-and-layers.md)).

## Files touched

| Path | Status |
|---|---|
| `src/pack-manager/view/pack-list.ts` (253 LOC) | converted; replaced by `pack-list-store.ts` (new, the `PackListStore`) and `pack-list.tsx` (new, the `PackList` component), old file deleted |
| `src/pack-manager/view/previews.tsx` (renamed from `previews.ts`, 72 LOC) | `Previews` class and module function `revoke` (:57) kept verbatim; el() `previewImage` (:62-72) kept for its el() consumers, with one added line in its `.then` (:67) filling the settled-previews map (step 2); React twin `PreviewImage` and the `settledPreview` lookup added (step 2) |
| `src/pack-manager/view/dialogs.tsx` (renamed from `dialogs.ts`, 531 LOC) | subset only: React twins of `statusBadge` (:37) and `newPackFields` (:60), `createPackDialog` (:113-152) bridged; el() `statusBadge`/`reservedLabel` (:50)/`newPackFields` kept; `packPicker` and the confirm/send dialogs untouched |
| `src/pack-manager/view/pack-list-drag.ts` (163 LOC) | NOT edited — wiring moves into JSX in `pack-list.tsx` |
| `src/views/pack-manager.tsx` (renamed from `src/views/pack-manager.ts`, 184 LOC) | surgical slice only: the `buildPackList(...)` call (:96) becomes a `PackListStore` plus a React root on the list section in place, `dispose` (:175) unmounts it, and the `list.*` calls address the store; `openPack`/`showSticker`/`pendingReveal`/`showList` otherwise untouched |
| `src/react/bridge.ts` | new (~25 LOC, binding contract #2's dialog and in-place bridges); the second sanctioned `createRoot` site, beside S02's `mount.ts` |

## Work plan

1. **Bridge helper** (`src/react/bridge.ts`, new) — the API over plan.md binding
   contract #2, which holds the one copy of the mechanism. `bridge.ts` is the second
   file allowed to call `createRoot`, beside S02's `mount.ts` (S02: `createRoot`
   only in `src/react/`). Signatures:
   - `bridgeDialog(handle, body: ReactNode): void` — dialog body bridge;
     `.app-dialog-body` is dialog.ts:64's.
   - `bridgeInPlace(host: HTMLElement, node: ReactNode): Root` — non-dialog bridge;
     the caller names its discard point and unmounts there.
   - `bridgedConfirm(title, body, spec)` — added by S05 (its step 1).
   Dialog bridges stay for the whole adoption; S06 removes only the in-view bridges
   (`PackList` here, S05's panels).
   No `ImperativeNode` helper is built in S04–S06 (that is S08's); where an el() node
   must sit inside React output, it attaches to an existing React-rendered element via
   a ref, never through an added host element.
2. **`PreviewImage`** (React twin of `previewImage`, previews.ts:62-72) — fills `src`
   on a URL, adds the `unreadable` class on null. A promise that has already settled
   is read **synchronously at render**, never through an effect: previews.tsx gains a
   module-level `WeakMap<Promise<string | null>, string | null>` filled when each
   preview promise settles, and `settledPreview(url)` returns its value (`undefined`
   while pending). `PreviewImage` initialises its state from it, and only a pending
   promise goes through the effect + `setState` path. `PreviewImage` also handles a
   changed `promise` prop on the same node (derived-state reset during render): it
   tracks the promise it last showed; on a different one it reads the settled URL
   synchronously if `settledPreview` has it, else clears to today's placeholder state
   (no `src`, no `unreadable`) and awaits the new one; a superseded promise's
   resolution is ignored. So no consumer needs to re-key it — a cache drop that hands
   the same tile a new promise (S06's Replace, folder rename, thumbnail change, the
   Editor-save drain) shows the new image, never the old revoked one. A remount over a
   cached promise (S06's tab switch, S05's keyed panels) paints the image in its first
   frame, as today's `.then` microtask does before paint — no blank-tile frame. The
   `Previews` class itself is untouched (the map sits beside it, filled by a `.then`
   that `PreviewImage` attaches the first time it sees a promise, and by one added line
   in the el() `previewImage`'s own `.then` (previews.ts:67), so promises the el()
   tiles settled before S06 — the detail/thumbnail panel and stickerCard /
   confirmThumbnailDelete previews — are in the map too). `alt`, `className`, `draggable={false}` preserved. The el() `previewImage`
   stays: dialogs.tsx (stickerCard :157, choiceCard :292, confirmThumbnailDelete :344),
   panels.ts (:69, :195) and upload-list.ts (:151) port in S05, pack-view.ts (:430,
   :469) in S06 — **S06 deletes the el() `previewImage`** once pack-view, its last el()
   consumer, ports. The `Previews` class (blob-URL cache, `forget`, `forgetThumbnail`,
   `clear`) and the module function `revoke` stay byte-identical.
3. **`PackListStore`** (pack-list-store.ts, new) — the list's state and commands,
   owned by the controller (step 9), mutable-store pattern with `subscribe()` /
   `getSnapshot()` and one notify per command (plan.md binding contract #4):
   `getSnapshot` returns a version counter (`() => store.version`, bumped on every
   mutation before the notify, as S08's `() => controller.version`), and components
   read the fields from the store object itself — returning the same mutated object
   would make `useSyncExternalStore` bail out of every re-render. It holds
   every piece of list state the owner sees: the loaded `packs: PackListEntry[] | null`
   (`null` until the first successful load paints — today's `<ul>` stays childless and
   `.pm-pack-count` blank until the first `paint()`, :202-231, and a failed first load
   leaves them so, with only the error in the message line), the
   search text (which decides the filter through `searchView`), the message
   `{text, loadFailed}`, the `pm-notice` text (pack-list.ts:98-100, both the
   `Deleted “…”.` line and the leftover-folder path), a `paints` counter (bumped by
   each successful load's paint, used in row keys, step 5), plus the per-row
   preview caches and the `loads` counter, which are not rendered. The caches:
   `reload()`'s success path creates them — `previews: Map<number, Previews>`, one new
   `Previews` per loaded pack keyed by pack id, on the store — after clearing the
   previous map's (pack-list.ts:46/:142-143/:226-227); a row reads its cache with
   `store.previews.get(pack.id)` and calls `thumbnailOf`/`sticker` at render, which
   memoise their promise, so a filter re-render fetches nothing. Commands: `reload()`,
   `showError(text)`, `clearMessage()`, `setSearch(text)`, `deletePack(pack)`,
   `reorder(packId, position)`; the folder button's message writes (`say("")` then
   `say(errorMessage(err))` on a failed `revealPack`, pack-list.ts:157-158) go through
   `clearMessage()`/`showError()`.
   - `say(text, fromLoad = false)` message-precedence rule ported verbatim
     (pack-list.ts:40-43): a successful reload clears the line only when a failed LOAD
     wrote it; each show of the list starts clear (the controller's `clearMessage()`
     before `reload()`, as today).
   - `loads` overlap counter ported verbatim (pack-list.ts:199): only the latest load
     paints, failures included.
   - `reload()`'s success path is today's `paint()` (:224-231): `cancelRowDrag()`,
     clear the old caches and build the new map, set `packs`, bump `paints` — then one
     notify. A failed load leaves `packs` as it was (`null` on a first load).
   - The pack-delete confirm lives in the store's `deletePack` command
     (pack-list-store.ts), never in the component: it keeps `confirmChoice` with its two
     el() paragraphs (pack-list.ts:86-93) until S05 moves it to `bridgedConfirm`; the
     command awaits it outside React, as today.
4. **`PackList` component** (pack-list.tsx): props `{ store: PackListStore;
   onOpen(id: number) }`; subscribes with `useSyncExternalStore(store.subscribe,
   store.getSnapshot)` (the version) and renders from the store's fields only — **no component `useState` for owner-visible state**, so
   S06's unmount-on-tab-switch loses nothing. No imperative handle: the controller
   calls the store.
   - Search: a controlled `<input type="search">` whose `onChange` calls
     `store.setSearch` and covers typing and the clear button; Esc-to-clear fires only
     the native `search` event (pack-list.ts:76-77), so a ref + effect attaches a
     `search` listener that calls `store.setSearch(input.value)` — the controlled value
     stays in sync.
   - While `packs === null` it renders the head with an empty `.pm-pack-count`, the
     intro, message and notice lines, and a childless `<ul className="pm-pack-list">`
     (no empty item, no no-match item, no `filtering` class) — so the first
     `listPackFacts` run (every first open, and the first after a Library re-point)
     never flashes "0 packs" or "No packs yet. Create one to start.".
5. **Rows as JSX**: `<li className="pm-pack-row" data-id={String(pack.id)}>` with, in
   order: grip (`<Icon name="grip"/>`), thumbnail cell (`PreviewImage`), open button,
   status cell, `<StatusBadge status={pack.status}/>`, folder button (`Open in
   explorer` + `<Icon name="external"/>`), Delete — the exact tree of `row()`
   (pack-list.ts:141-185). `StatusBadge` is plain JSX, the twin of el() `statusBadge`
   without `reserve`: `<span className={\`pm-badge pm-badge-${status}\`}>`. Rows keyed
   per paint, `key={\`${store.paints}:${pack.id}\`}`: a reload mounts fresh rows (and
   fresh `PreviewImage`s over the new caches' promises), matching `paint()`'s
   `replaceChildren` rebuild; a filter change keeps every key. `paint()`'s
   `cancelRowDrag()` runs before the notify, so no key changes under an active drag. The row click handler keeps `rowClickOpens({ onControl, endsDrag:
   rowClickSuppressed() })` (:176-179); the grip's pointerdown keeps the
   `reorderAllowed(search.value)` guard then `startRowDrag(e, item, pack.id, { list, drop })`
   — in JSX: `onPointerDown={(e) => { if (!reorderAllowed(store.search)) return;
   startRowDrag(e.nativeEvent, itemRef.current!, pack.id, hostRef.current); }}`.
6. **Drag host**: `RowDragHost` is `{ list: HTMLElement; drop(packId, position) }`
   (pack-list-drag.ts:9-14). Rebuild the host object into a ref each render; `drop()`
   calls `store.reorder(...)`, which reads the store's current state; `list` is the stable `<ul className="pm-pack-list">`
   node via ref. `pack-list-drag.ts` itself is byte-identical.
7. **Filtering**: port `applyFilter()` (pack-list.ts:211-221) as a render over
   `hidden` attributes — rows are NOT rebuilt on typing; `searchView(packs, query)`
   (model) decides `shownIds`; `store.setSearch` calls `cancelRowDrag()` when
   `view.filtering`, and `reload()` calls it first, as `paint()` does (:225). Zero new
   preview fetches while typing — the per-row `Previews` caches live across filter
   changes.
8. **Create-pack subset** (dialogs.tsx): `createPackDialog` opens `openDialog("New pack",
   [], …)` and bridges its three-node body (fields, the "New packs start as Draft."
   line, the message) with `bridgeDialog`; `syncCreate()` and `form.title.focus()`
   (:149-150) run after it, as today. A React `NewPackFields` twin exposes
   `{ title, problem(), read() }` through a ref; `problem()` and `read()` read the
   input elements' current `.value` through their refs (today `title.value` /
   `shortName.value` directly, :108-109), never React state, so `syncCreate()` —
   called on every edit through `onChange` — never gates on a value one keystroke
   stale. The twin also keeps the initial `preview()` call (:100: the hint and
   derived Short Name shown before the first keystroke), run once on mount. The
   message `<p class="message" role="alert">` is a React-rendered node with no React
   children, reached by the orchestrator through a ref: `syncCreate` (:123) and the
   Create action's error path (:140) keep writing its `textContent` verbatim, and
   React owns none of its content. Port the `suggestShortName`
   request-counter race guard verbatim (dialogs.ts:74-84: `edited` flag, `request`
   counter, `if (mine === request && !edited)`), the `hint.textContent` flip on manual
   edit (:88-94), Enter → `onEnter` (:95-99), and `createPackDialog`'s button gating
   (`create.disabled = why !== null; create.title = why ?? ""` :121-122, message rule
   :123). **el() versions kept, not deleted**: `newPackFields` (packPicker's inline
   form, dialogs.ts:417/:435/:437), `statusBadge` (packPicker's `packOption` :373 and
   the el() pack header, pack-view.ts:606) and `reservedLabel` (pack-view.ts:606/:608).
   packPicker and these el() helpers stay el() through the whole adoption
   (save-dialog.ts:102 owns its dialog and has no settle point to unmount a bridge
   root; S11 puts the pack picker out of scope): their port is a named post-adoption
   follow-up, which S12 records. S06 adds the `reserve` variant and a `ReservedLabel` twin
   for the React pack header.
9. **Controller wiring** (views/pack-manager.tsx): the `buildPackList((id) =>
   void openPack(id))` call (:96) becomes `const list = new PackListStore()` plus a
   React root created with `bridgeInPlace` on the list's real host element in place: the controller builds the
   `<section class="view pm-list">` with el() (moved from pack-list.ts:60-62) and `PackList` renders its children
   (head, intro line, message, notice, `<ul>`). `showList`/`build` keep moving that
   section in and out of `.pm` (:110/:159) — the container moves whole, so event
   delegation holds, and the list's state (in the store) survives detach/re-attach as
   today. This is NOT a `mountView()` mount (mountView unmounts every tracked root). Its discard point
   is `dispose()` (:175, reached via `forgetPackManager()`), which unmounts the root
   synchronously; `build()` creates it with `bridgeInPlace` — both callers run
   outside React (contract #1): `bridgeInPlace(section, <PackList store={list}
   onOpen={…}/>)`. The controller's calls keep their names and call sites but address
   the store — `list.clearMessage() / list.reload() / list.showError(...)` (showList
   :103-113, `shown` :164-174, openPack's error path :146) are store mutations, valid
   whether or not a component is subscribed (no handle, no forwarder, no replay).
   A store change made outside React flushes its `useSyncExternalStore` re-render in a
   microtask, still before the browser paints, so the message line never paints a
   stale frame. Nothing else in this file changes.
10. **Land per plan.md › Session protocol**, with this session's byte-identity checks:
   `git diff --stat <session base> -- src/pack-manager/view/pack-list-drag.ts` empty,
   and the checklist below.

## Deliberately out of scope

- `openPack`/`showSticker`/`pendingReveal` in the controller (S06).
- Converting `pack-list-drag.ts` or `reorder-drag.ts` code — wiring only, ref-wrap
  decision (phase file, "The drag decision").
- Deleting any el() helper that a still-el() consumer uses (`previewImage`,
  `statusBadge`, `reservedLabel`, `newPackFields` — step 2 and step 8 name who deletes
  each); `packPicker` (el() through the whole adoption; post-adoption follow-up, S12 records it).
- Any change to the controller beyond step 9 — S06 owns the controller port.
- Any CSS/class change; any `model/` change (`searchView`, `rowSlotAt`, `dropPosition`,
  `reorderAllowed`, `names.ts` untouched).
- The rest of `dialogs.tsx` (`sendDialog`, confirm and choice dialogs — S05).
- No `<StrictMode>` anywhere in `src/` (binding contract #3).

## Exit criteria

- `bun run build` and `bun test` pass; `git diff --stat <session base>` over the code
  pathspec (plan.md › Session protocol) lists nothing under `src/pack-manager/model/`,
  `src/editor/`, `src/shared/` or any `*.css`.
- `PackList` holds no `useState` for owner-visible state: packs, search, message and
  notice render from `PackListStore` (grep `useState` in pack-list.tsx — none;
  non-rendered bookkeeping goes in `useRef`); `PreviewImage` reads a settled promise at render.
- The `<ul class="pm-pack-list">` node never remounts across reloads/filters (the drag
  ghost reads `getComputedStyle(list).gridTemplateColumns` off that exact node,
  pack-list-drag.ts:35); `packRows(list)` still finds `:scope > .pm-pack-row[data-id]`.
- No empty-state flash: on the first open, and on the first open after a Library
  re-point, the list shows a childless `<ul>` and a blank count until the packs paint —
  never "0 packs" or "No packs yet. Create one to start."; a failed first load leaves
  the `<ul>` childless and the count blank with the error in the message line, as today.
- Filtering sets `hidden` without rebuilding rows: typing in Search fires zero new
  preview fetches (caches reused, no `Previews` re-instantiation on filter); Esc in
  Search clears the field and the filter.
- `cancelRowDrag()` still runs when the filter narrows mid-drag and on every `paint()`.
- Create-pack's `suggestShortName` race guard survives fast typing (only the latest
  request writes the Short Name field; manual edit still freezes derivation).
- Drag-end click suppression intact: the release click that ends a drop is suppressed
  (`rowClickSuppressed()` consumed at the row click; `clickSuppressed` cleared via
  `setTimeout(..., 0)`, pack-list-drag.ts:58); a later click opens the pack.
- Every bridge root has its unmount: the create-pack body on `handle.result` settle,
  the `PackList` root in `dispose()`.
- Grep: no `<StrictMode>` anywhere in `src/`; `grep -rln "createRoot" src` lists
  exactly `src/react/mount.ts` and `src/react/bridge.ts`.
- Windows checklist passed; PR merged with `gh pr merge <N> --merge`.

## Review-cycle coverage

- Class-identity diff: rendered DOM of the list (rows, badges, empty items, message
  `<p class="message" role="alert">`, notice `<p class="pm-notice" role="status">`)
  and of the New pack dialog body compared node-for-node against the el() tree — same
  classes, same attribute order tolerance, same aria attributes (no new aria/role
  attributes, existing ones kept as they are — AGENTS.md › UI audience); no wrapper element inside `.app-dialog-body`.
- The `say` precedence rule and `loads` counter against pack-list.ts:40-43/:199-245,
  now in `PackListStore`.
- Every `key=` in the row list cannot change while a drag is active; the `<ul>` ref is
  the mounted node, not a re-created one.
- No React-rendered node is moved out of its root's container; the PackList root's
  create (`build`) and unmount (`dispose`) run outside React (contract #1) — no
  `queueMicrotask`, no forwarder.
- The NOT list above (especially: drag module byte-identical, `git diff --stat
  <session base> -- src/pack-manager/view/pack-list-drag.ts` empty, el() twins still
  exported).
- Store discipline: every `PackListStore` command notifies once (contract #4); the
  controller's calls work with no component subscribed.

## Owner / Windows checklist

1. Type in Search: rows hide/show, thumbnails must not flash or refetch, a mid-drag
   filter cancels the drag cleanly; Esc in Search clears it and shows every row.
2. Drag a row by the grip to the first and last position and drop — order persists.
3. Press Esc mid-drag — drag aborts, no ghost left behind.
4. Drop a row, then click it — the release click does not open the pack; the next
   click does.
5. Create a pack typing Title fast — the auto Short Name keeps up with fast typing.
6. Delete a Draft pack and a Live pack — confirm dialogs, folder-removal notice.
7. Rapid PM tab switches during load — only the latest load paints, no stale rows.
8. Open the Pack Manager fresh, then re-point the Library in Settings and open it
   again — no "No packs yet" line or "0 packs" count flashes before the packs appear.

## Risks and fallbacks

- **Drag-node churn** (phase risk 4): React reconciliation must never replace row nodes
  mid-drag — mitigated by per-paint row keys (`paints:id`, constant across filters and drags), `hidden`-attr filtering (no rebuild), and the
  stable `<ul>` ref; review checks every re-render trigger.
- **Interleaving with the drag singletons** (phase risk 4): `clickSuppressed`/
  `disarmRelease`/`activeDrag` are module-level exactly-once state; React state must
  not re-fire pointerdown handlers — single `onPointerDown`, no synthetic re-dispatch.
- **Explicit-paint discipline** (phase risk 1): the list's reload path decides when rows
  rebuild (`paint()`); make sure no derived re-render duplicates or skips it.
- Fallback if S04 overruns: the create-pack dialog subset (step 8) slips to
  S05's step 0 by explicit hand-off — S05 already owns the rest of `dialogs.tsx`,
  and its Preconditions carry the matching contingency line — so sequencing
  survives because the controller does not touch `createPackDialog`. The list
  screen itself (steps 1-7, 9) must land.
