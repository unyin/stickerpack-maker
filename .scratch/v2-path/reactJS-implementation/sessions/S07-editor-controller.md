# S07: EditorController — the state bridge, no React yet (Phase 4)

Corrections to the phase file: none material. One path precision: the phase
preamble's "session.ts 269" is `src/editor/model/session.ts` (269 lines,
verified; `EditorSession` is imported from there at src/views/editor.ts:155).

## Goal

Extract the 24 mutable closure vars of `buildEditor()` and all command logic
from `src/views/editor.ts` into a subscribable module-level singleton,
`EditorController`, with zero behavior change and zero React. When this session
ends, the el() DOM build still renders the Editor exactly as today, but it reads
all state from the controller, every command (run/editAsync/gestures/session
flows/save) is a controller method, the message row is controller state
(`say()` becomes mutation + notify; `withMessage(message, action)` inside
`run()` is replaced by the controller message API), and the hook layer
(`openFileInEditor`/`openThumbnailFileInEditor`/`forgetEditorOrigin`) works with
the view never built — headless, before any React exists.

## Preconditions

- Phases 1–3 landed: S01 (mountView scaffolding), S02–S03 (shell + shared
  widgets + Settings), S04–S06 (Pack Manager). The dialog/combobox binding
  contracts (plan.md #2) are in force.
- Binding contracts that shape this session: #4 (stores: mutable-snapshot
  pattern, commands outside React), #6 (behavior contracts preserved verbatim).
- No React knowledge needed; this session must be reviewable as a pure refactor.

## Files touched

| Path | Status |
|---|---|
| `src/views/editor.ts` (2,951 LOC at HEAD) | modified — state + commands move out; the DOM build stays and consumes the controller |
| `src/editor/app/editor-controller.ts` | new |
| `src/editor/app/commands.ts` | new — only if `editor-controller.ts` would exceed ~600 LOC (phase-file rule) |

Nothing under `src/editor/model/` (16 files), `src/editor/view/`, `src/editor/save.ts`,
`src/editor/api.ts`, `src/pack-manager/`, or any CSS file.

## Work plan

1. Create `src/editor/app/editor-controller.ts`. Declare a `EditorController`
   singleton class whose fields are the closure vars, each with its current
   initial value and its explanatory comment copied verbatim (the comments record
   owner decisions — SPM-10/12/15, CMT-152 — and must survive the move):
   `constraints` (= STICKER, never changed mid-session), `session`, `stage`,
   `busy` (= false), `showBox` (= true), `tool` (= "move"), `overlayLayerId`,
   `fonts`, `fontsProblem`, `nextStyle` (= { fontFamily: "", fontSize:
   DEFAULT_FONT_SIZE, color: DEFAULT_TEXT_COLOR, outline: null }), `lastFormat`
   (= "png"), `freeSide` (= "longest"), `origin`, `thumbnailOrigin`,
   `libraryGeneration` (= 0), `emoji` — the declarations currently at
   src/views/editor.ts:238–269 — plus `warp` (:433, `WarpInProgress | null`),
   `basis` (:437, `EffectBasis | null`), `brushSize` (:577), `tolerance` (:593),
   `feathered` (:622), `downloadNote` (:635), `emojiLeafHidden` (:912), `wand`
   (:1804, `WandPress | null`).
