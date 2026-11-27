# Phase 4: Editor (5–6 sessions — S07–S12)

Drafted by planning subagent; structure verified at HEAD (editor.ts 2,951 LOC,
`buildEditor()` :234, `refresh()` :2323, hook layer :2812+ with `setEditorNav` :2827,
`openFileHook` assignment :2759, `markStickerFileChanged` :1539 / `markThumbnailChanged`
:1501, 88 `el(` sites; stage.ts 1,286; effect-controls.ts 346; save-dialog.ts 301;
actions-list.ts 159; effect-preview.ts 124; text-edit.ts 130; lasso.ts 138;
font-picker.ts 59; warp-brush.ts 51; eyedropper.ts 39; reveal.ts 24; session.ts 269;
save.ts 236). Session plans: S07–S12 under [../sessions/](../sessions/).

**Goal.** Convert the Editor view from a built-once `el()` closure knot into a React 19
component tree over the existing `EditorSession` external store, keeping all five CSS
files byte-identical and emitting the exact same class names, titles and DOM shape.
The Konva stage and the other imperative islands stay vanilla. The Editor keeps its
defining semantics: the session survives tab switches and re-boots, one session at a
time, and the race-shaped guards (busy-gating, stale-snapshot refusal, mid-drag
gesture state) are preserved *without adding cancellations that don't exist today*.

**Definition of done.** `src/views/editor.ts` no longer builds DOM (keeps only the
mount entry, hook layer and `confirm*` helpers, < ~400 LOC); the view mounts via
mountView() as a React root; all editor state lives in the subscribable controller;
build + tests pass; CSS byte-identical; the owner's Windows checklist passes. All 16
`src/editor/model/*` files, `save.ts`, `geometry.ts`, `lasso.ts`, `warp-brush.ts`,
`reveal.ts`, `effect-preview.ts` reused verbatim (never rewritten).

**Preconditions.** Phases 1–3 landed (mountView registry, shell converted, Pack
Manager converted, dialog/combobox binding contracts). The editor branch of `show()`
(shell.ts:83 `content.append(renderEditor())`) stays callable until S08 changes it last.

## Store & architecture decisions (bind all Editor sessions)

