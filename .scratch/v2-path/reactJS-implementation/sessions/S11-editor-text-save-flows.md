# S11: Text controls, SaveDialog, origin/Library flows (Phase 4)

Anchors are `src/views/editor.ts` lines at commit `11bacb6` unless a file is named
(plan.md › Anchor base): read `git show 11bacb6:<file>` and find today's code by the
symbol named beside each line.

## Goal

Port the Editor's text tool controls to JSX (eyedropper and FontPicker stay
imperative embeds) and finish the save flows end-to-end in React: sticker save
(replace origin / new + pack picker), thumbnail save, the PNG-over-cap WEBP
offer, the exhausted give-up question, `originAfterSave` re-point, saved-note
links guarded by `libraryGeneration`, and `forgetEditorOrigin()` while the
Editor is unmounted. When this session ends, the save matrix behaves exactly
as today, the library re-point invalidation shows all three symptoms with the
Editor both on and off screen, the SaveDialog decision is recorded, and the text
section of EditorApp's interim refresh driver is gone.

## Preconditions

- S10 landed: the right panel is React (less EmojiPanel under the step-0 hand-off below); what remains in `src/views/editor.ts`
  is the text controls + save-flow el() code.
- S07's controller carries `nextStyle`, `fonts`/`fontsProblem`, `lastFormat`,
  `origin`, `thumbnailOrigin`, `libraryGeneration`, `downloadNote`, the message
  row state (with its `links`), and the save/session command methods.
