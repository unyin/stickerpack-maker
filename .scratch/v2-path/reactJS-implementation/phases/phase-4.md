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
  :912, wand :1804) plus `viewTransform` (pan/zoom cache) and `mounted`. External
  store: `subscribe(listener)` forwards `session.subscribe` (re-subscribed on session
  identity change); every controller mutation bumps a version and notifies; components
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
- **`refresh()` (:2323-2579) dissolves by ownership**: toolbar labels/disabled/titles →
  Toolbar; tools-panel state + `effectControls.update()` + `preview.request()` →
  ToolsPanel's post-render `useLayoutEffect`; layers/actions/emoji → RightPanel;
  `stage?.setCropBox`/`setBrushRadius` → CanvasPanel's layout effect. Tree order
  preserves "canvas redraws first, then the panels measure": CanvasPanel placed first
  among the workspace children.
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
| save-dialog.ts (301) | **Keep imperative** through S07–S11; JSX port (`<SaveDialog/>`) is S12, gated on the dialog binding contract | A transient modal over the shared dialog contract + packPicker; its focus/keyboard rules belong to the dialog layer. |

- **Component tree (~8)**: `EditorApp` (root; message row, empty state, workspace
  skeleton) · `Toolbar` · `ToolsPanel` (left tabs; embeds EffectControls blocks + text
  controls) · `CanvasPanel` (stage ref leaf + text overlay + status strip + drop
  target) · `LayersPanel` · `ActionsPanel` · `EmojiPanel` · `SaveDialog` (contingent).
  New files under `src/views/editor/`, importing the `ImperativeNode.tsx`
  ref-embed helper created in Phase 3 (S04, `src/react/`) `src/views/editor.ts` stays the module entry — `renderEditor()`, the hook
  layer (`openFileHook`/`openThumbnailHook`/`forgetOriginHook`/`setEditorNav`) and the
  `confirm*` helpers stay exported there so shell.ts and pack-manager call sites are
  untouched.