- **`EditorController`** — new module-level singleton (`src/editor/app/editor-controller.ts`,
  plus `src/editor/app/commands.ts` if the file would exceed ~600 LOC) owning the ~24
  mutable closure vars of `buildEditor()` (25 listed in early drafts; 24 measured:
  tool, overlayLayerId, fonts, fontsProblem, nextStyle, lastFormat, freeSide, origin,
  thumbnailOrigin, libraryGeneration, emoji at :238-269; warp :433, basis :437,
  brushSize :577, tolerance :593, feathered :622, downloadNote :635, emojiLeafHidden
  :912, wand :1804) plus S07's view-state fields (message `{ text, tone, links }`,
  `leftTab`, `rightTab`, `emojiDraft`, `toleranceValue`, `cancelDownloadShown`;
  Save's download title renders from `downloadNote`) and S08's `viewTransform` (pan/zoom cache), `warpRadius` and `zoom`
  (own `subscribeView` set, so pan frames never bump the version). External store:
  `subscribe(listener)` over the controller's listeners, with session changes forwarded
  by a forwarder that `attachStage(stage)` (re)subscribes right after the stage's own
  session listener — so the canvas always redraws first; one notify per command (a
  command setting several fields notifies once, at its end; nested commands batch
  under a depth counter that covers synchronous code only, never held across an
  `await`, so every async continuation — a progress tick, editAsync's commit, a
  `.then`, a tab click mid-run — is its own outermost command; `run()`'s own
  notifies are exactly two, at start and in its `finally`; `attachStage()` /
  `detachStage()` are not commands but the stage's lifecycle registration —
  `attachStage()` notifies — and the only controller calls made synchronously
  from an effect body; EffectControls' `change` callback is the notifying
  `effectSettingsChanged()` command from S07; per plan.md contract #4); components
  read via `useSyncExternalStore(subscribe, () => controller.version)` — the accepted
  mutable-snapshot pattern. **No closure may capture a stage instance**: every stage
  reference goes through `controller.stage` (EffectPreview's show callback reads the
  *current* stage so a preview survives a stage rebuild).
- **Commands stay outside React.** `run()`, `editAsync()`, the gesture handlers
  (beginWarp/continueWarp/endWarp, beginWand/…, composeShape), startSession/endSession,
  saveSession and the open/close flows are controller methods — event-driven, never
  effect-driven, so no effect cleanup can ever abort a pending `editAsync` or an
  in-flight wand fill. `editAsync`'s `current.doc !== doc` identity refusal copied
  verbatim.
- **`refresh()` (:2323-2577) dissolves by ownership**: toolbar labels/disabled/titles →
  Toolbar; tools-panel state + `effectControls.update()` + `preview.request()` →
  ToolsPanel's post-render `useLayoutEffect`; layers/actions/emoji → RightPanel;
  `stage?.setCropBox`/`setBrushRadius` → CanvasPanel's layout effect (from S08);
  the effect-basis discard (:2360-2366, `setTool("move")`) → the controller's
  pre-notify step (S07), so no render or effect ever calls a command.
  "Canvas redraws first, then the panels measure" is held by subscription order (the
  stage's session listener precedes the controller forwarder; React's re-render is
  only scheduled inside the notify) and, within a commit, by child layout effects
  (CanvasPanel's version-keyed setters) running before the parent's (EditorApp's
  driver); the stage itself is built in CanvasPanel's passive effect, after those
  layout effects, and `attachStage()`'s notify drives a catch-up commit before
  paint (S08 step 3) — never by tree
  order: the workspace keeps today's DOM order toolsPanel, canvasHost, layersPanel
  (:1025; `.editor-workspace` is a plain flex row, editor.css:324-329).
- **The message row and the S08–S11 strangler seam**: the message row is controller
  state from S07 (`say()` becomes mutation+notify with the message DOM rendered from
  state); `EditorApp` derives the empty/workspace visibility from session presence;
  during S08–S11 the un-ported `refresh()` sections run from a single `EditorApp`
  `useLayoutEffect` keyed on `controller.version`, each port session (S09/S10/S11)
  removing its own section, S12 deleting the remainder. No code path may write DOM
  React owns.
- **Imperative islands — wrap vs port:**

| Module | Decision | Reason |
|---|---|---|
| stage.ts (1,286) | **Wrap** — useRef + useEffect keyed on session identity | Gesture/pixel half is not declarative diffing; porting is pure regression risk. One allowed addition: a view-restore setter (S08). |
| text-edit.ts (130) | **Wrap** — owned by CanvasPanel | Focus/select/fit placement while typing is imperative; React would re-fight focus every render. |
| eyedropper.ts (39) | **Keep as-is** — ref-embed for React text controls and vanilla EffectControls | Porting would fork it; 20 lines, single source of the §2 strings. |
| warp-brush.ts (51) | **Untouched** — controller-owned gesture state | Pure pixel working copy; never touches app DOM. |
| effect-controls.ts (346) | **Wrap** — blocks embedded at their slots; `update()` from ToolsPanel's layout effect | Slider wheel/typed-commit/blur contracts and never-clobber-while-typed sync are hand-tuned behavior a port would drift. |
| effect-preview.ts (124) | **Untouched** — controller-owned | No-Konva/no-DOM already; React never sees it. |
| actions-list.ts (159) | **Split**: `actionList()` builder + `revealCurrentAction()` verbatim; `renderActionList()` ports to JSX | Pure replaceChildren list — the ideal React port. |
| font-picker.ts (59) | **Wrap** via ref-embed (binding contract #2: combobox swap is optional post-adoption, never an exit criterion) | Combobox keyboard contract is fragile; don't port it twice. |
| save-dialog.ts (301) | **Keep imperative** by default; S11 decides at its start, before wiring the save flows, and ports to `<SaveDialog/>` (via the dialog bridge) only if trivial — the decision recorded in S11's PR | A transient modal over the shared dialog contract + packPicker; its focus/keyboard rules belong to the dialog layer. |

- **Component tree (~8)**: `EditorApp` (root; message row, empty state, workspace
  skeleton) · `Toolbar` · `ToolsPanel` (left tabs; embeds EffectControls blocks + text
  controls) · `CanvasPanel` (stage ref leaf + text overlay + drop target) ·
  `StatusStrip` (readout, zoom, Reset view, dirty dot; S09) · `LayersPanel` ·
  `ActionsPanel` · `EmojiPanel` · `SaveDialog` (contingent). New files under
  `src/views/editor/`, importing the `ImperativeNode.tsx` ref-embed helper S08 creates
  in `src/react/`. `src/views/editor.ts` stays the module entry — `renderEditor()`, the hook
  layer (`openFileHook`/`openThumbnailHook`/`forgetOriginHook`/`setEditorNav`) and the
  `confirm*` helpers stay exported there so the pack-manager call sites are untouched
  (the shell's editor branch changes one line in S08; `renderEditor()` stays a lazy
  builder with no mount side effect).
- **No `<StrictMode>`** anywhere in `src/` (binding contract #3); StrictMode-safety is
  a follow-up, not an exit criterion.

## S07 (4.1) — EditorController: the state bridge, no React yet (1 session)

The single riskiest move, isolated with zero behavior change.

**Touches**: `src/views/editor.ts` (state + commands move out; the DOM build stays and
consumes the controller), new `src/editor/app/editor-controller.ts` (+ `commands.ts`).
Nothing under `src/editor/model/`, `src/editor/view/`, or any CSS file.

**Builds**: the singleton store; all ~24 closure vars become controller fields; `run`,
`editAsync`, `setTool`, `startSession`, `endSession`, the warp/wand/compose gesture
handlers, `saveSession`, `commitEmoji`, `stickerLink`/`thumbnailLink` generation, and
the drag-drop plan handling become controller methods that write controller state
only, one notify each; the view writes inside them (message row, tab surfacing, the
emoji and tolerance inputs, zoom label, download button/title) become view-state
fields the view renders; the effect-basis discard moves from `refresh()` into the
controller's pre-notify step (inside the bracket, before the decrement, the session
forwarder raising the depth around it); EffectControls is reached through a registered
port, its `change` callback becoming the notifying `effectSettingsChanged()` command,
and `freeResize` takes the side as a parameter; the stage is built by the el() view on a synchronous
session-start event and `attachStage()` subscribes the session forwarder after it;
the EffectPreview instance and its show callback (reading `controller.stage`
dynamically) move in; the hook layer at :2812+ is installed at module init so
`forgetEditorOrigin()` works with the view never built; `renderEditor()` stays a lazy
builder that `openFileInEditor` keeps calling. `refresh()` remains the el()-view's
single render pass, now reading the controller.

**NOT**: React, JSX, new deps; any DOM markup/class/title/behavior change; islands or
model code.

**Exit criteria**: build + tests pass; CSS byte-identical; grep proves no `let` state
remains inside `buildEditor()` except purely-local DOM-build temporaries; the race
guards character-identical in the controller (`run()`'s busy-gate +
`stage?.setInteractive`, `editAsync`'s doc-identity refusal, `beginWarp`/`beginWand`'s
busy/active guards, `composeShape`'s busy guard); one notify per command (`run()`'s
own: start and `finally`; the bracket never held across an `await`, so a progress
tick during a save renders immediately); `refresh()` calls no command. Land per
plan.md › Session protocol; Windows smoke test: open an image,
drag/transform, add text, rect-cut + paste, wand Shift/Alt drag, warp drag, Apply
outline to text, save new sticker, save-thumbnail, Close with unsaved changes, switch
tabs and back — session and pixel state unchanged (pre-React, behavior must be
*identical*). PR merged with `gh pr merge <N> --merge` after the check passes.

## S08 (4.2) — React root + CanvasPanel: the Konva bridge (1 session)

**Touches**: `src/views/editor.ts` (the canvas-host/listener/overlay code of
`buildEditor()` deleted; `renderEditor()` stays a lazy builder with no mount side
effect), `src/shell.tsx` (editor branch of `show()`, one line: the registry mounts the
Editor only on navigation), new `EditorApp.tsx`, `CanvasPanel.tsx`, new
`src/react/ImperativeNode.tsx` (the ref-embed helper); controller (`viewTransform`
cache, `warpRadius`, `zoom`); `src/editor/view/stage.ts` — one small addition only: a
restore setter for pan/zoom (the getter `view()` exists, stage.ts:449; today an
unmount would silently reset the view to fit).

**Builds**: `EditorApp` subscribes and renders the still-imperative toolbar/panels
through `ImperativeNode` (strangler inside the view: one session, one converted panel).
`CanvasPanel` owns `canvasHost`, the useRef + useEffect keyed on session identity that
builds `new EditorStage(canvasHost, session)`, wires the stage callbacks to controller
methods, restores the cached view transform, and re-asserts everything startSession
set (:1237-1253: guides, tool, the callbacks, `setBrushSize`) plus
`setInteractive(!busy)`, `setBrushRadius` and the in-flight EffectPreview override;
a separate version-keyed layout effect owns `setCropBox`/`setBrushRadius`, and
`attachStage()`'s notify re-runs it once the stage exists (`attachStage`/`detachStage`
in the stage effect are contract #4's lifecycle exception; the handlers it registers
are event paths); the message row's `links` nodes render through interim
`ImperativeNode` embeds until S11's links-as-data; the cleanup saves the
view transform only on a same-session unmount and is the stage's one destroy
(`endSession` only detaches). The workspace keeps today's DOM order; the
canvas-first redraw comes from subscription order. The document-level
keydown/keyup/paste listeners (:2597-2734) become a mount `useLayoutEffect` with the
same keydown guard ladder (Ctrl+S preventDefault → the no-session return → Alt
suppression → `textOverlay.isOpen` → busy/downloadNote → isTextTarget → pick/lasso
keys → `shortcutOf` → undo/redo/save/cut/Esc-cascade/Delete, in that exact order;
`view.isConnected` drops out because a listener exists only while mounted; if the
session overruns, the ladder may slip whole to S09's contingent step 0, its
`view.isConnected` checks pointed at EditorApp's `.view` element via a ref); the
drag-drop registration awaits its unlisten promise in cleanup and the drop outline
becomes state (on overrun this may slip to S09's contingent step 0b). The text overlay keeps today's commit-on-blur: an unmount cleanup only
blurs a still-open overlay so its own blur handler commits, and never calls `close()`
on it; session end closes it without commit, as today.

**NOT**: port any panel markup; touch `dialogOpen()` gating semantics; change stage
gesture code beyond the view-restore addition.

**Exit criteria**: build/tests pass; CSS byte-identical; a mid-drag warp/wand/erase
tab-switch and back shows the session intact, the stage rebuilt, pan/zoom restored,
undo trail intact, no stroke cancelled by cleanup; Ctrl+S/V/X, Alt suppression, Esc
cascade and `strokeInProgress()` save-refusal behave as before; a mid-typing tab switch
commits the text overlay, never eats it; the crop box and the sizing buttons are
right on the first paint after open and after a remount; workspace DOM order unchanged and the
stage's session listener precedes the controller forwarder after a remount; one
drag-drop handler after repeated remounts. Windows check: all tool gestures; zoom/pan
persists across tab switch; Alt press/release does not flip zoom or open the system
menu; AltGr still types; Ctrl+S refused mid-stroke with the reason; drag an image file
from Explorer onto the empty editor and onto an open session; type in the overlay while
panning. PR merged with `gh pr merge <N> --merge` after the check passes.

## S09 (4.3) — Toolbar + ToolsPanel + status strip + effect controls embed (1 session)

**Builds**: toolbar top row (Undo/Redo | Fit/Cover/Long side | side kind, side
input, Resize | Guide/Crop | Save…/Close, :690-724) with every SPEC §2 blocked-title
rule from `refresh()` (Open image is the empty state's, S08; Add is a Layers-grid
cell, S10); the status strip as `StatusStrip` (readout, zoom from `controller.zoom`,
Reset view, dirty dot);
the left tab set (select/paint/effects sections rendered from `controller.leftTab`,
the TOOL_PANEL surfacing written by the commands; the canvas tool buttons; the text
section embedded whole until S11 ports it);
a contingent step 0 moving the keyboard ladder first if S08 slipped it (then
StatusStrip slips to S10, pre-authorised), and a contingent step 0b turning
`setDropTarget` into EditorApp state if S08 slipped the drop target; Toolbar and
ToolsPanel render `hidden` with no session (:2327, :2329); the one EffectControls instance built by
`renderEditor()`'s lazy builder (attached to the controller at build) and passed to
ToolsPanel as a prop, its blocks embedded at their slots via `ImperativeNode`, with a
post-render `useLayoutEffect` running the effect section of the old `refresh()`
(effectControls.update, preview.request; the stage setters setCropBox/setBrushRadius
stay CanvasPanel's, from S08). The side input stays uncontrolled and is never
written; the tolerance input keeps its `document.activeElement` guard (:1901) for
`controller.toleranceValue`; the embedded text section keeps its
`leftTabs.section` attributes and toggles `hidden` on the section itself.

**NOT**: port EffectControls internals, the FontPicker (imperative embed in the text
section until S11), or the eyedroppers.

**Exit criteria**: build/tests pass; CSS byte-identical; every class string and title
of the old toolbar/tools-panel markup appears identically in the new tree (the old
el() code in git history is the spec — port line-by-line); sizing-tool blockers
(`sizeToolBlocker` with `stage.contentBounds()`), tool-tab surfacing, effect
slider/wheel/typed commits, Apply/Cancel (incl. Outline-on-text restyle vs
Glow-on-text bake) behave as before; grep shows the toolbar/tools-panel/status-strip
el() builds and their driver sections gone (incl. `toolbar.hidden`, `toolsPanel.hidden`);
if step 0 fired, S08's Alt/Ctrl checks re-run here; if step 0b fired, no
`setDropTarget` or `drop-target` classList write remains anywhere in `src/`
(the slipped one sits in EditorApp.tsx's drag-drop effect). Owner tests: hover a sweep of disabled controls
(SPEC §2 reasons in titles); the four sizing tools' enable rules at odd sizes; effect
sliders by drag, wheel-hover and typing (invalid reverts, Esc reverts + blurs);
Apply/Cancel on raster vs text layers. PR merged with `gh pr merge <N> --merge` after
the check passes.

## S10 (4.4) — Right panel: Layers, Actions, Emoji (1 session)

**Builds**: the right tab row (shown tab = `controller.rightTab`, so it survives
remounts); the layers list + the action grid (the Layer-actions cells Add/Delete/Move
up/Move down/Merge with their disabled/title rules) + `layerHint`; reveal-on-render and
reveal-on-tab-show (`afterShow` hooks become effects on tab show — the hidden-tab
no-layout rule preserved); the Actions list as JSX (current badge, nested Select
steps, the blank striped fill, terminal-tail reveal); the Emoji panel (Enter/blur
commit through `controller.commitEmoji(value)` + `emojiDraft`, warn-only validation,
blocked-box reason tooltip, thumbnail-mode leaf hiding with the reset-to-Layers rule,
which moves from `refresh()` into the controller's pre-notify step, guarded on
`session !== null` as today's no-session return guards it); the panel hidden
with no session; the right-panel section (incl. `layersPanel.hidden` and the
counter-driven right-tab `show()`) leaves EditorApp's interim refresh driver, and
S07's tab-show counter goes with it (the tab-show reveal keys on `rightTab` switches).
If S09 slipped StatusStrip, S10 ports it first as a contingent step 0 (S09's spec;
its driver lines and the lazy build's zoom-label subscription go with it); the strip
never slips twice, so an S10 overrun slips EmojiPanel instead. Under that slip S10's
RightPanel still renders the emoji `<section>` itself (`hidden` from `rightTab`) and
embeds only the label/textarea/hint el() nodes through three `ImperativeNode`
embeds, one per node (never one wrapper: the tabpanel's flex gap must hold); the
emoji driver lines stay until S11's step 0 ports `EmojiPanel` and deletes both.

**NOT**: make the Actions rows interactive (still read-only); change
focus-preservation semantics (the emoji input keeps its activeElement sync guard).

**Exit criteria**: build/tests pass; CSS byte-identical; the Actions list renders
identically to `renderActionList` (a `renderToStaticMarkup` test over model fixtures,
S10 step 4); layers reveal never nudges an in-view row
(`revealRow`'s 0.5px rule intact); emoji commit writes through `SessionEmoji` exactly
as before. Owner tests: Layers reveal on select from far down the stack; Actions
current-badge follows undo/redo; the lined-paper fill; emoji box Enter commits and
hands focus back, >20 warns without blocking, blocked box shows its reason; a
Thumbnail session hides the Emoji leaf and lands on Layers; Actions tab, Close, open
another Thumbnail — still on Actions.

## S11 (4.5) — Text controls, SaveDialog, origin/Library flows (1 session)

**Builds**: the text tool controls (font-size/color/outline inputs, eyedropper
embeds; FontPicker stays an embed); the save flows end-to-end: sticker save (replace
origin / new + pack picker), thumbnail save, PNG-over-cap WEBP offer, exhausted
give-up question, `originAfterSave` re-point, saved-note links with the
`libraryGeneration` guard (the message row's `links` become data carrying the
save-time generation — a controller change), `forgetEditorOrigin()` while the editor is *unmounted*
(Settings re-point path: the controller must mutate and the remounted view must show
the disabled Emoji box and refused Replace at once); the text section leaves
EditorApp's interim refresh driver, together with S09's text-section scaffolding
(the `leftTabs.section("text", …)` builder and ToolsPanel's `hidden` write) and
S08's interim `ImperativeNode` embed for message-row link nodes. The SaveDialog decision comes first, before the
save flows are wired: keep save-dialog.ts imperative by default (contract #2's island
reasoning), port to `SaveDialog.tsx` via the bridge only if trivial — recorded in the
PR description either way. An S10 EmojiPanel hand-off lands as S11's step 0; it
also means S10 did not land clean, so it rules out absorbing S12.

**NOT**: change `save.ts`, save-dialog wording, or the pack picker (Phase 3 surface).

**Exit criteria**: build/tests pass; CSS byte-identical; the full save matrix behaves
as today (new/replace/gone-origin/thumbnail/declined/exhausted), incl. `lastFormat`
persistence and `markSaved` only when `current.doc === doc` (defence-in-depth kept);
library re-point invalidation shows all three symptoms (save-dialog refusal wording,
emoji box blocked reason, note links reporting gone) with the Editor on screen and
off screen. Windows check: the save matrix incl. PNG over cap → WEBP offer → exhausted
give-up; saved-note links navigate to the Pack Manager; after a Settings re-point they
report gone.

## S12 (4.6) — Consolidation: sweep, race audit, Windows check (1 session; absorbs into S11 if S07–S10 each landed clean per plan.md › Clean landing, decided at S11's start — the 5-vs-6 swing)

**Touches**: `src/views/editor.ts` (final deletion of the el() build path; the file
keeps only the mount entry, hook layer and `confirm*` helpers), any residue.

**Builds**: the closing audit against a written checklist: (1) no effect owns a
gesture/`editAsync` lifetime and no cleanup cancels a command; (2) the stage effect's deps are exactly session
identity; (3) no closure captured a stage instance (grep `controller.stage`); (4)
every `refresh()` call site from the old file maps to a controller mutation or session
notify — the audit spine is the 27 `refresh()` occurrences (18 real call sites + 8
comment lines :305, :338, :342, :908, :1248, :1358, :1996, :2024 + 1 definition
:2323), plus the `session.subscribe(refresh)` wiring at :1249 that the
occurrence-grep misses; (5) CSS byte-identical; (6) build + tests green; (7) Fast
Refresh works on the new .tsx (Phase 1's payoff, now real; may move to a follow-up
PR); (8) retire `withMessage`
from `src/ui.ts` once its last caller died (callers: first-run S01, settings S02,
pack-view S06, editor S07–S08 message-state work) — grep ui.ts exports for remaining
consumers before deleting; `el()` itself survives (dialog.ts, combobox.ts, the
`confirm*` helpers, eyedropper, effect-controls.ts, save-dialog.ts if kept
imperative, its own definition in ui.ts); (9) the interim driver is deleted and no
render or effect path calls a command synchronously — `attachStage()`/`detachStage()`
are the named lifecycle exception and handlers an effect registers are event paths
(plan.md contract #4; the basis discard lives in S07's pre-notify step); plus an adoption-wide closing sweep (every view via mountView, no stray
el() view build, no `<StrictMode>` anywhere in `src/`). Then review-cycle to
convergence and the owner's Windows checklist: a
fresh-eyes pass of the S08/S11 Windows lists plus a text-heavy session (overlay
typing, combobox pick, colour eyedroppers) — the interactions the analysis flags as
where a "working" port fails in owner tests. Absorbed into S11, the pass is S11's
list (run once) plus the S08 re-run and the text-heavy session.

**NOT**: restyle anything, change icons (Icons rule); screen-reader and Tab-only
access are out of scope, existing aria/role attributes stay, visual contrast stays in
scope (UI-audience rule).

## Risks

1. **Effect cleanup cancels what today always finishes** (the analysis's #1 cost):
   gestures live in the controller (S07); the cleanups S08 adds (the stage effect's
   save-transform/detach/destroy, the text overlay's blur-to-commit, the document
   listeners' removal, the drag-drop unlisten) tear down view objects only and none
   cancels a command; the stage effect's deps are session identity alone — brush
   radius, crop box, preview override ride separate effects/setters. S08's exit test
   (mid-drag tab switch) targets exactly this.
2. **Stage rebuild loses Konva-held view state**: `viewTransform` cache + restore in
   the mount effect; remount re-asserts tool/guides/brush/preview. The one deliberate
   deviation from today (a rebuilt stage) is contained in S08 where it is testable in
   isolation.
3. **`root ??=` semantics replaced by re-boot**: the module cache becomes the
   controller; every hook works headless from S07 onward (before any React exists);
   `startSession`'s contract "showEditor() runs before the file opens, so the canvas
   can measure" is documented as a preserved invariant.
4. **Focus-clobbering by re-render** (the activeElement guards — 3 inside `refresh()`
   (:2394, :2527, :2530), 5 across the editor view surface incl. :1901 and
   effect-controls.ts:292): uncontrolled inputs + explicit sync in layout effects
   with the same guard; EffectControls/FontPicker not ported at all.
5. **`run()` busy-gating under React event batching**: `busy` is read-and-set
   synchronously in one task; React never re-enters it because commands are plain
   functions outside the render cycle. Rapid-double-click is in the S07 owner smoke
   test.
6. **Keyboard contract drift** (the keydown guard ladder incl. the Windows Alt
   rulings of 2026-11-24): the ladder moves as a unit into one effect; any reordering
   shows up as Alt-menu or shortcut regression on Windows — hence per-session
   Windows touchpoints, not one check at the end.
7. **StrictMode double-mount** would build/destroy the stage twice: excluded by
   decision, recorded so a later cleanup doesn't silently re-enable it.
