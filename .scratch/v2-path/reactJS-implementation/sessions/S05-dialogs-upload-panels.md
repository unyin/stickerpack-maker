# S05: Dialogs, upload list, emoji leaves, panels (Phase 3)

Corrections to the phase file: none material. Verified anchors: `save-dialog.ts` is at
`src/editor/view/save-dialog.ts` (`packPicker` import :14, use :102); `initialFocus` is
defined in `src/pack-manager/model/pack-memory.ts:27` and the `"send"` rule is applied at
`dialogs.ts:528`; the renderPanel guard lives in `pack-view.ts:638`, not in panels.ts.

## Goal

Everything the still-el() pack view can open is React behind imperative shells: the
remaining ~400 LOC of `dialogs.ts` (confirm previews, `packPicker` internals,
`sendDialog`), `upload-list.ts`, `emoji-field.ts`, and `panels.ts` all render React —
bodies bridged into `openDialog`, panels bridged into the pack-view panel slot. Every
dialog's mechanics (openDialog, Combobox, initialFocus, pack-memory rules) stay
imperative and untouched. The named cross-view regression — the Editor's save dialog via
the bridged `packPicker` — opens and saves. When S05 ends all CSS is byte-identical and
`packPicker`'s exported `PackPicker` shape is unchanged.

## Preconditions

- S04 landed: bridge helper (`src/react/bridge.ts`) exists and its dialog-settle
  unmount pattern is proven; create-pack dialog subset converted.
- Phase 2's decisions: `dialog.ts` (93 LOC) and `combobox.ts` (266 LOC) are imperative
  islands — untouched here (binding contract #2).
- Phase 3 precondition: no parallel el()-based UX work (tickets 01/02) on these files.

## Files touched

| Path | Status |
|---|---|
| `src/pack-manager/view/dialogs.ts` (531 LOC) | remaining ~400 LOC after S04's subset: `packPicker` (:386-459), `sendDialog` (:466-531), confirm/delete dialogs and their previews |
| `src/pack-manager/view/upload-list.ts` (217 LOC) | dialog content becomes one React component |
| `src/pack-manager/view/emoji-field.ts` (86 LOC) | `measureEmojiGlyph` kept verbatim; `bindEmojiSave`/`copyFlash` become component/hook |
| `src/pack-manager/view/panels.ts` (234 LOC) | near-mechanical JSX conversion |
| `src/views/pack-manager.ts` / `src/pack-manager/view/pack-view.ts` | NOT converted — only the bridge mount points they already call through |

## Work plan

1. **Dialog bodies as React via the bridge; orchestrators stay plain async functions.**
   `openDialog` (dialog.ts) is untouched. Each dialog's async function keeps its natural
   shape: build a React body, `bridge()` it, pass the element as the body node, and call
   the bridge's `unmount()` when the handle's result settles. The `dialogOpen()` guard
   (dialog.ts:91) keeps protecting the pack view's keydown/drop.
2. **`packPicker` internals** (dialogs.ts:386): the combobox row + inline New-pack area
   render React through the bridge, but the exported `PackPicker` interface
   (dialogs.ts:356 — `elements: HTMLElement[]`, `selected()`, `load()`, `focus()`) is
   preserved exactly: the bridged element goes into `elements[0]`/`[1]`. The Combobox
   itself stays imperative (island). `save-dialog.ts:102`
   (`const picker = packPicker({ message, onChange: () => sync() })`) must keep working
   with zero edits — that is the phase's named cross-view regression.
   `defaultPackId`/`initialFocus`/`packMemory` rules (pack-memory.ts:27/:41) are used
   verbatim, not reimplemented.
3. **`sendDialog`** (dialogs.ts:466-531): port verbatim — Send disabled until a pack is
   chosen with the reason in `title` (:482-483: `send.disabled = picker.selected() ===
   null; send.title = "Choose a pack to send to"`), the inline New-pack flow disabling
   and re-enabling the button (:412-420: `newPackButton.disabled = true` +
   `title = "Create the pack below first"`, restored after `choose(pack)`), and the
   initial focus rule (:528: `if (initialFocus("send", picker.selected() !== null) ===
   "submit") handle.buttons.get("send")?.focus(); else picker.focus()`). The
   "Delete originals after sending" Move checkbox stays.
4. **`upload-list.ts`**: one React component for the dialog content (rows of
   `.ul-*` classes). Port exactly:
   - first `.ul-open:not(:disabled)` focused with `preventScroll` (:67-68) and
     `list.scrollTop = 0` (:69);
   - width fit as an effect: rAF then `document.fonts.ready.then(fit)` re-running
     `fitWidth(handle.dialog, list)` (:74-76) — same measured-from-live-layout math
     (`fitWidth` at :206);
   - `makeDragHandle` stays imperative via ref (OS drag-out to Explorer/Telegram);
   - save-error restore: `lastStored` (:116-125 — stored on success, `input.value =
     lastStored` on failure) becomes component state.
5. **`emoji-field.ts`**: `measureEmojiGlyph(fontSize, fontFamily)` (:24) kept verbatim
   (its result feeds the panel box width). `bindEmojiSave`'s semantics (:37 — save on
   change/blur, Enter ends editing) become a component/hook. `copyFlash` (:48): the
   1200 ms restore timer (:62) becomes state + effect cleanup so unmount cancels it.
