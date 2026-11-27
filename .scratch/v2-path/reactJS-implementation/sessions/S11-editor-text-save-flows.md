# S11: Text controls, SaveDialog, origin/Library flows (Phase 4)

## Goal

Port the Editor's text tool controls to JSX (eyedropper and FontPicker stay
imperative embeds) and finish the save flows end-to-end in React: sticker save
(replace origin / new + pack picker), thumbnail save, the PNG-over-cap WEBP
offer, the exhausted give-up question, `originAfterSave` re-point, saved-note
links guarded by `libraryGeneration`, and `forgetEditorOrigin()` while the
Editor is unmounted. When this session ends, the save matrix behaves exactly
as today, the library re-point invalidation shows all three symptoms with the
Editor both on and off screen, and the SaveDialog port decision is recorded.

## Preconditions

- S10 landed: the right panel is React; what remains in `src/views/editor.ts`
  is the text controls + save-flow el() code.
- S07's controller carries `nextStyle`, `fonts`/`fontsProblem`, `lastFormat`,
  `origin`, `thumbnailOrigin`, `libraryGeneration`, `downloadNote`, and the
  save/session command methods.
- Binding contract #2 (dialog islands) and the Phase 3 bridge pattern
  (`createRoot` into a detached div, element passed as the dialog body, bridge
  root unmounted when the result settles) are available.
