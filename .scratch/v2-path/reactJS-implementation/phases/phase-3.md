# Phase 3: Pack Manager (3 sessions — S04–S06)

Drafted by planning subagent; figures verified with wc/grep at HEAD (pack-view.ts 686,
render() def :597 + 10 call sites; dialogs.ts 531; pack-list.ts 253; panels.ts 234;
upload-list.ts 217; emoji-field.ts 86; previews.ts 72; pack-list-drag.ts 163;
reorder-drag.ts 91; views/pack-manager.ts 184 — 2,517 view LOC total; the analysis's
2,333 was a counting-method difference, not a scope change). Main-session spot-checks
confirmed render() :597 and the drain :644–646 (inside `reread()` :643–648).
Session plans: [../sessions/S04-pack-list.md](../sessions/S04-pack-list.md),
[../sessions/S05-dialogs-upload-panels.md](../sessions/S05-dialogs-upload-panels.md),
[../sessions/S06-pack-view-controller.md](../sessions/S06-pack-view-controller.md)

## Goal and definition of done

The whole Pack Manager emits React 19 while every one of the five CSS files stays
byte-identical and every emitted class name matches today's. The singleton cache in
`views/pack-manager.ts` becomes a headless module-level controller plus a `mountView()`
React root; pack-view's closure state becomes a `PackViewStore` external store (same
`subscribe()` shape as EditorSession) consumed via `useSyncExternalStore`; both drag
systems stay vanilla behind refs. Done when:

- `bun run build` + `bun test` pass, `git diff` empty under `src/pack-manager/model/`,
  `src/editor/`, `src/shared/` and all `*.css`.
- The Editor's drain contract is exact: `editor.ts:1539` (`markStickerFileChanged`) and
  `:1501` (`markThumbnailChanged`) flow into pack-view's `reread()` (:643–648: drain
  *before* `loadPackView`, per-id `previews.forget`, thumbnail only when
  `takeChangedThumbnails().includes(packId)`) — ported verbatim, never called from a
  second site.
