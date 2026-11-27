# S07: EditorController — the state bridge, no React yet (Phase 4)

Anchors are `src/views/editor.ts` lines at commit `11bacb6` unless a file is named
(plan.md › Anchor base): S01–S06 may have moved code, so read
`git show 11bacb6:<file>` and find today's code by the symbol named beside each line.

Path precision: the phase preamble's "session.ts 269" is
`src/editor/model/session.ts` (269 lines; `EditorSession` is imported from there at
src/views/editor.ts:155).

## Goal

Extract the 24 mutable closure vars of `buildEditor()` and all command logic
from `src/views/editor.ts` into a subscribable module-level singleton,
`EditorController`, with zero behavior change and zero React. When this session
ends, the el() DOM build still renders the Editor exactly as today, but it reads
all state from the controller, every command (run/editAsync/gestures/session
flows/save) is a controller method that writes controller state only — never
view DOM — the message row, the active tabs and the other view writes listed in
step 5 are controller state the el() `refresh()` renders, and the hook layer
(`openFileInEditor`/`openThumbnailFileInEditor`/`forgetEditorOrigin`) is installed
at module init, so `forgetEditorOrigin()` works with the view never built.

## Preconditions

- Phases 1–3 landed: S01 (mountView scaffolding, no `<StrictMode>` anywhere in
  `src/`), S02–S03 (shell + mount registry + shared widgets + Settings), S04–S06
  (Pack Manager). The Editor is still the el() view the registry mounts as a DOM
  mount; `src/views/editor.ts` is untouched since 11bacb6 except for whatever
  S02's registry wiring changed at its call site.
- Binding contracts that shape this session: #4 (stores: mutable-snapshot
  pattern, one notify per command, commands outside React), #6 (behavior
  contracts preserved verbatim).
- No React knowledge needed; this session must be reviewable as a pure refactor.

## Files touched

| Path | Status |
|---|---|
| `src/views/editor.ts` (2,951 LOC at 11bacb6) | modified — state + commands move out; the DOM build stays and consumes the controller |
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
   (:1804, `WandPress | null`). Step 5 adds the view-state fields.
