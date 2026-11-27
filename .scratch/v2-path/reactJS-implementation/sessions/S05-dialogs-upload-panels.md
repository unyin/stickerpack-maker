# S05: Dialogs, upload list, emoji leaves, panels (Phase 3)

Corrections to the phase file: (a) upload-list's width fit has no rAF: it is `fit();
void document.fonts.ready.then(fit)` (upload-list.ts:74-76), and it stays in the
orchestrator, not an effect (step 5); the rAF-then-`fonts.ready` pattern is panels.ts's
(:113-114). (b) `packPicker` is not bridged: it stays el() through the whole adoption (step 2).
(c) The bridge is plan.md binding contract #2's, not a detached div. Verified anchors: `save-dialog.ts` is at
`src/editor/view/save-dialog.ts` (`packPicker` import :14, use :102); `initialFocus` is
defined in `src/pack-manager/model/pack-memory.ts:27` and the `"send"` rule is applied at
`dialogs.ts:528`; the renderPanel guard lives in `pack-view.ts:638`, not in panels.ts.

All anchors are at commit `11bacb6` (plan.md › Anchor base); a `file.ts:NN` anchor
cites the file as it stood there, before any rename.

**Renames** (S01's rule: a file that gains JSX becomes `.tsx`): this session
`git mv`s `upload-list.ts` → `upload-list.tsx`, `emoji-field.ts` → `emoji-field.tsx`
and `panels.ts` → `panels.tsx` (the last only if panels lands here; on the S06
hand-off, S06's step 0 renames it), each in the commit that first adds JSX to it.
`dialogs.tsx` was renamed by S04. No importer changes: their imports are extensionless
(`"./emoji-field"` at panels.ts:18 / upload-list.ts:28, `"./upload-list"` at
pack-view.ts:75, `"./panels"` at pack-view.ts:76) and no test imports them. Two files
gain React calls but no JSX, so they stay `.ts` and use `createElement` (S01's
main.ts precedent): `pack-view.ts` (its panel root, step 7 — S06 replaces the file)
and `pack-list-store.ts` (the pack-delete confirm body, step 4).

## Goal

Everything the still-el() pack view can open renders React behind imperative shells:
the confirm and choice dialogs of `dialogs.tsx`, `sendDialog`'s own body nodes,
`upload-list.tsx`, `emoji-field.tsx`, and `panels.tsx` — dialog bodies bridged into
`openDialog`, panels bridged into the pack-view panel slot in place. Every dialog's
mechanics (openDialog, Combobox, initialFocus, pack-memory rules) stay imperative and
untouched, and `packPicker` stays el(). The named cross-view regression — the Editor's
save dialog through `packPicker` — opens and saves. When S05 ends all CSS is
byte-identical and `packPicker`'s exported `PackPicker` shape is unchanged.

## Preconditions

- S04 landed: `src/react/bridge.ts` with `bridgeDialog` and `bridgeInPlace` (S04 step 1,
  binding contract #2) and its dialog-settle unmount proven on create-pack; React twins
  `PreviewImage`, `StatusBadge`, `NewPackFields` beside their still-exported el()
  versions; `PackList` rendered from S04's controller-owned `PackListStore` by an
  in-place root on the list section. Or S04 handed
  off the create-pack dialog subset, which then lands as this session's step 0
  (explicit hand-off, matching S04's fallback).
- Phase 2's decisions: `dialog.ts` (93 LOC) and `combobox.ts` (266 LOC) are imperative
  islands — untouched here (binding contract #2).
- Phase 3 precondition: no parallel el()-based UX work (tickets
  [01](../../issues/01-pack-manager-interactions.md) /
  [02](../../issues/02-editor-tools-and-layers.md)) on these files.
- Compression lever (plan.md, 3.1+3.2): if S04 landed clean (plan.md › Clean
  landing), this session absorbs S04's leftovers, and if it lands clean too Phase 3
  finishes in two sessions — decide at this session's start, not mid-session (S06's
  fallback quotes this lever for budget).

## Files touched

| Path | Status |
|---|---|
| `src/pack-manager/view/dialogs.tsx` (renamed by S04; 531 LOC) | confirm/choice dialogs (:154-354) and `sendDialog` (:466-531) bridged; `packPicker` (:386-458) and `packOption` (:367) untouched (el()); el() `statusBadge`/`reservedLabel`/`newPackFields` kept |
| `src/react/bridge.ts` (from S04) | adds `bridgedConfirm` (step 1) |
| `src/pack-manager/view/pack-list-store.ts` (from S04) | `deletePack`'s confirm moves to `bridgedConfirm`, its two-paragraph body built with `createElement` (stays `.ts`) |
| `src/pack-manager/view/upload-list.tsx` (renamed from `upload-list.ts`, 217 LOC) | dialog content becomes one React component; orchestrator keeps focus/scroll/fit |
| `src/pack-manager/view/emoji-field.tsx` (renamed from `emoji-field.ts`, 86 LOC) | `measureEmojiGlyph` kept verbatim; `bindEmojiSave`/`copyButton` gain React forms |
| `src/pack-manager/view/panels.tsx` (renamed from `panels.ts`, 234 LOC) | near-mechanical JSX conversion |
| `src/pack-manager/view/pack-view.ts` | NOT converted, stays `.ts` (`createElement`, no JSX) — `buildPackView` creates the panel root with `bridgeInPlace(panel, …)` on the `aside.pm-panel` it builds (:152), `renderPanel` (:589-595) renders into that root, and `destroy` (:679-685) unmounts it |

## Work plan

1. **Dialog bodies via the bridge; orchestrators stay plain async functions.**
   `openDialog` (dialog.ts) is untouched. Each orchestrator keeps its shape: open with
   an empty body, `bridgeDialog(handle, <Body …/>)` (S04 step 1's API; mechanism and
   unmount-on-settle per plan.md contract #2), then its existing
   post-open lines. Because the handle exists before the body renders, a body that
   needs it receives it (or a callback) as a prop. `confirmChoice` (dialog.ts:81-88)
   returns no handle, so `bridge.ts` gains `bridgedConfirm(title, body, spec)`:
   exactly confirmChoice's call, `openDialog(title, [], confirmButtons(spec),
   SAFE_CHOICE, { defaultChoice: SAFE_CHOICE })` (imports from
   `src/shared/dialog-model`, untouched), plus `bridgeDialog`, resolving
   `chosen === "action"`. **Discard points** in this session: dialog settle (inside
   `bridgeDialog`), and pack-view's `destroy()` for the panel root (step 7). The
   `dialogOpen()` guard (dialog.ts:91) keeps protecting the pack view's keydown/drop.
2. **`packPicker` stays el()** (dialogs.ts:386-458): save-dialog.ts:102 (`const picker
   = packPicker({ message, onChange: () => sync() })`) owns its dialog and has no settle
   point at which a bridge root could be unmounted, so the picker is not bridged; it and
   its el() helpers stay el() through the whole adoption (S11 puts the pack picker out
   of scope), their port a named post-adoption follow-up that S12 records. It keeps the el() `newPackFields`
   (:417/:435/:437) and el() `statusBadge` in `packOption` (:373), which S04 left
   exported for exactly this. The exported `PackPicker` interface (dialogs.ts:356) and
   `defaultPackId`/`initialFocus`/`packMemory` (pack-memory.ts:27/:41) are untouched;
   `git diff <session base> -- src/pack-manager/view/dialogs.tsx` shows no hunk in
   the `packPicker` block (:356-458 at `11bacb6`; locate it by symbol).
3. **`sendDialog`** (dialogs.ts:466-531): the body is five nodes in `.app-dialog-body`:
   the picker's two el() `elements`, then the Move label (`.pm-check`), the hint
   (`.muted.pm-hint`), and the message `div.message`. Order of the orchestrator:
   `openDialog(title, [], …)`; `bridgeDialog` renders the last three as a fragment —
   the message `<div className="message" role="alert" ref={…}/>` is rendered with no
   React children, so React owns none and `packPicker` and `send()`'s
   `message.replaceChildren(...)` / `textContent` writes (:496-503) stay verbatim; then
   build `packPicker({ message, excludeId, onChange })` with that element and
   `body.prepend(...picker.elements)` — React's fragment never inserts at container
   level after the first commit, so the leading el() siblings are never disturbed.
   Then verbatim: Send disabled until a pack is chosen with the reason in `title`
   (:482-483), the inline New-pack flow disabling and re-enabling its button
   (:410-411, restored at :427-428 after `choose(pack)` — inside the el() picker), and
   the initial focus rule (:528: `if (initialFocus("send", picker.selected() !== null)
   === "submit") handle.buttons.get("send")?.focus(); else picker.focus()`). The Move
   checkbox's `checked` is read through a ref at send time.
4. **Confirm and choice dialogs** — bodies as JSX, node-for-node today's:
   - `confirmStickerDelete` (:173, `stickerCard` :154-170), `confirmGoLive` (:192),
     `confirmRevertToDraft` (:197), `confirmThumbnailDelete` (:340-354),
     `invalidFileDialog` (:227-236, `<strong>` file name) and the pack-delete confirm
     in `PackListStore.deletePack` (pack-list-store.ts; body via `createElement`, the
     two paragraphs of pack-list.ts:89-90) → `bridgedConfirm`; previews via `PreviewImage`.
   - `editChoiceDialog` (:209-224) and `thumbnailSourceDialog` (:247-272): two static
     paragraphs each via `bridgeDialog`; thumbnailSourceDialog's disable of the
     `sticker` button through `handle.buttons` (:262-270) stays verbatim (the buttons
     are dialog.ts's, not React's).
   - `stickerChoiceDialog` (:307-337): the body gets the handle as a prop; each
     `choiceCard` (:289-299) renders `className="pm-confirm-card missing"`,
     `aria-disabled="true"` and its `title` for a Missing sticker, else an `onClick`
     that sets the orchestrator's `chosen` and calls `handle.close("pick")` — the class
     /aria-disabled/click surgery of :316-329 as JSX.
5. **`upload-list.tsx`**: one React component for the body (notes, the `.ul-error` line,
   the `ol.ul-list` rows of `.ul-*` classes). The orchestrator opens
   `openDialog("Upload list", [], …)`, adds `ul-dialog` (:65), bridges the body, and
   only then — the body exists — runs today's lines verbatim: first
   `.ul-open:not(:disabled)` focused with `preventScroll` (:67-68), `list.scrollTop = 0`
   (:69), and `fit(); void document.fonts.ready.then(fit)` with `fitWidth(handle.dialog,
   list)` (:74-76, `fitWidth` :206). These are not React effects.
   - `makeDragHandle` (:178-198) stays imperative: a ref on the React-rendered
     `span.ul-prev.draggable` cell calls `makeDragHandle(cell, start)` once — it
     attaches to that existing element, no added host node (OS drag-out to
     Explorer/Telegram).
   - save-error restore: `lastStored` (:116-128 — stored on success, `input.value =
     lastStored` on failure) becomes component state.
6. **`emoji-field.tsx`**: `measureEmojiGlyph(fontSize, fontFamily)` (:24) kept verbatim
   (its result feeds the panel box width). `bindEmojiSave`'s semantics (:37-45 — save
   on the native `change` event, Enter `preventDefault` + blur) become a hook; React's
   `onChange` fires per keystroke, so the hook listens to the native `change` event via
   ref + effect. `copyButton`/`copyFlash` (:48-86): a React `CopyButton` + `sr-only`
   status; the 1200 ms restore timer (:57-62) lives in a ref, a second click
   `clearTimeout`s it and restarts (:51 — never "Copied" stuck), and unmount clears it.
   The el() `bindEmojiSave`/`copyButton` are deleted here only if `panels.tsx` lands
   in this session: their consumers are panels.ts (:18 imports both) and
   upload-list.tsx. If panels slips to S06 (fallback below), they stay exported
   and S06's step 0 deletes them with the panels port — deleting them here would
   break the build.
7. **`panels.tsx`** + **panel mounting**: near-mechanical JSX — it is already pure
   `(state, actions)` shapes. The emoji box keeps `fit()` on rAF + `document.fonts.ready`
   (:113-114) and the grow-not-scroll `fitHeight` (:93-111); `EMOJI_BOX_GLYPH_WIDTHS =
   5.5` (:22) and the fallback-width math (:228-233) untouched. Mounting is contract #2's
   non-dialog bridge: `bridgeInPlace` on pack-view's real `aside.pm-panel` element
   (pack-view.ts:152) in place, one root for the view's lifetime: `buildPackView`
   creates it right after building the `aside` (:152) — `const panelRoot =
   bridgeInPlace(panel, createElement(EmptyPanel, { reorder: false }))` (`emptyPanel`'s React form,
   panels.ts:53) — so the root exists before anything renders into it; the first
   `render()` (:650, still inside `buildPackView`) then replaces it with the chosen
   panel through `renderPanel`. `renderPanel`
   (:589-595) renders the chosen panel (`createElement`) into that root inside `flushSync` (renderPanel
   never runs inside a React render/commit while pack-view is el()), keyed on a counter
   bumped per call so each call rebuilds the panel as today's `replaceChildren` does.
   The discard point is pack-view's `destroy()` (:679-685), which unmounts the root.
   The existing renderPanel guard (:638: `if (!panel.contains(document.activeElement)
   || !editing) renderPanel()`) keeps protecting the bridged textarea — do not weaken
   it; S06 replaces it by construction (stable keys).
8. **Land per plan.md › Session protocol**, with this session's byte-identity checks:
   `git diff --stat <session base> -- src/dialog.ts src/combobox.ts src/editor` empty,
   `git diff <session base> -- src/pack-manager/view/dialogs.tsx` with no hunk in the
   `packPicker` block, and the checklist below.

## Deliberately out of scope

- Converting pack-view's own markup (S06 — the header/toolbar/grid/panel chrome) and
  pack-view's own `showRejected` dialog (:553, S06).
- `packPicker` and its el() helpers (el() through the whole adoption; post-adoption follow-up, S12 records it; save-dialog.ts:102 consumes them).
- Touching `dialog.ts` or `combobox.ts` internals (binding contract #2).
- Altering `initialFocus`/`defaultPackId`/`packMemory` rules (pack-memory.ts,
  verbatim).
- Any CSS/class change; any `model/` change (`messages.ts`, `names.ts`,
  `pack-memory.ts` untouched); the Editor (only its save dialog gets *tested*, not
  edited).
- No `<StrictMode>` anywhere in `src/` (binding contract #3).
- No new aria/role attributes, existing ones kept as they are (AGENTS.md › UI audience).

## Exit criteria

- `bun run build` and `bun test` pass; `git diff --stat <session base>` over the code
  pathspec (plan.md › Session protocol) lists nothing under `src/pack-manager/model/`,
  `src/editor/`, `src/shared/`, `src/dialog.ts`, `src/combobox.ts` or any `*.css`.
- **The Editor's save dialog opens and saves** (the named cross-view regression):
  `packPicker` unchanged; save into an existing pack and as a new pack both work.
- upload-list: first `.ul-open:not(:disabled)` focused with `preventScroll`; list
  `scrollTop = 0`; width fit re-runs after the custom emoji font loads; a save error
  restores `lastStored` into the box.
- Emoji copy flash: shows tone-success/tone-danger and restores after 1200 ms; a second
  click restarts the timer; the timer is cleared on unmount (no late setState).
- sendDialog: body nodes in today's order; Send disabled until a pack is chosen with
  the reason in `title`; the inline New pack flow re-enables the button after "Create
  and select"; `initialFocus("send", ...)` rule preserved (submit focused only when a
  pack was preselected).
- stickerChoiceDialog: a Missing card cannot be picked; a picked card closes the
  dialog with that sticker.
- Every bridge root has its discard point: dialog settle, and the panel root in
  pack-view's `destroy()`.
- Grep: no `<StrictMode>` anywhere in `src/`.
- Windows checklist passed; PR merged with `gh pr merge <N> --merge`.

## Review-cycle coverage

- Every `bridgeDialog`/`bridgedConfirm` call opens with an empty body; no leaked roots
  after cancel or error paths; the panel root unmounts in `destroy()`.
- No React-rendered node moved out of its container; no component writes DOM React
  owns (sendDialog's message div has no React children).
- Focus rules inside dialogs: React re-renders must never steal focus from the
  combobox input or the emoji box while the dialog is open (renderPanel guard still
  consulted at pack-view.ts:638).
- Cleanups: copyFlash timers, the panels' rAF id and `fonts.ready` fit callbacks —
  no setState-after-unmount paths.
- Class-identity diff of every dialog body and panel against the el() tree (`.ul-*`,
  `.pm-check`, `.pm-confirm-card`, badge classes), no wrapper element in
  `.app-dialog-body`.
- The NOT list (packPicker untouched, combobox/dialog internals, pack-memory rules).

## Owner / Windows checklist

1. Open Upload… — width fits ten emoji per row with the custom emoji font loaded; the
   first enabled open-button is focused.
2. Edit an emoji box: Enter ends editing, spaces stripped on save; break a save (e.g.
   an unreadable file) and watch the box restore its previous value.
3. Copy an emoji String — flash tone shows, restores after ~1.2 s; click twice quickly
   — it still restores ~1.2 s after the second click.
4. Drag a preview out to Explorer/Telegram (OS drag, threshold respected).
5. Send to pack: combobox filter, inline New pack…, Move checkbox, initial focus on
   the pack field (not Send) when nothing is preselected.
6. Sticker and thumbnail delete confirms show with their previews; Go Live / Revert to
   Draft confirms; Edit sticker's three-way choice.
7. Thumbnail Create/Replace → "From a copy of a sticker…": a Missing card is not
   pickable, a picked card opens the Editor's Thumbnail mode.
8. The Editor's save dialog: open from a sticker save, pick a pack through the
   picker, save — then do it again with "New pack".

## Risks and fallbacks

- **Fonts-ready/rAF timing**: the width fits measure live layout — keep the exact
  orderings as today: `fit()` then `fonts.ready` in upload-list.ts:74-76 (in the
  orchestrator, after the bridge render), rAF then `fonts.ready` in panels.ts:113-114.
  The two patterns differ; do not unify them.
- **Focus fights between React bodies and imperative dialogs** (phase risk 2): the
  combobox owns focus inside the picker; the renderPanel guard and dialog-settle
  unmount are the two mechanisms; review each dialog's onChange/sync path.
- **Timer cleanup on dialog cancel** (phase risk 3's local variant): a cancel closes
  the dialog before `copyFlash`'s timer fires — the unmount cleanup makes that a no-op.
- Fallback if S05 overruns: `panels.ts` (renamed `.tsx` by S06's step 0; the most mechanical, self-contained file) slips
  to S06's step 0 by explicit hand-off — S06's Preconditions carry the matching
  contingency line and its work plan step 0 names the landing — and S06 rebuilds
  the panel mount point anyway, so sequencing survives; dialogs + upload-list +
  the Editor save-dialog regression must land here.