- The Editor's save dialog still works: save-dialog.ts:14 imports `packPicker` — that
  export keeps its `PackPicker` shape (returns `elements: HTMLElement[]`) through the whole adoption
  (it stays el() through Phase 3: save-dialog.ts:102 owns its dialog and has no settle
  point to unmount a bridge root; binding contract #2 of the master plan).
- `setPackManagerListener` / `packManagerState` / `revealStickerOnShow` /
  `revealThumbnailOnShow` / `showPackList` keep their exported contracts (shell.ts is
  the only external caller — verified).
- One Windows check per converted surface, each preceded by a converged review-cycle;
  grid scroll position + open-pack identity survive tab switches.

## Preconditions

1. Phase 1 (deps, plugin, jsx, mountView) and Phase 2 (shell converted; dialog/combobox
   decisions recorded as binding contracts) landed.
2. Library re-point invalidation reaches `forgetPackManager()` (shell.ts:88 alongside
   `resetPackMemory()`/`forgetEditorOrigin()`).
3. No parallel el()-based UX work (tickets 01/02) on these files — the sequencing swing
   factor.

## The drag decision: ref-wrap, not state-driven (both systems)

Keep `pack-list-drag.ts` and `reorder-drag.ts` byte-identical, wired from JSX via
`onPointerDown={(e) => startRowDrag(e.nativeEvent, ...)}`. Reasons, from the code:
- Both are pointer-capture state machines with body-level ghosts and per-pointermove
  class surgery on nodes re-queried from the grid each move; a state-driven redesign
  would re-render the whole grid at pointer frequency for zero visual gain.
- `pack-list-drag.ts` deliberately uses module-level singletons (`clickSuppressed`,
  `disarmRelease`, `activeDrag`, :50/:62/:93) so exactly one drag exists app-wide and
  a drag's ending click is suppressed across the row's own handler
  (`rowClickSuppressed()`, consumed at pack-list.ts:178). React-state porting adds
  interleaving risk with React's event delegation for no payoff.
- Both hosts are narrow interfaces (`RowDragHost` 2 members — list, drop;
  `ReorderDragHost` 4 members); in React the host object is rebuilt into a ref each render so
  `enabled()`/`indexOf()`/`drop()` always read the latest store state. The pure rules
  (`rowSlotAt`, `slotAt`, `dropPosition` in `model/modes.ts`) are untouched.

## S04 (3.1) — Pack list screen (~700 LOC touched)

**Files**: pack-list.ts (253), pack-list-drag.ts (wiring only), previews.ts (72), the
dialogs subset `newPackFields`/`createPackDialog`/`statusBadge`/`reservedLabel`
(dialogs.ts ~:37-152: statusBadge :37, reservedLabel :50, newPackFields :60,
createPackDialog :113-152), a surgical slice of `views/pack-manager.ts`, plus the bridge
helper of binding contract #2 (dialog bodies: empty `openDialog` body, root on
`.app-dialog-body`, `flushSync`; in-view: root on the real host element in place).
el() helpers with remaining el() consumers keep their el() versions beside the React
twins (S04's session file names who deletes each).

**Builds**: a controller-owned `PackListStore` (`useSyncExternalStore`) holding the
list state (packs, search, message/loadFailed, notice, per-row previews) with
`reload()/showError()/clearMessage()` as store commands the not-yet-redesigned
controller keeps calling, and a React `PackList` rendering from it (no component
state for anything the owner sees, so S06 lifts nothing); rows as JSX keyed per paint (`${paints}:${id}`, as in S04); the `loads` counter and message-precedence
rule (`say(text, fromLoad)`) ported verbatim; `Previews` kept verbatim,
`previewImage` becomes a `PreviewImage` component (`src` from the cached promise —
read synchronously at render once settled, so a remount never paints blank tiles;
`unreadable` class on null).

**NOT**: touch openPack/showSticker/pendingReveal in the controller; convert the drag
module; delete el() `statusBadge`/`previewImage`/`newPackFields` (the React row uses
plain-JSX twins; the el() pack header and `packPicker` keep the el() versions); any
CSS/class changes.

**Exit criteria**: build/tests green, CSS diff empty; the `<ul class="pm-pack-list">`
node never remounts (the subgrid ghost reads `getComputedStyle(list).
gridTemplateColumns` off that exact node); filtering sets `hidden` without rebuilding
rows (typing in Search fires zero new preview fetches); `cancelRowDrag()` still runs
when the filter narrows and on `paint()`; create-pack's `suggestShortName` race guard
(request counter) survives fast typing; drag-end click suppression intact.

## S05 (3.2) — Dialogs, upload list, emoji leaves, panels (~1,050 LOC touched)

**Files**: the rest of dialogs.ts (~400 LOC), upload-list.ts (217), emoji-field.ts (86),
panels.ts (234).

**Builds**: dialog bodies as React via the bridge (the async orchestrators stay plain
async functions — their natural shape). upload-list.ts: one component for the dialog
content; `makeDragHandle` stays imperative, attached via ref to the rendered cell;
`fitWidth` stays in the orchestrator after the bridge render (`fit()` then
`document.fonts.ready`, no rAF), same measured-from-live-layout math. emoji-field.ts:
`measureEmojiGlyph` kept verbatim; `bindEmojiSave` semantics become component/hook;
`copyFlash`'s 1200 ms timer becomes state + effect cleanup. panels.ts: near-mechanical
JSX (pure `(state, actions)` already); the emoji box keeps `fit()` on rAF +
fonts.ready and grow-not-scroll `fitHeight`; `EMOJI_BOX_GLYPH_WIDTHS` untouched.
Panels mount into the still-el() pack view through an in-place root on the panel slot;
the existing renderPanel guard keeps protecting the bridged textarea.

**NOT**: convert pack-view's own markup; convert `packPicker` or change its exported
shape (save-dialog.ts:102 consumes it — it stays el() through the whole adoption; its port is a post-adoption follow-up); touch
Combobox internals; alter `initialFocus`/`defaultPackId` rules (pack-memory.ts,
verbatim).

**Exit criteria**: build/tests green, CSS diff empty; **Editor save dialog opens and
saves** (the named cross-view regression); upload-list: first `.ul-open:not(:disabled)`
focused with `preventScroll`, list `scrollTop = 0`, width fit re-runs after fonts load,
save-error restores `lastStored`, copy flash shows tone-success/tone-danger and restores
after 1200 ms; sendDialog: Send disabled until a pack is chosen with the reason in
`title`, inline New pack flow re-enables the button, `initialFocus("send", ...)` rule
preserved.

## S06 (3.3) — Pack view + controller (~900 LOC touched)

**Files**: pack-view.ts (686), views/pack-manager.ts (184), reorder-drag.ts (wiring
only), removal of the in-view bridges (PackList, panels — plain JSX children once the
pack view is React); the dialog bridges stay (contract #2), and `packPicker` stays el()
through the whole adoption (post-adoption follow-up, recorded by S12).

**Builds**:
- **`PackViewStore`**: external store holding `{view, mode, selection, busy, notice,
  rejected, message}` with `subscribe()`/`getSnapshot()`, mirroring the EditorSession
  pattern. Every direct DOM write in today's closure is audited into a store field or
  a derived render (42 lines: 28 of the four core write patterns —
  textContent/classList/disabled/title — plus 14 replaceChildren/setAttribute/.value/
  .hidden sites; S06's step 1 gives the greps; the audit list is a review-cycle
  artifact). Action bodies port verbatim: `run()`'s busy-gate,
  `setView`/`pruneSelection`, `importPaths`, `persistEmoji`, `reread()`'s drain,
  `reveal()`'s REVEAL_BUSY/REVEAL_GONE paths, the drop-event and document-keydown
  effects with their cleanups.
- **React PackView tree**: header (Title/Short as uncontrolled inputs + an
  every-commit focused-guard sync effect, plus the commit handler's unconditional
  revert to the stored value — S06 step 4), toolbar (disabled/title/tone-class derivations), notices
  (single-banner rule), grid (stable `<ol>` node, tiles keyed by sticker id, thumbnail
  slot last), panel keyed by `panelFor(selection)` + selected id — stable keys replace
  the `document.activeElement` panel guard by construction.
- **Reveal scroll**: `render(); tile?.scrollIntoView({block:"nearest"})` becomes a
  one-shot pending reveal (`{ id }` in the store, cleared once consumed) applied by a
  `useLayoutEffect` after the grid `scrollTop` restore, querying the same selectors —
  commit-before-paint. (Revised from a `revealSeq`-keyed effect, which would scroll
  again after a tab-switch remount; S06 step 5 holds the detail.)
- **Controller**: the singleton survives headless — `opening` race counter, `disposed`,
  `pendingReveal`, the handle-guard and publish-on-change contract verbatim; the Pack
  Manager becomes one React view that S02's `mountScreen` (src/shell.tsx) mounts with
  `mountView()`, then runs the controller's `shown()` from the navigation handler,
  outside React (never a mount effect); list ↔ pack switching is store state inside
  that view, never a `mountView()` swap (S06 step 6); `Previews` ownership moves to the store so
  blob URLs survive root unmounts exactly as long as today; grid `scrollTop` saved on
  unmount and restored in a layout effect (four lines; without it mountView's
  unmount-on-switch regresses today's cached-DOM scroll preservation).

**NOT**: adopt StrictMode (double-invoked effects would double-drain
`takeChangedStickers` — binding contract #3); touch the Editor, the drag modules'
code, or any model file.

**Recorded decision (S07-style asymmetry):** S06 stays atomic rather than splitting
store-extraction out the way Phase 4's S07 does. Reasons: pack-view has no imperative
islands (no Konva, no gesture state; its drag modules are ref-wrapped), and its
write-site surface is ~44 versus the editor's 24 closure vars plus race guards — the
split buys much less here, and S04's `PackListStore` leaves the list side only a root
to drop. Named overrun fallback, decided once at the end of S06's step 1 (the
write-site audit): if the audit finds more than 6 write sites beyond the counted 42,
or the store + tree port is judged too large for one session, split into a
store-extraction-only session followed by the tree/controller swap, consuming the
phase's S04+S05 compression discount first.

**Exit criteria**: build/tests green, CSS diff empty; no in-view bridge left
(`bridgeInPlace` gone, grep-verifiable; dialog bridges remain); focus preserved while
typing Title / Short Name through
a background `reload()`; focus + half-typed Emoji String preserved through a
`persistEmoji` render; drain exact (edit a sticker in the Editor → save → saved-note
link → preview shows the new image once, no stale blob); reveal selects and scrolls;
busy-gating (double-click Add runs one import); tab-switch-and-back keeps the open
pack, its scroll, and re-reads without a Missing scan (`reload()`, not `openPack()`,
SPEC §4); pack-list state (search text, filtered rows, loaded packs, notice) survives
tab-switch-and-back and open-pack-and-back, as today's cached-DOM re-attach does
(views/pack-manager.ts:110,141,159), from S04's `PackListStore`; the message lines
still start clear on each show; the open pack's `.pm-panel` scroll survives a tab
switch; Settings re-point disposes everything (controller `dispose()` →
`publish(NO_PACK_MANAGER)`).

## Risks

1. **`render()`'s explicit-call discipline vs derived re-renders**: today 10 call
   sites decide when the DOM updates, and several writes bypass `render()`. Missing
   one shows stale chrome. Mitigation: the write-site audit list checked off during
   review-cycle.
2. **Focus preservation is this phase's signature failure mode**: three guards map to
   three distinct mechanisms (uncontrolled+focused-guard effect, stable keys +
   component-local draft, local state). Mitigation: the two named owner tests per
   session; a review finding on any `key=` that can change while an input inside is
   focused.
3. **Async races across unmount** (today nothing unmounts mid-action): an `openPack`
   in flight at tab-switch must hit the `disposed || mine !== opening` path and destroy
   its handle. Owner test: switch tabs immediately after clicking a pack.
4. **Drag-node churn**: keep the `cancelRowDrag()` calls at the same logical points;
   stable `<ol>`/`<ul>` identity; grid/list reach the host via refs.
5. **Cross-phase breakage**: the Editor's save dialog and the shell's listener are the
   two outside consumers; contracts frozen as preconditions; the save-dialog flow is an
   explicit owner test in S05 and re-checked in S06's delta review.

## Owner-test / Windows-check touchpoints

(review-cycle converges on each session's delta before any ask)

- **After S04**: type in Search (rows hide/show, thumbnails must not flash, drag
  cancels if filtering mid-drag); drag a row by the grip to first/last and drop; Esc
  mid-drag; drop a row, then click it (the release click is suppressed, the next
  click opens the pack); create a pack typing Title fast (auto Short Name keeps up); delete a Draft
  and a Live pack; rapid PM tab switches during load.
- **After S05**: open Upload… — width fits ten emoji per row with the custom emoji
  font, first enabled open-button focused; edit an emoji box (Enter ends, spaces
  stripped on save), break a save and watch the box restore, copy → flash → restore
  after ~1.2 s; drag a preview out to Explorer/Telegram (OS drag, threshold
  respected); Send to pack: combobox filter, inline New pack…, Move checkbox, initial
  focus on the pack field; sticker/thumbnail delete confirms with previews; the
  Editor's save dialog (the el() packPicker).
- **After S06**: the three focus tests (type in Title while Refresh lands; type an
  Emoji String and save it; panel never rebuilds under the cursor); reorder mode:
  ghost follows cursor, drop markers, Esc, "Moved sticker #x to #y" notice; reveal
  from the Editor's saved-note link (opens the pack if closed, selects, scrolls,
  leaves Reorder); **the drain**: edit a pack sticker in the Editor, save, follow the
  link — the tile shows the new image; thumbnail variant; double-click Add images
  (one import); reveal while busy; tab away and back (open pack + scroll preserved);
  Settings → re-point → PM fully forgotten.

**Why 3 sessions, not 2**: every session must ship an owner-reachable slice (one
Windows check per converted view + review before owner tests). The reachability
boundaries are exactly: list screen (S04), everything the el() pack view can already
open (S05), the atomic pack-view/controller swap (S06 — `buildPackView` cannot land
half-converted). If S04 and S05 both converge in one review round, S05 can absorb
S04's leftovers and the phase finishes in 2 — plan for 3, take the discount if it
appears.