2. **The external-store shape** (binding contract #4): `subscribe(listener)`
   over the controller's own listener set, a `version` number, and
   **one notify per command** (plan.md contract #4) — a *command* is a public
   controller method entered from a view event, a keyboard shortcut or an async
   continuation; a command that sets several fields bumps `version` and
   notifies once, at its end (startSession sets several fields and notifies
   once). A depth counter batches nesting: a command called from inside
   another command (setTool inside editText, the tab write inside setTool,
   say() inside anything) only marks the controller dirty, and the outermost
   command's exit notifies once. **The depth bracket covers synchronous code
   only** (plan.md contract #4): it is never held across an `await`, so every
   async continuation — a download progress tick (:2008–2012), editAsync's
   commit, the emoji load's `.then` (:1231–1233), a tab click during a long
   action — is its own outermost command and notifies at once; only an
   action's synchronous prefix nests. Every command that writes a rendered field
   notifies, even where today's code skipped `refresh()` (step 9 lists the
   cases). The one named exception is `run()`: its *own* notifies are exactly
   two — at its start (busy on, after `say("")`) and in its `finally` (busy
   off, its own bracket). The action's synchronous prefix nests inside the
   start bracket; everything after the action's first `await` runs outside
   any bracket, and the notifies those continuations make are theirs, not
   `run()`'s. **Pre-notify step**: before every notify (command exit and
   forwarder alike) the controller runs today's effect-basis check
   (:2360–2366), inside the bracket, before the depth decrement: if `basis` is
   set and `nextEffectBasis(basis, session.doc, session.selection)` is
   `"discard"`, it calls `this.setTool("move")` (nested, so no extra notify; it
   nulls `basis`), else stores the next basis. That check leaves `refresh()` —
   no render or effect ever calls a command.
   Session changes reach the listeners through a controller
   forwarder subscribed to the current session; a session notify that
   arrives inside a command (depth > 0) only marks dirty, one outside any
   command (a stage-driven edit) raises the depth around the pre-notify step,
   lowers it, then notifies once — so the forwarder path never double-notifies.
   It cannot recurse: the nested `setTool("move")` nulls `basis` (Move keeps
   none), and the stage's own `setTool` (stage.ts:468–481) only resets its
   gesture state and redraws — it writes nothing to the session, so no session
   notify re-enters the forwarder. Nor can it read a stale basis: the check
   reads `this.session` at the moment it runs, the session that just notified.
   **Listener order is explicit**:
   the forwarder is (re)subscribed by `attachStage(stage)` — the call the view
   makes right after `new EditorStage(…)`, whose constructor subscribes the stage
   to the session (stage.ts:436) — so on every session change the canvas redraws
   first and `refresh()` measures current content (the invariant commented at
   :1247–1249; `session.subscribe` keeps listeners in a `Set`, session.ts:34, so
   unsubscribe + subscribe moves the forwarder last). Never subscribe the
   forwarder on session identity change alone: that would put it before the
   stage. `attachStage()` is not a command but the stage's lifecycle
   registration (contract #4's lifecycle exception): it bumps `version` and
   notifies — through the same depth counter, so inside startSession it only
   marks dirty — so whatever renders from the stage (crop box, size blockers)
   catches up. `detachStage()` (unsubscribe the forwarder, `stage = null`) is its
   inverse; S08's stage teardown uses it. From S08 on these two are the only
   *notifying* controller calls made synchronously from an effect body (silent
   registrations, pending-value consumes and the immediate `onViewChange` →
   `setZoom` view-channel call aside — plan.md contract #4). This session's consumer is the el() view: `buildEditor()` subscribes
   `refresh` to the controller once.
3. Move the commands to controller methods, bodies verbatim except for the
   allowed changes listed in step 9:
   - `run()` (busy-gate at :1137–1150): `if (busy) return; busy = true;
     stage?.setInteractive(false);` … `finally { busy = false;
     stage?.setInteractive(true); … }` (that order, :1146–1147). Keep the
     read-and-set synchronous in one task (risk #5: rapid double-click must
     still be swallowed). Its `say("")` becomes a controller mutation and its
     `withMessage(message, action)` is replaced by the controller message API
     (step 4) — `run()` never touches view DOM.
   - `editAsync()` with the doc-identity refusal at :1175
     (`if (current.doc !== doc) { … return; }`) copied verbatim.
   - `setTool`, `startSession` (:1207), `endSession` (:1400), `closeThenOpen`
     (:1285), `saveSession` (called via `run(saveSession)` at :347),
     `commitEmoji` (:1057), `stickerLink` (:1079) / `thumbnailLink` (:1108).
   - `freeResize(entered: number)` (:2175) takes the side as a parameter
     instead of reading `sideInput` through `enteredSide()` (:2171); the
     view's Resize click (:340) and Enter key (:671) pass `enteredSide()`,
     which stays in the view.
   - The gesture handlers: `beginWarp`/`continueWarp`/`endWarp` (guard
     `!current || !stage || busy || warp` at :1754), `beginWand`/… (guard
     `!current || !stage || busy || wand` at :1841), `composeShape` (guard
     `!current || busy` at :1814). They stay plain functions — event-driven,
     never effect-driven (binding contract #4).
   - The drag-drop plan handling: `dropPlan(payload.paths, kind, busy,
     dialogOpen())` at :2750 and `handleDrop(plan)`. The webview listener
     (:2741–2754) and `setDropTarget` (:2736–2740, a class write on view DOM)
     stay in the view; its over/enter branch keeps `setDropTarget(!dialogOpen())`
     (:2745).
4. **The message row becomes controller state.** The controller gains message
   fields `{ text, tone, links }` — `tone: "error" | "note"`, `links` the
   `extra` nodes/strings of today's `say(text, tone, ...extra)` (:1045).
   `say()` is rewritten as a controller method: set all three fields, bump,
   notify — it no longer calls `message.replaceChildren` or the `is-note`
   toggle. The `p` at :282 stays el()-owned; `refresh()` renders it from the
   fields (`replaceChildren(text, ...links)`, `is-note` iff `tone === "note"`),
   and that render is its **first** statement, ahead of the no-session
   early return (:2353–2358), so every pass renders the message (the other
   early return, the basis discard at :2362–2365, leaves `refresh()` for
   the pre-notify step, step 2). `say()` nested in a command only marks
   dirty (step 2). `run()`'s
   `withMessage(message, action)` (:1144) becomes the controller message API,
   with today's exact tone rule: `withMessage` writes `textContent` only
   (ui.ts:47 clears, the catch at :51 sets `errorMessage(err)`), so the API sets
   `text` and empties `links` but **never touches `tone`**. An error therefore
   shows in the error tone because `say("")` reset the tone first (the comment
   at :1042–1043) — and an action that called `say(…, "note")` before
   throwing keeps the note tone for its error, exactly as today.
   `clearNote()` (:1132) and commitEmoji's note check (:1068) read
   `tone === "note"` from the controller instead of `message.classList`. No
   command writes message DOM.
5. **View writes leave the commands (D-viewstate, D-stage).** Commands write
   controller state; the el() view renders it. New controller fields:
   - `leftTab` — the active left tool tab. `setTool`'s `showPanel(TOOL_PANEL[next])`
     (:1572), `editText`'s `showPanel("text")` and `panelAfterEdit` (:2049–2050),
     the T shortcut (:2632) and the left tab clicks (`onclick: () => show(name)`,
     :784) all write it through a controller method (initial value "select",
     as :897). `rightTab` likewise for the right tabs' clicks (initial value
     "layers", as :1011). The tab-write method is a command and notifies: a
     tab click or the T shortcut renders at once, as today's direct
     `show()` did; called inside `setTool` or `editText` it nests (depth
     counter), so setTool still renders once. Each write
     also bumps a tab-show counter; `refresh()` calls the tab set's `show(name)`
     (:767) only when that counter moved since its last pass, so `show()` and
     its `afterShow` reveal hooks (:954, :969) run once per write, exactly as
     today's direct calls. The emoji-leaf rule inside `refresh()` (:2374–2379)
     sets `rightTab = "layers"` in place and calls `show` itself, as today.
     Tab state in the controller survives React remounts (S09/S10 rely on it).
   - `emojiDraft` — `commitEmoji(value)` takes the typed value as a parameter
     (the view's blur handler :990 passes `emojiInput.value`, replacing the
     read at :1060) and writes the stored result to `emojiDraft` (replacing
     the write at :1064–1065, same `emoji !== current` check first); the
     render pass writes a pending `emojiDraft` into the input unguarded, as
     :1065 did, then clears it. `commitEmoji` notifies on every path that
     writes `emojiDraft` — including the silent one (no warning, no note to
     clear), where today only the input write ran and no `refresh()` followed.
   - `toleranceValue` — `endWand` sets it (:1900–1901) instead of writing
     `toleranceInput.value`; the render pass applies it only when
     `document.activeElement !== toleranceInput` (the :1901 guard), then clears it.
     `endWand` notifies whenever it set the field — also when
     `g.tolerance === finished.filled` and no `fillWand` follows, where today
     nothing refreshed.
   - The zoom label is view-rendered from the stage's view: `refresh()` writes
     `${Math.round(stage.view().scale * 100)}%` (stage.ts:449), and the
     view-side `onViewChange` handler writes the same text and calls
     `placeTextOverlay(v)` (:1250–1253). No command writes it. Today's
     `refresh()` never writes the label (only :1251 does): the new render
     line is an allowed change (step 9), and S08 removes it from the driver.
   - `cancelDownloadShown` — `ensureBackgroundModel`'s
     `cancelDownloadButton.hidden` writes (:2011, :2022) become this field;
     its direct `saveButton.title` writes (:2000, :2026) get no field of
     their own: :2000 always writes the `downloadNote` set two lines above,
     and :2026 writes what :2465 renders once `downloadNote` is `null`. So
     the render pass computes Save's title from `downloadNote`, keeping the
     tick's precedence: `blockedTitle(saveStem, downloadNote ?? saveReason,
     saveTitle())` — the download note ahead of a canvas reason (the tick's
     `blockedTitle(saveStem, downloadNote, …)`), where :2465 had
     `saveReason ?? downloadNote`; the two differ only while a download
     runs, and the tick's order is what the owner sees today. Ordering:
     `reportProgress` (:1998–2000) calls `say()` before writing the title;
     `say()` now nests inside the tick's one notify, so the render sees the
     note, the message and the title together — never a stale title.
     Caveat for review: those writes were direct "rather than refresh()"
     because a progress tick is too frequent for a full pass (:1994–1996);
     now each tick notifies and runs `refresh()`. Measure a
     real download; if the pass is too slow, the tick may update only the
     message, Save's title and this field — record the choice in the PR.
   - **The stage is built by the view, not by a command.** `startSession`
     (:1207) keeps its field writes and session creation, then emits a
     synchronous controller *session-start* event; the el() view's handler runs
     today's :1235–1253 sequence: `refresh()` (show the workspace so the stage
     measures), `new EditorStage(canvasHost, session)`, the setters and
     callbacks (:1237–1245, wired to controller methods),
     `controller.attachStage(stage)` (sets `controller.stage` and subscribes the
     forwarder after the stage, step 2; a lifecycle registration, not a
     command, and inside startSession's bracket, so no notify of its own), `onViewChange`. startSession's single
     end notify is the "place the crop box overlay" refresh (:1246).
     `endSession` emits a synchronous *session-end* event at the point of
     today's `textOverlay.close()` (:1409); the view's handler closes the
     overlay (`TextEditOverlay` stays view-owned). `stage?.destroy(); stage =
     null` stay in `endSession`.
6. Move the `EffectPreview` instance (`new EffectPreview<EffectResult>(…)` at
   :416) and its show callback into the controller. **No closure may capture a
   stage instance**: the show callback reads `controller.stage` dynamically, so
   a preview survives a stage rebuild.
   **The EffectControls seam.** Moved commands read and write the view's
   `EffectControls` island: `previewRequest()` reads `effectControls.effect(kind)`
   (:1682), `beginWarp` reads `effectControls.warp` (:1763), `endWarp` calls
   `effectControls.setWarp(…)` (:1790). The island stays view-built (`new
   EffectControls(…)`, :405); right after constructing it the view registers
   a port, `controller.attachEffectControls({ effect: (k) =>
   effectControls.effect(k), warp: () => effectControls.warp, setWarp: (w) =>
   effectControls.setWarp(w) })`, the way `attachStage` registers the stage
   (not a command: no notify). The commands call `this.effects.effect(kind)`,
   `this.effects.warp()`, `this.effects.setWarp(…)` — no command holds the
   view's instance, and the settings stay where EffectControls keeps them
   (no mirrored copy to drift). The el() build registers it once; S08's lazy
   build keeps that one instance, so the port survives remounts.
   **The `change` callback becomes a command.** Today's `change: () =>
   refresh()` (:406) becomes `change: () => controller.effectSettingsChanged()`:
   a notifying command with no body beyond the bump (the settings live in
   EffectControls, read through the port). From S08 on, `setBrushRadius`,
   `effectControls.update` and `preview.request` run in version-keyed
   effects, so a slider change must bump the version or they go stale; S08
   adds the `warpRadius` write to this command's body.
7. Re-point the hook layer (:2812+): `openFileHook` (assigned at :2759),
   `openThumbnailHook`, `forgetOriginHook` (:2769–2777: `origin = { …origin,
   otherLibrary: true }`, same for `thumbnailOrigin`, `emoji?.forgetOrigin()`,
   `libraryGeneration++` — then one notify; the trailing `refresh()` at :2776
   is dropped, since a notify with no subscriber is a no-op and `refresh()` runs
   only when a view exists, subscribed by `buildEditor()`) become thin module
   functions delegating to controller methods. Install them at module/controller
   init, **not** inside `buildEditor()`, so `forgetEditorOrigin()` works with the
   view never built (risk #3: the `root ??=` module cache is replaced by the
   controller). `renderEditor()` stays a lazy builder with no mount side effect:
   `openFileInEditor`/`openThumbnailFileInEditor` keep calling it (:2852,
   :2866) — no longer load-bearing for hook installation, but it still builds
   the view (and so the session-start handler) before `showEditor()` runs.
   Document `startSession`'s preserved invariant: "showEditor() runs before the
   file opens, so the canvas can measure".
8. Rewrite `refresh()` (:2323–2577) in place in `src/views/editor.ts` to read
   `controller.*` instead of closure vars; it remains the el() view's single
   render pass. The `refresh()` call sites that sat inside moved command code
   disappear into the command's one notify; call sites in view-local DOM
   handlers keep calling `refresh()` directly. Either way, every old call site
   must still produce exactly one synchronous render before control returns —
   the mapping of all 18 real call sites is the S12 audit checklist (27
   `refresh()` occurrences at 11bacb6 = 18 call sites + 8 comment mentions (:305,
   :338, :342, :908, :1248, :1358, :1996, :2024) + the definition at :2323;
   plus the `session.subscribe(refresh)` wiring at :1249, which the grep misses —
   map it too). Record the mapping as a table in the PR description: it is a
   review-cycle artifact (reviewers check it) and S12's audit input.
   The rewritten `refresh()` calls no command: the basis-discard block
   (:2360–2366) is the controller's pre-notify step now (step 2), so the
   pass renders `basis` and `tool` as already settled, and the S08 driver
   inherits no `setTool` call.
9. **Allowed changes — everything else moves character-identical.** The moved
   bodies may differ from 11bacb6 only by:
   - closure-var reads/writes becoming controller fields (`busy` →
     `this.busy` or equivalent), and calls to moved functions becoming
     controller method calls;
   - `say()`'s body (step 4) and `run()`'s `withMessage` → message API (step 4);
   - `refresh()` calls inside commands replaced by the command's single end
     notify (step 2), and the trailing `refresh()` of `forgetOriginHook`
     (:2776) dropped (step 7);
   - the view writes of step 5 (`showPanel`/`showRightTab`, `emojiInput.value`,
     `toleranceInput.value`, `zoomLabel.textContent`,
     `cancelDownloadButton.hidden`, `saveButton.title`) replaced by field writes,
     and the stage build / `textOverlay.close()` moving to the view's
     session-start/session-end handlers;
   - `commitEmoji` gaining its `value` parameter and `freeResize` its
     `entered` parameter (step 3); the `effectControls.*` reads/writes of
     `previewRequest`/`beginWarp`/`endWarp` going through the
     `attachEffectControls` port, and EffectControls' `change` callback
     calling `effectSettingsChanged()` instead of `refresh()` (step 6);
   - notifies where today's code skipped `refresh()` (contract #4: every
     command that writes a rendered field notifies): `endWand`'s
     tolerance-only path (`g.tolerance === finished.filled`), `commitEmoji`'s
     silent path, the tab-write method (tab clicks, the T shortcut),
     `attachStage` (a lifecycle registration, not a command), and the depth counter that batches nested commands;
     `run()` notifying at its start and in its `finally`;
   - the effect-basis discard block (:2360–2366, `nextEffectBasis` →
     `setTool("move")` or `basis = next`) moving from `refresh()` into the
     controller's pre-notify step (step 2), body otherwise verbatim; its
     early `return` is gone from `refresh()` (the pre-notify `setTool` runs
     before the one notify, so the pass always sees the settled tool);
   - `refresh()` rendering the message and the step-5 fields, including the
     new zoom-label line and Save's title from `downloadNote ?? saveReason`
     (step 5);
   - `export` added to the six `confirm*` helpers in editor.ts (`confirmScaleToFit`,
     `confirmDiscard`, `confirmCloseOriginGone`, `confirmWebp`, `confirmGiveUp`,
     `confirmModelDownload`; bodies :2872–2947 untouched), because their callers
     (:1190, :1382, :1393, :1442, :1558, :1993) move into the controller. `isSaveShortcut` stays unexported
     until S08 moves its callers.
   Any other changed expression, guard, guard order or string is a review finding.
10. If `editor-controller.ts` would exceed ~600 LOC, split command methods into
    `src/editor/app/commands.ts` (mixed into the controller or free functions
    taking the controller) — phase-file rule, not a design choice.
11. **Land per plan.md › Session protocol**, with this session's checks: the
    CSS byte-identity check, the step-8 mapping table in the PR description,
    and the checklist below.

## Deliberately out of scope

- React, JSX, new deps, any DOM markup/class/title/attribute change, any
  behavior change at all — this session is a zero-diff-behavior refactor.
- The imperative islands (`stage.ts`, `text-edit.ts`, `eyedropper.ts`,
  `warp-brush.ts`, `effect-preview.ts`, `effect-controls.ts`,
  `font-picker.ts`, `save-dialog.ts`, `actions-list.ts`, `reveal.ts`,
  `download-text.ts`, `lasso.ts`) and all `src/editor/model/*` files, `save.ts`,
  `geometry.ts` — reused verbatim, never rewritten.
- All five CSS files (byte-identical), the Icons rule, the UI-audience rule.
- The `viewTransform` cache and `warpRadius` field (S08).

## Exit criteria

- `bun run build` + `bun test` pass.
- All five CSS files byte-identical (`git diff --stat <session base> -- 'src/**/*.css'` empty, per plan.md › Session
  protocol step 3; the files and counts are plan.md's Hard constraints).
- Grep proves no `let` state remains inside `buildEditor()` except purely-local
  DOM-build temporaries.
- The race guards are character-identical in the controller: `run()`'s busy-gate
  + `stage?.setInteractive` (finally order `busy = false` then
  `setInteractive(true)`), `editAsync`'s `current.doc !== doc` refusal,
  `beginWarp`/`beginWand`'s busy/active guards and `composeShape`'s `busy` guard.
- One notify per command (contract #4): each outermost command notifies
  exactly once at its exit; nested commands (depth > 0) never notify; `run()`'s
  own notifies are exactly two (start, `finally`). The bracket is never held
  across an `await`: a unit check runs an action that awaits, then fires a
  continuation mid-run (a progress tick, an editAsync commit, a tab click) and
  sees each notify at once, while the action's synchronous prefix adds none. A
  unit check counts notifies for
  setTool (1, its tab write nested), a tab click (1), the T shortcut (1), a
  silent `commitEmoji` (1), `endWand` with an unchanged fill (1),
  `effectSettingsChanged` (1), a stage-driven session notify through the
  forwarder whose basis discards (1, its `setTool` nested) and
  `attachStage` (1 outside a command, 0 inside startSession).
- Manual: during a background-model download (first Save that needs it),
  each progress tick renders immediately in the message row and Save's title.
  Dragging an Outline/Glow slider re-renders the preview as today.
- The basis discard lives only in the pre-notify step: grep shows no
  `setTool(` and no `nextEffectBasis(` in `refresh()`, and no command is
  called from `refresh()`. Manual: with Outline active, undo or pick another
  layer — the tool drops to Move and its tab surfaces in one pass.
- Listener order: after `attachStage`, the session's listener set holds the
  stage's listener before the controller forwarder (unit check or a temporary
  assertion).
- Hook layer headless: `forgetEditorOrigin()` mutates controller state and
  notifies without a built view (manual: re-point Library from Settings before
  ever opening the Editor, then open it — the Emoji box and save dialog reflect
  the forgotten origin). With a view, the same notifications drive `refresh()`
  exactly as today.
- No command writes view DOM: grep the controller for `message.replaceChildren`,
  `message.textContent`, `message.classList` (not bare `message.`, which
  matches the controller's own `message` field), `emojiInput`,
  `toleranceInput`, `sideInput`, `effectControls`, `zoomLabel`, `showPanel`,
  `showRightTab`, `canvasHost`, `textOverlay`, `cancelDownloadButton`, `saveButton` — none. The error/note tones, `clearNote`'s note-only rule
  and `withMessage`'s text-only routing behave exactly as today.
- Windows checklist (below) passed.
- PR merged with `gh pr merge <N> --merge`.

## Review-cycle coverage

- Every moved body is a verbatim move except step 9's allowed changes: diff
  hunks should show pure relocation; flag any other changed expression, guard
  order, or error text.
- No DOM diff: the built view's classes/titles/text must be unchanged — compare
  a DOM snapshot or rely on the line-by-line diff of the build section.
- The busy-gate and doc-identity guards survive with their exact semantics
  (no `?.` where there was `!`, no inverted conditions, `run()`'s finally order).
- Hook installation moved out of `buildEditor()` without changing the
  ask-then-show-then-open ordering documented at :2840–2850.
- Comments recording owner decisions moved with their code.
- The message-state move: `say()`/`withMessage` semantics unchanged (error
  tone, note tone kept by a post-note error, the `say("")` clear before an
  action, `clearNote`'s note-only rule); the message renders ahead of
  `refresh()`'s early returns.
- Tab writes: `show()`/`afterShow` fire once per tab write, never on a pass
  without one.
- The refresh() call-site mapping table in the PR description is complete.

## Owner / Windows checklist

(Pre-React smoke; behavior must be *identical*.)
1. Open an image; drag/transform a layer; add text via the overlay.
2. Rect-cut + paste; wand with Shift and with Alt drag; warp drag; Apply
   outline to text.
3. Save as a new sticker; save-thumbnail.
4. Close with unsaved changes (confirm the discard question).
5. Switch tabs and back — session and pixel state unchanged.
6. Rapid double-click any toolbar action — only one run (busy-gate).
7. Tool switching surfaces its left tab (incl. T and editing a text layer);
   a wand drag that changes tolerance updates the tolerance field; an emoji
   commit shows the stored string.

## Risks and fallbacks

- **`root ??=` semantics replaced by the controller** (phase risk #3): hooks
  must work headless; mitigated by installing hooks at module init and testing
  the Settings re-point path before the Editor is ever shown.
- **`run()` busy-gating** (phase risk #5): synchronous read-and-set in one
  task; commands stay outside any render cycle; rapid-double-click is in the
  checklist.
- **Effect cleanup cancels what today always finishes** (phase risk #1): no
  effects exist yet in this session — verify no moved code introduced a
  callback that could now be dropped (e.g. the EffectPreview show callback).
- Fallback if the session overruns: split at the gesture-handler boundary —
  fields + `run`/`editAsync` + session flows land first, the
  warp/wand/compose/gesture methods follow in a second PR before S08. The
  exit criteria that move with them to the second PR: `endWand`'s
  `toleranceValue` write and its unchanged-fill notify count (1), the
  `toleranceInput` grep, and the `attachEffectControls` port reads in
  `beginWarp`/`endWarp` (with the `effectControls` grep over those methods);
  the first PR still lands the port itself and `previewRequest`'s read. S08
  depends only on the fields, `subscribe`/`attachStage` and the session events,
  not on which file every method lives in.