- **No `<StrictMode>`** on the editor root (binding contract #3); StrictMode-safety is
  a follow-up, not an exit criterion.

## S07 (4.1) — EditorController: the state bridge, no React yet (1 session)

The single riskiest move, isolated with zero behavior change.

**Touches**: `src/views/editor.ts` (state + commands move out; the DOM build stays and
consumes the controller), new `src/editor/app/editor-controller.ts` (+ `commands.ts`).
Nothing under `src/editor/model/`, `src/editor/view/`, or any CSS file.

**Builds**: the singleton store; all ~24 closure vars become controller fields; `run`,
`editAsync`, `setTool`, `startSession`, `endSession`, the warp/wand/compose gesture
handlers, `saveSession`, `commitEmoji`, `stickerLink`/`thumbnailLink` generation, and
the drag-drop plan handling become controller methods; the EffectPreview instance and
its show callback (reading `controller.stage` dynamically) move in; the hook layer at
:2812+ delegates to the controller so `forgetEditorOrigin()`/`openFileInEditor()` work
with the view *detached*, exactly as today. `refresh()` remains the el()-view's single
render pass, now reading the controller.

**NOT**: React, JSX, new deps; any DOM markup/class/title/behavior change; islands or
model code.

**Exit criteria**: build + tests pass; CSS byte-identical; grep proves no `let` state
remains inside `buildEditor()` except purely-local DOM-build temporaries; the race
guards character-identical in the controller (`run()`'s busy-gate +
`stage?.setInteractive`, `editAsync`'s doc-identity refusal, `beginWarp`/`beginWand`'s
busy/active guards). Review-cycle converged, then owner smoke test: open an image,
drag/transform, add text, rect-cut + paste, wand Shift/Alt drag, warp drag, Apply
outline to text, save new sticker, save-thumbnail, Close with unsaved changes, switch
tabs and back — session and pixel state unchanged (pre-React, behavior must be
*identical*). Lands via `gh pr merge --merge`.

## S08 (4.2) — React root + CanvasPanel: the Konva bridge (1 session)

**Touches**: `src/views/editor.ts` (mount switches to mountView("editor", …); the
canvas-host/listener/overlay code of `buildEditor()` deleted), `src/shell.ts` (editor
branch of `show()`, one line), new `EditorApp.tsx`, `CanvasPanel.tsx`;
`ImperativeNode.tsx` (S04's `src/react/`, imported, not created); controller (viewTransform cache, mounted flag);
`src/editor/view/stage.ts` — one small addition only: a way to restore pan/zoom into a
rebuilt stage (today the view transform is Konva-held and an unmount would silently
reset it to fit).

**Builds**: `EditorApp` subscribes and renders the still-imperative toolbar/panels
through `ImperativeNode` (strangler inside the view: one session, one converted panel).
`CanvasPanel` owns `canvasHost`, the useRef + useEffect keyed on session identity that
builds `new EditorStage(canvasHost, session)`, wires the stage callbacks to controller
methods, restores the cached view transform, and re-asserts `setTool`/
`setCropGuidesVisible`/`setBrushRadius`/the in-flight EffectPreview override on
remount. The document-level keydown/keyup/paste listeners (:2597-2735) and the
drag-drop registration become mount effects with the same keydown guard ladder (Ctrl+S
preventDefault carrying `view.isConnected` → the mounted check (`!current ||
!view.isConnected` return) → Alt suppression → `textOverlay.isOpen` → busy/downloadNote →
isTextTarget → pick/lasso keys → `shortcutOf` → undo/redo/save/cut/Esc-cascade/Delete,
in that exact order). The text overlay: mount cleanup commits via the overlay's own
settle path rather than dropping it.

**NOT**: port any panel markup; touch `dialogOpen()` gating semantics; change stage
gesture code beyond the view-restore addition.

**Exit criteria**: build/tests pass; CSS byte-identical; a mid-drag warp/wand/erase
tab-switch and back shows the session intact, the stage rebuilt, pan/zoom restored,
undo trail intact, no stroke cancelled by cleanup; Ctrl+S/V/X, Alt suppression, Esc
cascade and `strokeInProgress()` save-refusal behave as before; a mid-typing tab switch
commits the text overlay, never eats it. Windows check: all tool gestures; zoom/pan
persists across tab switch; Alt press/release does not flip zoom or open the system
menu; AltGr still types; Ctrl+S refused mid-stroke with the reason; drag an image file
from Explorer onto the empty editor and onto an open session; type in the overlay while
panning.

## S09 (4.3) — Toolbar + ToolsPanel + effect controls embed (1 session)

**Builds**: toolbar top row (Open/Add/Undo/Redo/Fit/Cover/Long side/Resize/Guide/
Crop/Reset view/Close/Save…) with every §2 blocked-title rule from `refresh()`;
the left tab set (select/paint/effects/text sections, the TOOL_PANEL surfacing rule);
EffectControls' blocks embedded at their slots via `ImperativeNode`, with a
post-render `useLayoutEffect` running the effect section of the old `refresh()`
(effectControls.update, preview.request; the stage setters setCropBox/setBrushRadius
are CanvasPanel's, per the architecture section). Side-input remains an
uncontrolled input synced with the `document.activeElement` guard.

**NOT**: port EffectControls internals, the FontPicker (imperative embed in the text
section until S11), or the eyedroppers.

**Exit criteria**: build/tests pass; CSS byte-identical; every class string and title
of the old toolbar/tools-panel markup appears identically in the new tree (the old
el() code in git history is the spec — port line-by-line); sizing-tool blockers
(`sizeToolBlocker` with `stage.contentBounds()`), tool-tab surfacing, effect
slider/wheel/typed commits, Apply/Cancel (incl. Outline-on-text restyle vs
Glow-on-text bake) behave as before. Owner tests: hover a sweep of disabled controls
(§2 reasons in titles); the four sizing tools' enable rules at odd sizes; effect
sliders by drag, wheel-hover and typing (invalid reverts, Esc reverts + blurs);
Apply/Cancel on raster vs text layers.

## S10 (4.4) — Right panel: Layers, Actions, Emoji (1 session)

**Builds**: the layers list + the action grid + `layerHint`; reveal-on-render and
reveal-on-tab-show (`afterShow` hooks become effects on tab show — the hidden-tab
no-layout rule preserved); the Actions list as JSX (current badge, nested Select
steps, the blank striped fill, terminal-tail reveal); the Emoji panel (Enter/blur
commit through `controller.commitEmoji`, warn-only validation, blocked-box reason
tooltip, thumbnail-mode leaf hiding with the reset-to-Layers rule).

**NOT**: make the Actions rows interactive (still read-only); change
focus-preservation semantics (the emoji input keeps its activeElement sync guard).

**Exit criteria**: build/tests pass; CSS byte-identical; the Actions list renders
identically for a scripted sequence (open → rect cut → wand shift/alt → undo ×3)
compared against the old build; layers reveal never nudges an in-view row
(`revealRow`'s 0.5px rule intact); emoji commit writes through `SessionEmoji` exactly
as before. Owner tests: Layers reveal on select from far down the stack; Actions
current-badge follows undo/redo; the lined-paper fill; emoji box Enter commits and
hands focus back, >20 warns without blocking, blocked box shows its reason; a
Thumbnail session hides the Emoji leaf and lands on Layers.

## S11 (4.5) — Text controls, SaveDialog, origin/Library flows (1 session)

**Builds**: the text tool controls (font-size/color/outline inputs, eyedropper
embeds; FontPicker stays an embed); the save flows end-to-end: sticker save (replace
origin / new + pack picker), thumbnail save, PNG-over-cap WEBP offer, exhausted
give-up question, `originAfterSave` re-point, saved-note links with the
`libraryGeneration` guard, `forgetEditorOrigin()` while the editor is *unmounted*
(Settings re-point path: the controller must mutate and the remounted view must show
the disabled Emoji box and refused Replace at once). `SaveDialog.tsx` ports
save-dialog.ts per the dialog binding contract (keep imperative if the contract check
says so — the decision is recorded either way).

**NOT**: change `save.ts`, save-dialog wording, or the pack picker (Phase 3 surface).

**Exit criteria**: build/tests pass; CSS byte-identical; the full save matrix behaves
as today (new/replace/gone-origin/thumbnail/declined/exhausted), incl. `lastFormat`
persistence and `markSaved` only when `current.doc === doc` (defence-in-depth kept);
library re-point invalidation shows all three symptoms (save-dialog refusal wording,
emoji box blocked reason, note links reporting gone) with the Editor on screen and
off screen. Windows check: the save matrix incl. PNG over cap → WEBP offer → exhausted
give-up; saved-note links navigate to the Pack Manager; after a Settings re-point they
report gone.

## S12 (4.6) — Consolidation: sweep, race audit, Windows check (1 session; absorbs into S11 if S07–S11 landed clean — the 5-vs-6 swing)

**Touches**: `src/views/editor.ts` (final deletion of the el() build path; the file
keeps only the mount entry, hook layer and `confirm*` helpers), any residue.

**Builds**: the closing audit against a written checklist: (1) no effect owns a
gesture/`editAsync` lifetime; (2) the stage effect's deps are exactly session
identity; (3) no closure captured a stage instance (grep `controller.stage`); (4)
every `refresh()` call site from the old file maps to a controller mutation or session
notify — the audit spine is the 27 `refresh()` occurrences (18 real call sites + 8
comment lines :305, :338, :342, :908, :1248, :1358, :1996, :2024 + 1 definition
:2323), plus the `session.subscribe(refresh)` wiring at :1249 that the
occurrence-grep misses; (5) CSS byte-identical; (6) build + tests green; (7) Fast
Refresh works on the new .tsx (Phase 1's payoff, now real); (8) retire `withMessage`
from `src/ui.ts` once its last caller died (callers: first-run S01, settings S02,
pack-view S06, editor S07–S08 message-state work) — grep ui.ts exports for remaining
consumers before deleting; `el()` itself survives (dialog.ts, combobox.ts, the
`confirm*` helpers, eyedropper). Then review-cycle to convergence and the owner's Windows checklist: a
fresh-eyes pass of the S08/S11 Windows lists plus a text-heavy session (overlay
typing, combobox pick, colour eyedroppers) — the interactions the analysis flags as
where a "working" port fails in owner tests.

**NOT**: restyle anything, change icons (Icons rule), add a11y work beyond keeping
existing attributes (UI-audience rule).

## Risks

1. **Effect cleanup cancels what today always finishes** (the analysis's #1 cost):
   gestures live in the controller (S07), the only new cleanup is the stage effect's
   `stage.destroy()`, and the stage effect's deps are session identity alone — brush
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