2. Give the controller the external-store shape (binding contract #4):
   `subscribe(listener)` that forwards `session.subscribe` and re-subscribes on
   session identity change; a `version` number; every controller mutation bumps
   `version` and notifies. This session's consumer is not React but the el()
   view: `buildEditor()` subscribes once and runs `refresh()` on notify.
3. Move the commands to controller methods, character-identical bodies:
   - `run()` (busy-gate at :1136–1147): `if (busy) return; busy = true;
     stage?.setInteractive(false);` … finally `stage?.setInteractive(true)`,
     `busy = false`. Keep the read-and-set synchronous in one task (risk #5:
     rapid double-click must still be swallowed). Its `say("")` becomes a
     controller mutation and its `withMessage(message, action)` is replaced
     by the controller message API (step 4 below) — `run()` never touches
     view DOM.
   - `editAsync()` with the doc-identity refusal at :1175
     (`if (current.doc !== doc) { … return; }`) copied verbatim.
   - `setTool`, `startSession` (:1207), `endSession` (:1400), `closeThenOpen`
     (:1285), `saveSession` (called via `run(saveSession)` at :347),
     `commitEmoji` (:1057), `stickerLink` (:1079) / `thumbnailLink` (:1108).
   - The gesture handlers: `beginWarp`/`continueWarp`/`endWarp` (guard
     `!current || !stage || busy || warp` at :1754), `beginWand`/… (guards at
     :1814 `!current || busy`, :1841 `!current || !stage || busy || wand`),
     `composeShape`. They stay plain functions — event-driven, never
     effect-driven (binding contract #4).
   - The drag-drop plan handling: `dropPlan(payload.paths, kind, busy,
     dialogOpen())` at :2750 and the `setDropTarget(!dialogOpen())` over/enter
     branch at :2745.
4. **The message row becomes controller state.** The controller gains message
   fields `{ text, tone, links }` — `tone: "error" | "note"`, `links` the
   `extra` nodes/strings of today's `say(text, tone, ...extra)` (:1045).
   `say()` is rewritten as a controller method: mutate the fields, bump
   `version`, notify — it no longer calls `message.replaceChildren` or the
   `is-note` toggle. The message DOM rendering stays el()-driven this session:
   the `p` at :282 stays el()-owned and the existing render pass (`refresh()`,
   step 7) renders it from the controller fields, producing the exact same DOM
   (children, `is-note` class, the error-tone rule quoted at :1042–1043).
   `run()`'s `withMessage(message, action)` (:1144) is replaced by the
   controller message API: clear the message state before the action, route a
   thrown error's `errorMessage(err)` into it — same observable behavior, one
   writer. `clearNote()` (:1132) and commitEmoji's note check (:1068) read
   `tone === "note"` from the controller instead of `message.classList`. No
   command writes message DOM directly anymore.
5. Move the `EffectPreview` instance (`new EffectPreview<EffectResult>(…)` at
   :416) and its show callback into the controller. **No closure may capture a
   stage instance**: the show callback reads `controller.stage` dynamically, so
   a preview survives a stage rebuild.
6. Re-point the hook layer (:2812+): `openFileHook` (assigned at :2759),
   `openThumbnailHook`, `forgetOriginHook` (:2769–2776: `origin = { …origin,
   otherLibrary: true }`, same for `thumbnailOrigin`, `emoji?.forgetOrigin()`,
   `libraryGeneration++` — bump + notify only; the trailing `refresh()` at
   :2776 is dropped, since a notify with no subscriber is a no-op and
   `refresh()` runs only when a view exists, its subscription registered by
   `buildEditor()`) become thin module functions delegating to
   controller methods. Install them at module/controller init, **not** inside
   `buildEditor()`, so `forgetEditorOrigin()` and `openFileInEditor()` work with
   the view detached (risk #3: the `root ??=` module cache is replaced by the
   controller). The `renderEditor()` call inside `openFileInEditor` (:2852)
   stays — no longer load-bearing for hook installation, but it preserves the
   lazy view-build timing. Document `startSession`'s preserved invariant:
   "showEditor() runs before the file opens, so the canvas can measure".
7. Rewrite `refresh()` (:2323–2579) in place in `src/views/editor.ts` to read
   `controller.*` instead of closure vars; it remains the el() view's single
   render pass. The `refresh()` call sites that sat inside moved command code
   disappear into the mutation's notify; call sites in view-local DOM handlers
   keep calling `refresh()` directly. Either way, every old call site must still
   produce exactly one synchronous render before control returns — the mapping
   of all 18 real call sites is the S12 audit checklist (27 `refresh()`
   occurrences at HEAD = 18 call sites + 8 comment mentions (:305, :338, :342,
   :908, :1248, :1358, :1996, :2024) + the definition at :2323; plus the
   `session.subscribe(refresh)` wiring at :1249, which the grep misses — map it
   too), so keep a list while moving.
8. If `editor-controller.ts` would exceed ~600 LOC, split command methods into
   `src/editor/app/commands.ts` (mixed into the controller or free functions
   taking the controller) — phase-file rule, not a design choice.

## Deliberately out of scope

- React, JSX, new deps, any DOM markup/class/title/attribute change, any
  behavior change at all — this session is a zero-diff-behavior refactor.
- The imperative islands (`stage.ts`, `text-edit.ts`, `eyedropper.ts`,
  `warp-brush.ts`, `effect-preview.ts`, `effect-controls.ts`,
  `font-picker.ts`, `save-dialog.ts`, `actions-list.ts`, `reveal.ts`,
  `download-text.ts`, `lasso.ts`) and all `src/editor/model/*` files, `save.ts`,
  `geometry.ts` — reused verbatim, never rewritten.
- All five CSS files (byte-identical), the Icons rule, the UI-audience rule.
- The `viewTransform` cache and `mounted` flag (S08).

## Exit criteria

- `bun run build` (or the repo's build command) + `bun test` pass.
- `git diff --stat` proves all five CSS files byte-identical
  (styles.css 449, dialog.css 45, combobox.css 72, editor.css 908,
  pack-manager.css 1285).
- Grep proves no `let` state remains inside `buildEditor()` except purely-local
  DOM-build temporaries.
- The race guards are character-identical in the controller: `run()`'s busy-gate
  + `stage?.setInteractive`, `editAsync`'s `current.doc !== doc` refusal,
  `beginWarp`/`beginWand`'s busy/active guards.
- Hook layer headless: hooks mutate controller state and notify without
  requiring a mounted view — a notify with no subscriber is a no-op
  (`forgetEditorOrigin()` and `openFileInEditor()` work without
  `renderEditor()` ever having been called; temporary unit check or manual:
  re-point Library from Settings before ever opening the Editor). With a view
  mounted, the same notifications drive `refresh()` exactly as today.
- The message row is controller state: grep proves no command writes
  `message.*` DOM directly — the el() render pass is the only writer, and the
  error/note tones, `clearNote`'s note-only rule and `withMessage`'s
  error-tone routing behave exactly as today.
- Review-cycle (AGENTS.md) converged; PR lands via `gh pr merge --merge`.
- Owner smoke test (pre-React — behavior must be *identical*): open an image,
  drag/transform, add text, rect-cut + paste, wand Shift/Alt drag, warp drag,
  Apply outline to text, save new sticker, save-thumbnail, Close with unsaved
  changes, switch tabs and back — session and pixel state unchanged.

## Review-cycle coverage

- Every moved body is a verbatim move, not a rewrite: diff hunks should show
  pure relocation; flag any changed expression, guard order, or error text.
- No DOM diff: the built view's classes/titles/text must be unchanged — compare
  a DOM snapshot or rely on the line-by-line diff of the build section.
- The busy-gate and doc-identity guards survive with their exact semantics
  (no `?.` where there was `!`, no inverted conditions).
- Hook installation moved out of `buildEditor()` without changing the
  ask-then-show-then-open ordering documented at :2836+.
- Comments recording owner decisions moved with their code.
- The message-state move: `say()`/`withMessage` semantics unchanged (error
  tone, note tone, the `say("")` clear before an action, `clearNote`'s
  note-only rule); the only DOM writer is the el() render pass.

## Owner / Windows checklist

(Pre-React smoke; the phase's Windows-specific checks land with S08+. Run on
Windows as part of the smoke test anyway.)
1. Open an image; drag/transform a layer; add text via the overlay.
2. Rect-cut + paste; wand with Shift and with Alt drag; warp drag; Apply
   outline to text.
3. Save as a new sticker; save-thumbnail.
4. Close with unsaved changes (confirm the discard question).
5. Switch tabs and back — session and pixel state unchanged.
6. Rapid double-click any toolbar action — only one run (busy-gate).

## Risks and fallbacks

- **`root ??=` semantics replaced by the controller** (phase risk #3): hooks
  must work headless; mitigated by installing hooks at module init and testing
  the Settings re-point path before the Editor is ever shown.
- **`run()` busy-gating** (phase risk #5): synchronous read-and-set in one
  task; commands stay outside any render cycle; rapid-double-click is in the
  smoke test.
- **Effect cleanup cancels what today always finishes** (phase risk #1): no
  effects exist yet in this session — verify no moved code introduced a
  callback that could now be dropped (e.g. the EffectPreview show callback).
- Fallback if the session overruns: split at the gesture-handler boundary —
  fields + `run`/`editAsync` + session flows land first, the
  warp/wand/compose/gesture methods follow in a second PR before S08. S08
  depends only on the fields + `subscribe`, not on which file every method
  lives in.