- **Contingency from S10:** if S10 slipped EmojiPanel, it lands here as
  step 0 by explicit hand-off (per S10's fallback wording) — before the
  text-controls work; S10's plan item 4 is its spec.
- **Start-of-session check** (the plan's named compression lever, per S12's
  rule): if S07–S11 all landed without review findings, the S12
  consolidation work (final el() deletion + audit) may be absorbed into
  this session's tail — decide at session start; S12's audit is the
  absorption checklist and any failed item un-cancels S12.

## Files touched

| Path | Status |
|---|---|
| `src/views/editor/ToolsPanel.tsx` (from S09) | modified — the text-tool controls section becomes JSX |
| `src/views/editor/SaveDialog.tsx` | new — **contingent**: port only if the dialog binding-contract check says the bridge pattern covers it; otherwise keep `save-dialog.ts` imperative and record the decision (see step 4) |
| `src/views/editor.ts` | modified — text-controls + save-flow el() sections deleted or reduced to delegates |
| `src/editor/view/save-dialog.ts` (301 LOC) | modified **only if** the port happens (`saveDialog` :98, `thumbnailSaveDialog` :224 replaced by the JSX component); otherwise untouched |
| `src/editor/view/eyedropper.ts`, `font-picker.ts` | **untouched** — embeds |
| `src/editor/save.ts` (236 LOC) | **untouched** |
| `src/editor/app/editor-controller.ts` | at most wiring (its save methods exist since S07) |

The pack picker (Phase 3 surface) is not touched.

## Work plan

0. **(Contingent step 0)** If S10 handed off EmojiPanel, port it first —
   S10's Work plan item 4 is the spec, and its commit path
   (`controller.commitEmoji()` → `SessionEmoji`) is unchanged by the move.
   If S10 landed it, this step is empty.
1. **Text tool controls in ToolsPanel:** font-size / color / outline inputs,
   ported line-by-line from the el() text section in git history. The
   busy/text-reason disable loop (the comment block at :478) keeps its exact
   conditions and reason strings. The eyedroppers are ref-embeds
   (`eyedropperButton` from eyedropper.ts — kept as-is, the single source of
   the §2 strings); the FontPicker stays an imperative embed
   (`new FontPicker(fontStem)` pattern, :454) — binding contract #2: the
   combobox swap is optional post-adoption, never an exit criterion. The
   inputs edit `controller.nextStyle` while no text layer is selected
   (SPM-18: new text starts with no outline) — same read/write points as
   today; inputs stay uncontrolled with their activeElement guards.
2. **Save flows (controller-driven, already S07 methods — now React-invoked):**
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
3. **Saved-note links + the `libraryGeneration` guard:** `stickerLink` (:1079)
   / `thumbnailLink` (:1108) render the saved note; both snapshot
   `const generation = libraryGeneration` and re-check
   `generation !== libraryGeneration` before navigating (:1083–1087, :1112–1116)
   — a stale link into a re-pointed Library refuses with the same wording
   (links "report gone"). Copy the guard verbatim into the JSX link handler.
4. **`forgetEditorOrigin()` while the Editor is *unmounted*:** the Settings
   re-point path (`forgetOriginHook`, S07) mutates the controller headless:
   `origin`/`thumbnailOrigin` get `otherLibrary: true`, `emoji?.forgetOrigin()`,
   `libraryGeneration++`. The remounted view must show the disabled Emoji box
   and the refused Replace **at once** — no mount-order dependency, no
   "first render shows stale state". Test with the editor off screen, then
   switch to it.
5. **SaveDialog decision (binding contract #2 check):** run the contract check
   on porting `save-dialog.ts` (301 LOC: `saveDialog` :98,
   `thumbnailSaveDialog` :224, `originNow` :87, `SaveChoice` :56):
   - If the Phase 3 bridge pattern covers its focus/keyboard needs → port as
     `<SaveDialog/>` (JSX body inside the shared dialog via the bridge;
     bridge root unmounted when the dialog's result settles).
   - If not → keep `save-dialog.ts` imperative, exactly as S07–S10 used it.
   Either way, **record the decision in the session notes/PR** — the phase
   file makes the recording, not the port, the requirement. Its focus and
   keyboard rules belong to the dialog layer (`dialogOpen()` gating), not to
   React.
6. **Delete** the remaining text/save el() code from `src/views/editor.ts`;
   the `confirm*` helpers (:2872–2940) stay exported there regardless (shell
   and pack-manager call sites untouched).

## Deliberately out of scope

- Changing `save.ts`, save-dialog wording, or the pack picker (Phase 3
  surface).
- Porting the FontPicker or eyedropper internals (embeds only).
- Making the dialog layer React (binding contract #2 — `dialog.ts` untouched).
- CSS files (byte-identical), icons, new aria/role attributes.
- No `<StrictMode>` on the editor root (binding contract #3): this session's
  text-control effects, the SaveDialog bridge root, and its focus flows must
  not be double-invoked; the fence holds here as in S08–S10.

## Exit criteria

- Build + tests pass; all five CSS files byte-identical.
- The full save matrix behaves as today: new sticker / replace origin /
  gone-origin / thumbnail / declined / exhausted, including `lastFormat`
  persistence and `markSaved` only when `current.doc === doc`.
- Library re-point invalidation shows all three symptoms — save-dialog
  refusal wording, blocked emoji box reason, note links reporting gone —
  with the Editor on screen **and** off screen (Settings re-point while the
  editor is unmounted, then switch to it).
- The SaveDialog port decision is recorded (ported-with-bridge or
  kept-imperative), with the contract reasoning.
- The changed-files drain fires exactly as today (replace →
  `markStickerFileChanged`; thumbnail → `markThumbnailChanged`).
- Review-cycle converged; PR lands via `gh pr merge --merge`.

## Review-cycle coverage

- The `libraryGeneration` snapshot/re-check guards copied verbatim into the
  JSX link handlers (both sticker and thumbnail paths).
- Save-flow guard order and reason strings unchanged: `saveRefusal`
  (mid-stroke + doc + constraints) wording, the WEBP/give-up/download
  question texts byte-identical.
- `markSaved` defence-in-depth and the `markStickerFileChanged` /
  `markThumbnailChanged` conditions.
- If SaveDialog was ported: the bridge root is unmounted when the dialog
  result settles; no state update after unmount; `dialogOpen()` gating
  unchanged. If kept: save-dialog.ts absent from the diff.
- Text controls: uncontrolled inputs with activeElement guards; nextStyle
  read/write points unchanged; the disable loop's conditions and reasons.

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

## Risks and fallbacks

- **Focus-clobbering** (risk #4): five activeElement guards live in this
  surface (text inputs); uncontrolled + explicit sync with the same guards.
- **Dialog bridge leaks** (binding contract #2): a ported SaveDialog that
  updates state after settle would throw on the unmounted bridge root; the
  reviewer checks the unmount-after-settle path specifically.
- **Stale link navigation** (libraryGeneration): a re-point between render and
  click must refuse — the snapshot guard is copied, not re-derived.
- Fallback if the session overruns: the `<SaveDialog/>` JSX port is the
  designated slip — keep `save-dialog.ts` imperative (the S07–S11 default),
  record the decision as "kept imperative, port deferred to post-adoption",
  and hand the sweep to S12. The save *flows* (controller + guards + links)
  are not slippable: S12's audit assumes them landed.