- Binding contract #2 (dialog islands) and its bridge pattern: `openDialog(title,
  [], buttons, …)` with an empty body, `createRoot` on the dialog's own
  `.app-dialog-body` (via `handle.dialog`), render inside `flushSync`, bridge root
  unmounted when the dialog's `result` settles.
- **Contingency from S10:** if S10 slipped EmojiPanel (S10's Risks and fallbacks;
  the S10 PR description records whether it fired), it lands here as step 0 by
  explicit hand-off, before the text-controls work; S10's Work plan item 5 is its
  spec. The step's own preconditions: RightPanel renders the emoji `<section>`
  (React-owned, `hidden` from `rightTab`) holding three `ImperativeNode` embeds (one per node) of
  the label/textarea/hint el() nodes still built in editor.ts (:975–999), and
  EditorApp's driver still holds the emoji lines (:2383–2394).
- **Start-of-S11 lever check** (the plan's "4.6 absorbs into 4.5"):
  if S07–S10 each landed clean (plan.md › Clean landing), S12's consolidation
  work (final el() deletion, closing sweep, audit) is absorbed into this session's
  tail as step 7 (before Land). S11 cannot judge its own landing, so the decision is taken here,
  at the start, on S07–S10 alone; S12's audit is the absorption checklist and any
  failed item un-cancels S12. Clean landing requires that a session used none of
  its overrun fallbacks, so **an S10 EmojiPanel hand-off (step 0) means S10 did not
  land clean and rules absorption out**: steps 0 and 7 never both run.

## Files touched

| Path | Status |
|---|---|
| `src/views/editor/EmojiPanel.tsx` | new — **contingent** on step 0 (S10 slipped EmojiPanel); otherwise S10's and untouched here |
| `src/views/editor/RightPanel.tsx` (from S10) | modified — **contingent** on step 0: the emoji section's three interim `ImperativeNode` embeds become `<EmojiPanel/>`; otherwise untouched |
| `src/views/editor/ToolsPanel.tsx` (from S09) | modified — the text-tool controls section becomes JSX; the `leftTabs.section("text", …)` builder (or S09's one-off) and the line in ToolsPanel's layout effect that writes the text `<section>`'s `hidden` are deleted (step 2) |
| `src/views/editor/EditorApp.tsx` (from S08) | modified — the driver loses the text section (and, if step 0 fires, the emoji lines :2383–2394); the message row's interim `ImperativeNode` span embed for `links` nodes (S08) is deleted (step 4) |
| `src/views/editor/SaveDialog.tsx` | new — **contingent** on the step 1 decision (default: not created) |
| `src/views/editor.ts` | modified — text-controls + save-flow el() sections deleted or reduced to delegates (and, if step 0 fires, the emoji label/textarea/hint el() build :975–999 with its keydown/blur listeners) |
| `src/editor/view/save-dialog.ts` (301 LOC) | modified **only if** step 1 decides to port (`saveDialog` :98, `thumbnailSaveDialog` :224 replaced by the JSX component); otherwise untouched |
| `src/editor/view/eyedropper.ts`, `font-picker.ts` | **untouched** — embeds |
| `src/editor/save.ts` (236 LOC) | **untouched** |
| `src/editor/app/editor-controller.ts` (from S07) | modified — the message row's `links` become data (step 4): `stickerLink`/`thumbnailLink` stop building `el("button")` nodes; plus wiring for the save methods (they exist since S07) |

The pack picker (Phase 3 surface) is not touched.

## Work plan

Steps run in this order; 0 and 7 are **contingent** (they run only when their
condition holds), 1 is a decision that gates the save-flow wiring, and Land (8) is
last.

0. **(Contingent: S10 handed off EmojiPanel.)** Port it first, as this PR's first
   commit — S10's Work plan item 5 is the spec: `EmojiPanel.tsx` (label, the
   uncontrolled textarea, hint; Enter/blur commit via
   `controller.commitEmoji(value)`; the layout effect's unguarded pending
   `emojiDraft` write + silent clear and its guarded `emoji.value` sync; the
   blocked box's `disabled`/`title`). RightPanel renders `<EmojiPanel/>` inside its
   emoji `<section>` in place of the three interim `ImperativeNode` embeds, which are
   deleted; delete the emoji el() build in editor.ts (:975–999, listeners
   included) and the driver's emoji lines (:2383–2394). Otherwise this step is
   empty.
1. **SaveDialog decision, before any save-flow wiring** (binding contract #2
   reasoning): look at `save-dialog.ts` (301 LOC: `saveDialog` :98,
   `thumbnailSaveDialog` :224, `originNow` :87, `SaveChoice` :56). The **default is
   keep imperative**: it is a transient modal over the shared dialog contract +
   the packPicker, and its focus/keyboard rules belong to the dialog layer
   (`dialogOpen()` gating), the same island reasoning as contract #2. Port as
   `<SaveDialog/>` through the bridge pattern only if the port is trivial (no
   focus or keyboard logic of its own to re-home). Record the decision and its
   reasoning in the PR description; steps 3–4 then wire against whichever form was
   chosen.
2. **Text tool controls in ToolsPanel:** the Add text / Edit text buttons
   (:440–444), the font-size / color / outline inputs and their Name stems
   (:445–500), and their change handlers (:502–551, `fontPicker.onChange` and the
   size/colour/outline `change` listeners that call `restyle` and blur), ported
   line-by-line; the JSX replaces S09's `ImperativeNode` embed of `textSection`
   (:865–886, the "Text" `toolSection` with its `editor-field`/`editor-cap`
   markup), which is deleted with its host. **Delete what S09 kept for that
   embed too:** the `leftTabs.section("text", …)` builder (:795–806) or S09's
   equivalent one-off, and the line in ToolsPanel's layout effect that sets the
   text `<section>`'s `hidden` from `leftTab` (S09 step 3). The JSX section now
   renders `hidden` from `leftTab` like the other sections; a leftover effect line
   would write DOM React owns. The
   busy/text-reason disable loop (`textControls`, comment block at :478) keeps its
   exact conditions and reason strings. The eyedroppers are ref-embeds
   (`eyedropperButton` from eyedropper.ts — kept as-is, the single source of the §2
   strings); the FontPicker stays an imperative embed (`new FontPicker(fontStem)`,
   :454) — binding contract #2: the combobox swap is optional post-adoption, never
   an exit criterion. The inputs edit `controller.nextStyle` while no text layer is
   selected (SPM-18: new text starts with no outline) — same read/write points as
   today; inputs stay uncontrolled with their two activeElement guards (font size
   :2527, outline width :2530). Remove the text section (:2513–2554, Add/Edit
   text's disabled/title lines :2517–2522 included) from EditorApp's interim
   refresh driver.
3. **Save flows (controller-driven, already S07 methods — now React-invoked):**
   - Sticker save: replace-origin vs save-new + the pack picker; thumbnail
     save (`markThumbnailChanged(outcome.pack.id)` :1501).
     `markStickerFileChanged(outcome.sticker.id)` fires only for
     `target.kind === "replace"` (:1539) — the changed-files drain contract
     (binding contract #6) preserved verbatim.
   - PNG-over-cap → the WEBP offer (`confirmWebp` :2925); inference exhausted →
     the give-up question (`confirmGiveUp` :2910); the model-download
     confirmation (`confirmModelDownload` :2894). Wording untouched.
   - `markSaved` only when `current.doc === doc` (:1506, :1547) — the
     defence-in-depth kept. `lastFormat` persists across saves (SPM-10) and
     the dialog starts on it.
   - `origin = originAfterSave(outcome, packTitle)` (:1541) — the re-point
     after save.
4. **Saved-note links + the `libraryGeneration` guard:** `stickerLink` (:1079) /
   `thumbnailLink` (:1108) are built once, by the save flow, when the saved note is
   shown; each takes `const generation = libraryGeneration` at that moment
   (:1083, :1112). Keep that: capture the generation **at save time** and store it
   with the link in the message row's `links` state. **This is a controller
   change:** S07 defined `links` as `say()`'s extra nodes/strings and moved
   `stickerLink`/`thumbnailLink` (each an `el("button", { class: "editor-link",
   "aria-label", title }, text)` builder with its own click listener) into the
   controller as-is. S11 turns them into data builders: `links` becomes
   `(string | SavedLink)[]` (the `" "` separator of :1510/:1548 stays a string),
   with `SavedLink = { kind: "sticker"; sticker: Sticker; packTitle: string;
   generation: number } | { kind: "thumbnail"; packId: number; packTitle: string;
   generation: number }` — what the builders need (`showStickerLink(sticker,
   packTitle)` / `showThumbnailLink(packTitle)` for text and label; `sticker.packId`,
   `sticker.id`, `sticker.position` for the click). The click body moves verbatim
   into a controller command (e.g. `followSavedLink(link)`); EditorApp's message
   row renders each `SavedLink` as the same `button.editor-link` and never
   re-reads the generation at render. With no node left in `links`, **delete S08's
   interim `ImperativeNode` span embed** in the message row (S08 step 3); the row
   renders strings as text and `SavedLink`s as buttons only. The command keeps `if (busy) return`
   (:1085, :1114) first, then refuses with the same wording when
   `link.generation !== libraryGeneration` (:1087–1090, :1116–1119) — links
   "report gone".
5. **`forgetEditorOrigin()` while the Editor is *unmounted*:** the Settings
   re-point path (`forgetOriginHook`, S07) mutates the controller headless:
   `origin`/`thumbnailOrigin` get `otherLibrary: true`, `emoji?.forgetOrigin()`,
   `libraryGeneration++`. The remounted view must show the disabled Emoji box
   and the refused Replace **at once** — no mount-order dependency, no
   "first render shows stale state". Test with the editor off screen, then
   switch to it.
6. **Delete** the remaining text/save el() code from `src/views/editor.ts`. The
   `confirm*` helpers (:2872–2947, with `isSaveShortcut` :2920 among them) stay in
   editor.ts, but they are no longer module-private: at `11bacb6` editor.ts
   exported only `renderEditor` (:229) and the hook layer (:2817–2866), while
   their callers have since left the file — `confirmScaleToFit` (:1190),
   `confirmDiscard` (:1382), `confirmCloseOriginGone` (:1393), `confirmWebp`
   (:1442), `confirmGiveUp` (:1558) and `confirmModelDownload` (:1993) into the
   controller in S07; `isSaveShortcut` (:2600, :2614, :2648) into EditorApp's
   keyboard effect in S08. So S07 exports the six `confirm*` helpers and S08
   exports `isSaveShortcut`; this session
   records in the PR description that the exports exist and does not move them.
7. **(Contingent: the start-of-S11 lever check passed.)** Run S12's Work plan and
   audit as this session's tail; any failed audit item stops the absorption and
   S12 runs as planned. Under absorption the owner's Windows pass is this file's
   list plus S12's checklist items 1 (the S08 list re-run) and 3 (the text-heavy
   session); S12's item 2 (re-run the S11 list) is this list, run once, in this
   pass.
8. **Land per plan.md › Session protocol.**

## Deliberately out of scope

- Changing `save.ts`, save-dialog wording, or the pack picker (Phase 3
  surface).
- Porting the FontPicker or eyedropper internals (embeds only).
- Making the dialog layer React (binding contract #2 — `dialog.ts` untouched).
- CSS files (byte-identical), icons, new aria/role attributes.
- No `<StrictMode>` anywhere in `src/` (binding contract #3): this session's
  text-control effects, any SaveDialog bridge root, and its focus flows must not be
  double-invoked.

## Exit criteria

- Build + tests pass; all five CSS files byte-identical.
- The full save matrix behaves as today: new sticker / replace origin /
  gone-origin / thumbnail / declined / exhausted, including `lastFormat`
  persistence and `markSaved` only when `current.doc === doc`.
- Library re-point invalidation shows all three symptoms — save-dialog
  refusal wording, blocked emoji box reason, note links reporting gone —
  with the Editor on screen **and** off screen (Settings re-point while the
  editor is unmounted, then switch to it).
- The SaveDialog decision (kept imperative, or ported via the bridge) is recorded
  in the PR description with the contract reasoning.
- The changed-files drain fires exactly as today (replace →
  `markStickerFileChanged`; thumbnail → `markThumbnailChanged`).
- EditorApp's driver holds no text-control line (no `fontPicker`,
  `fontSizeInput`, `colorInput`, `outline*Input`, `textButton`/`editTextButton` or
  eyedropper reference).
- No text-section scaffolding survives: grep of `src/views/editor/` finds no
  `leftTabs.section` / text-section one-off, and ToolsPanel's layout effect sets
  no `hidden` (nor any other attribute) on the text `<section>`.
- The message row holds no `ImperativeNode`: grep of `EditorApp.tsx` finds no
  `ImperativeNode` in the message-row render, and `links` carries only strings
  and `SavedLink` data (no `HTMLElement`).
- Windows checklist passed.
- If step 0 fired (S10's two criteria, moved here): emoji commit goes through
  `commitEmoji(value)` → `SessionEmoji`, with the stored result shown via
  `emojiDraft`, and the textarea has no `value=` prop; EditorApp's driver holds no
  `emojiInput` reference nor any emoji line (:2383–2394), and no `ImperativeNode`
  is left in RightPanel.
- PR merged with `gh pr merge <N> --merge`.

## Review-cycle coverage

- The `libraryGeneration` snapshot taken at save time and stored with the link;
  the click handler's `busy` return and generation re-check copied verbatim (both
  sticker and thumbnail paths).
- Save-flow guard order and reason strings unchanged: `saveRefusal`
  (mid-stroke + doc + constraints) wording, the WEBP/give-up/download
  question texts byte-identical.
- `markSaved` defence-in-depth and the `markStickerFileChanged` /
  `markThumbnailChanged` conditions.
- If SaveDialog was ported: the bridge root is unmounted when the dialog
  result settles; no state update after unmount; `dialogOpen()` gating
  unchanged. If kept: save-dialog.ts absent from the diff.
- Text controls: uncontrolled inputs with their two activeElement guards;
  nextStyle read/write points unchanged; the disable loop's conditions and reasons.

## Owner / Windows checklist

1. The save matrix: save as new (pack picker), replace origin, save
   thumbnail, decline the save, gone-origin save — each path's wording and
   outcome as today.
2. PNG over the import cap → the WEBP offer; exhausted inference → the
   give-up question.
3. Saved-note links navigate to the Pack Manager (sticker and thumbnail
   variants); after a Settings re-point they report gone — with the editor
   on screen, and after re-pointing while it is off screen then switching to
   it (disabled Emoji box + refused Replace at once).
4. Text controls: set font size/color/outline with no text selected → a new
   text starts with them (outline per SPM-18); eyedropper picks; FontPicker
   opens and selects.
5. `lastFormat` persists: save as WEBP once, the next save dialog starts on
   WEBP.

6. (Only if step 0 fired; S10's item 5.) Emoji box: Enter commits and hands focus
   back as before; Shift+Enter adds a line; >20 characters warns without
   blocking; a blocked box shows its reason tooltip.
7. (Only if step 0 fired; S10's item 8.) Type in the emoji box, then press Ctrl+Z,
   Delete and a tool letter without leaving it — the keys act on the box only (no
   editor action), and the text stays.

If step 7 absorbed S12, this pass also runs S12's checklist items 1 and 3 (step 7).

## Risks and fallbacks

- **Focus-clobbering** ([phase-4 Risks item 4](../phases/phase-4.md#risks)): the
  text controls hold two of the editor's five activeElement guards (:2527, :2530;
  the others are :1901, :2394 and effect-controls.ts:292); uncontrolled inputs +
  explicit sync with the same guards.
- **Dialog bridge leaks** (binding contract #2): a ported SaveDialog that
  updates state after settle would throw on the unmounted bridge root; the
  reviewer checks the unmount-after-settle path specifically.
- **Stale link navigation** (libraryGeneration): a re-point between the save and
  the click must refuse — the generation is captured when the link is built, not
  re-derived at render or click.
- Fallback if the session overruns: a `<SaveDialog/>` port chosen in step 1 is the
  designated slip — revert to keeping `save-dialog.ts` imperative and record "kept
  imperative, port deferred to post-adoption" in the PR description. The save
  *flows* (controller + guards + links) are not slippable: S12's audit assumes them
  landed.