6. **`panels.ts`**: near-mechanical JSX — it is already pure `(state, actions)` shapes.
   The emoji box keeps `fit()` on rAF + `document.fonts.ready` and the grow-not-scroll
   `fitHeight` (:93-111); `EMOJI_BOX_GLYPH_WIDTHS = 5.5` (:22) and the
   fallback-width math (:228-233) untouched.
7. **Panel mounting**: panels mount into the still-el() pack view through the bridge;
   the existing renderPanel guard (pack-view.ts:638: `if (!panel.contains(
   document.activeElement) || !editing) renderPanel()`) keeps protecting the bridged
   textarea — do not weaken it, S06 replaces it by construction (stable keys).
8. Run `bun run build` + `bun test`; review-cycle to convergence before any owner test.

## Deliberately out of scope

- Converting pack-view's own markup (S06 — the header/toolbar/grid/panel chrome).
- Changing `packPicker`'s exported shape (save-dialog.ts:102 consumes it — the bridge
  serves the Editor until Phase 4).
- Touching `dialog.ts` or `combobox.ts` internals (binding contract #2).
- Altering `initialFocus`/`defaultPackId`/`packMemory` rules (pack-memory.ts,
  verbatim).
- Any CSS/class change; any `model/` change (`messages.ts`, `names.ts`,
  `pack-memory.ts` untouched); the Editor (only its save dialog gets *tested*, not
  edited).
- No `<StrictMode>` (binding contract #3).

## Exit criteria

- `bun run build` and `bun test` pass; `git diff` empty under `src/pack-manager/model/`,
  `src/editor/`, `src/shared/`, `src/dialog.ts`, `src/combobox.ts` and every `*.css`.
- **The Editor's save dialog opens and saves** (the named cross-view regression):
  `packPicker` returns live HTMLElements through the bridge; save into an existing pack
  and as a new pack both work.
- upload-list: first `.ul-open:not(:disabled)` focused with `preventScroll`; list
  `scrollTop = 0`; width fit re-runs after the custom emoji font loads; a save error
  restores `lastStored` into the box.
- Emoji copy flash: shows tone-success/tone-danger and restores after 1200 ms; the timer
  is cleaned up on unmount (no late setState).
- sendDialog: Send disabled until a pack is chosen with the reason in `title`; the
  inline New pack flow re-enables the button after "Create and select";
  `initialFocus("send", ...)` rule preserved (submit focused only when a pack was
  preselected).
- Grep: no `StrictMode` import in `src/`; `git diff` on `src/dialog.ts` and
  `src/combobox.ts` empty.

## Review-cycle coverage

- Every `bridge()` call site: unmount wired to the dialog result's settle path
  (`handle.result` then/catch), no leaked roots after cancel or error paths.
- Focus rules inside dialogs: React re-renders must never steal focus from the
  combobox input or the emoji box while the dialog is open (renderPanel guard still
  consulted at pack-view.ts:638).
- `copyFlash`/`fitWidth`/`fit` effect cleanups: rAF ids and timers cancelled, no
  setState-after-unmount paths.
- Class-identity diff of every dialog body and panel against the el() tree (`.ul-*`,
  `.pm-check`, `.pm-new-pack`, `.pack-combo-row`, badge classes).
- The NOT list (packPicker shape, combobox/dialog internals, pack-memory rules).

## Owner / Windows checklist

1. Open Upload… — width fits ten emoji per row with the custom emoji font loaded; the
   first enabled open-button is focused.
2. Edit an emoji box: Enter ends editing, spaces stripped on save; break a save (e.g.
   an unreadable file) and watch the box restore its previous value.
3. Copy an emoji String — flash tone shows, restores after ~1.2 s.
4. Drag a preview out to Explorer/Telegram (OS drag, threshold respected).
5. Send to pack: combobox filter, inline New pack…, Move checkbox, initial focus on
   the pack field (not Send) when nothing is preselected.
6. Sticker and thumbnail delete confirms show with their previews.
7. The Editor's save dialog: open from a sticker save, pick a pack through the bridged
   picker, save — then do it again with "New pack".

## Risks and fallbacks

- **Fonts-ready/rAF timing across the bridge**: the width fits measure live layout; if
  the effect runs before the dialog is laid out the measurement is wrong — keep the
  rAF-then-fonts.ready ordering exactly as upload-list.ts:74-76.
- **Focus fights between React bodies and imperative dialogs** (phase risk 2): the
  combobox owns focus inside the picker; React re-renders must not remount the bridged
  element while it is focused — the renderPanel guard and dialog-settle unmount are the
  two mechanisms; review each dialog's onChange/sync path.
- **Timer cleanup on dialog cancel** (phase risk 3's local variant): a cancel closes
  the dialog before `copyFlash`'s timer fires — the effect cleanup must make that a
  no-op.
- Fallback if S05 overruns: `panels.ts` (the most mechanical, self-contained file) slips
  to the front of S06, which rebuilds the panel mount point anyway — sequencing
  survives; dialogs + upload-list + the Editor save-dialog regression must land here.
