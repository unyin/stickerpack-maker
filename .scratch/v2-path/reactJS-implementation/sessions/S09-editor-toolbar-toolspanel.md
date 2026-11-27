# S09: Toolbar + ToolsPanel + status strip + effect controls embed (Phase 4)

Anchors are `src/views/editor.ts` lines at commit `11bacb6` unless a file is named
(plan.md › Anchor base): S07–S08 moved the code, so read
`git show 11bacb6:<file>` and find today's code by the symbol named beside each line.

## Goal

Port the Editor's top toolbar, the left tools panel and the bottom status strip
from el() to JSX, embedding EffectControls' imperative blocks at their slots,
with every class string, title (including blocked-title reasons), disabled rule
and DOM shape identical to today. When this session ends, `Toolbar`,
`ToolsPanel` and `StatusStrip` are React components subscribed to the
controller, the effect section of the old `refresh()` runs as ToolsPanel's
post-render `useLayoutEffect`, and their el() code and interim-driver sections
are gone from `src/views/editor.ts`.

## Preconditions

- S08 landed: `EditorApp` mounts through the registry and renders the message
  row, the empty state (with Open image) and the workspace (toolsPanel embed,
  CanvasPanel, layersPanel embed); `ImperativeNode` exists
  (`src/react/ImperativeNode.tsx`, created in S08); CanvasPanel owns the
  stage and already runs the version-keyed layout effect for
  `setCropBox(cropState(doc).box)` and `setBrushRadius(controller.warpRadius)`;
  the toolbar, tools panel, right panel and status strip are still el()
  embeds kept current by EditorApp's interim refresh driver.
- S07/S08's controller holds `busy`, `tool`, `freeSide`, `brushSize`,
  `tolerance`, `feathered`, `basis`, `showBox`, `fonts`/`fontsProblem`,
  `nextStyle`, `lastFormat`, `downloadNote`,
  `cancelDownloadShown`, `leftTab`, `toleranceValue`,
  `warpRadius`, `zoom` (+ `subscribeView`), `viewTransform`, and the command
  methods (`run`, `setTool`, …).
- **Contingent on S08's fallback:** if S08 slipped the keyboard ladder (S08 ›
  Risks and fallbacks), it is still registered from `renderEditor()`'s lazy
  build with its `view.isConnected` checks pointed at EditorApp's `.view`
  element; step 0 moves it before anything else here. Check S08's PR
  description for the slip before starting.
- **Contingent on S08's other fallback:** if S08 slipped the drop-target
  state (S08 › Risks and fallbacks), `setDropTarget` (:2736–2740) lives in
  EditorApp.tsx's drag-drop effect and still writes the `drop-target` class
  straight onto the React-owned `empty` div and `canvasHost`, through
  EditorApp's `emptyRef` and the `canvasHostRef` prop CanvasPanel attaches;
  step 0b moves it. Same PR-description check.

## Files touched

| Path | Status |
|---|---|
| `src/views/editor/Toolbar.tsx` | new |
| `src/views/editor/ToolsPanel.tsx` | new |
| `src/views/editor/StatusStrip.tsx` | new (unless the StatusStrip slip fired: then S10 step 0 creates it) |
| `src/views/editor/EditorApp.tsx` (from S08) | modified — the toolbar/tools-panel/status-strip embeds become `<Toolbar/>`/`<ToolsPanel/>`/`<StatusStrip/>` (the status-strip embed and its driver section stay if the StatusStrip slip fired); their sections leave the interim driver (plus `dropTarget` state if step 0b fires) |
| `src/views/editor.ts` | modified — toolbar, tools-panel and (unless the StatusStrip slip fired) status-strip el() build sections deleted (still holds the right panel, the text section and the save flows) |
| `src/editor/view/effect-controls.ts` (346 LOC) | **untouched** — its blocks embedded via `ImperativeNode` |
| `src/editor/view/eyedropper.ts`, `font-picker.ts` | untouched (embeds) |

CanvasPanel.tsx is not touched (the stage setters were placed there in S08),
except the `drop-target` class prop when step 0b fires.

## Work plan

0. **Contingent — the keyboard ladder, only if S08 slipped it.** Carry out
   S08 step 5 verbatim, as this PR's first commit: the document-level
   keydown/keyup/paste listeners (:2597–2734) move whole from the lazy build
   into EditorApp's mount `useLayoutEffect`, their `view.isConnected` checks
   (and the `setEditorViewElement` hand-off that fed them) dropped, nothing
   else changed — Ctrl+S `preventDefault` first, then the same guard order
   (S08 step 5's list), `isSaveShortcut` exported. Never split the ladder.
   When step 0 fires, StatusStrip's slip to S10 is pre-authorised (Risks and
   fallbacks): decide it up front, not mid-session.
0b. **Contingent — the drop-target state, only if S08 slipped it.** Carry out
   S08 step 6's `setDropTarget` part verbatim (before step 1, after step 0 if
   that fired): `setDropTarget` becomes EditorApp state `dropTarget: "empty" |
   "canvas" | null`, set at the event to `on ? (controller.session ? "canvas"
   : "empty") : null`, rendered as the `drop-target` class on the empty div
   or (prop) on CanvasPanel's `canvasHost` — the one CanvasPanel.tsx change
   this session allows (the prop replaces S08's interim `canvasHostRef`), and
   only when 0b fires; EditorApp's `emptyRef` goes with it. No code writes a
   class on a React-owned element any more.
1. **Spec-first port:** before writing JSX, extract the old markup from git
   history (`git show 11bacb6:src/views/editor.ts`). The old el() code is the
   spec; port line-by-line. Every class string and title must appear
   identically in the new tree — this is the session's exit test.
2. **`Toolbar.tsx`:** the top row as built at :690–724 — Session group
   (Undo, Redo) | Size group (Fit in, Cover, Long side) | Free resize group
   (the side-kind select, the side input, Resize) | Crop group (Guide, Crop
   to …) | spacer | Save…, Close — with the `editor-sep` rules between groups,
   label/disabled/title-synced as in `refresh()` (sizing :2400–2445, crop
   :2448–2455, Close :2460, Save :2461–2465, Undo/Redo :2466–2477).
   With no session it renders `hidden`, as :2327 (the driver's
   `toolbar.hidden` write leaves with it).
   Subscribes via `useSyncExternalStore`; renders from controller state;
   buttons call controller commands (`run(saveSession)` etc.) — no new
   commands invented. Every blocked-title rule from `refresh()` must survive:
   the reason strings of the SPEC §2 blockers, notably
   `sizeToolBlocker(tool, doc, content, entered, constraints, freeSide)`
   (:2439, using `stage.contentBounds()`, stage.ts:463, read at render through
   `controller.stage`) for the four sizing tools — right on the first paint
   because `attachStage` notifies (S08 step 3's catch-up commit), so the
   Toolbar re-renders once the stage exists — and the busy/save-refusal
   reasons (Save's title, :2465, rendered as S07 step 5 defines it:
   `blockedTitle(saveStem, downloadNote ?? saveReason, saveTitle())`, the
   download note ahead of a canvas reason during a model download).
   - Not in the toolbar, so not here: Open image is in the empty state
     (:675–681, EditorApp's since S08, `disabled` from :2334); Add image as
     layer is a Layers-grid cell (:942, S10; `addButton.disabled` :2427
     stays in the driver until then); Reset view is in the status strip
     (:1020, step 4); the canvas tool buttons and their `aria-pressed` /
     `b.disabled` loop (:2339–2352) are ToolsPanel's (step 3).
   - **The side input** stays an **uncontrolled** `<input>` with a ref. Code
     never writes its value — `refresh()` sets only its aria-label, title
     (:2410–2411) and `disabled` (:2444) — so it needs no activeElement guard:
     `enteredSide()` reads the ref with today's expression (:2171) and the
     Resize click and Enter key pass it to S07's `controller.freeResize(entered)`
     (the controller never reads the input), and its
     `input` listener (:673, today `refresh()`) re-renders the Toolbar so the
     Resize blocker follows the typed value. A controlled input would rewrite
     the half-typed value on every render.
3. **`ToolsPanel.tsx`:** the `<aside class="editor-tools">` (:891–896): the
   left tab row and the select/paint/effects/text sections in
   `editor-tools-body`. With no session the `<aside>` renders `hidden`, as
   :2329 (the driver's `toolsPanel.hidden` write leaves with it).
   - **Tabs from `controller.leftTab`:** `aria-selected` and each section's
     `hidden` render from it; tab clicks, tool switches (`setTool`'s
     `TOOL_PANEL` surfacing, :1572), text editing (:2049–2050) and the T
     shortcut (:2632) all write it through S07's controller methods, so
     ToolsPanel only renders. The left tabs have no `afterShow` hooks (only
     the right tabs', :954/:969), so rendering straight from state is exact.
     Tab state lives in the controller, so a remount lands on the same tab.
   - The canvas tool buttons with `aria-pressed` from `tool` and `disabled`
     from `busy` (:2339–2352), and the select/paint section controls synced
     at :2500–2512 (cut, paste, remove background, brush size, tolerance,
     feather) plus Cancel download's visibility (S07's `cancelDownloadShown`).
     Delete/Move/Merge and the layer hint (:2478–2499, :2555–2561) are the
     Layers grid's (S10).
   - **The tolerance input** (:596–611) stays uncontrolled. The one
     focus-preservation guard in this panel is its value write: S07 turned
     endWand's `if (document.activeElement !== toleranceInput)
     toleranceInput.value = …` (:1901) into `controller.toleranceValue`;
     ToolsPanel's layout effect applies a pending `toleranceValue` to the
     input only when it does not have focus, then clears it — the same rule,
     React-era. The clear is a silent consume of a pending value (no notify),
     which plan.md binding contract #4's lifecycle exception allows from an
     effect body; it is not a command.
   - **Where the EffectControls instance lives.** Once the tools-panel el()
     code is gone, `new EffectControls({ change, pick, apply, cancel })`
     (:405–410, callbacks as S07 left them: `change` →
     `controller.effectSettingsChanged()`) stays in `src/views/editor.ts`,
     built once by the lazy builder (`renderEditor()`'s cache, beside the
     still-el() right panel and text section), which calls
     `controller.attachEffectControls(port)` right after constructing it, as
     S07 step 6 did. EditorApp reads the instance from that cache and passes
     it to `<ToolsPanel effectControls={…}/>` as a prop. ToolsPanel embeds
     its four blocks and calls `update`/`hide` and `preview.request` (step 5)
     through it; the controller keeps reaching it only through the port. One
     instance per app run, so a remount re-embeds the same blocks with their
     typed values intact.
   - EffectControls' blocks embed at their slots via `ImperativeNode`:
     `warpBlock` in the paint section (:847), `outlineBlock`, `glowBlock`
     and `actions` in the effects section (:856–858) — the fields declared
     at effect-controls.ts:60 (`outlineBlock`), :62 (`glowBlock`), :64
     (`warpBlock`), :66 (`actions`).
   - **The text section is embedded, not ported:** the el() `textSection`
     (:865–886, with its FontPicker and eyedroppers) is embedded whole at its
     slot via `ImperativeNode`. It is built by `leftTabs.section("text", …)`
     (:795–806: `id`, `role="tabpanel"`, `aria-labelledby`, `hidden`), so
     when the tools-panel el() code goes, that builder (or an equivalent
     one-off giving the same five attributes — `class="editor-tool-section"`
     (:797), `role`, `id`, `aria-labelledby`, `hidden`) stays for the text section.
     Its `hidden` following `leftTab` is set **on the `<section>` itself**,
     from ToolsPanel's layout effect — never on the `ImperativeNode` host:
     the host's inline `display: contents` overrides the UA `[hidden]` rule,
     so `hidden` there would hide nothing. Its
     `refresh()` lines (:2513–2554) stay in the interim driver. S11 ports the
     text controls; S09 writes no text-control JSX.
4. **`StatusStrip.tsx`:** the `editor-status` strip (:1013–1023): the readout
   (:2456–2458, text + `off` class), and on the right the zoom label (from
   `controller.zoom` via its own `useSyncExternalStore(controller.subscribeView,
   …)`, so pan/zoom frames re-render only the strip), Reset view (`disabled`
   from `busy`, :2459; click `controller.stage?.fit()`, :344) and the dirty
   dot (`hidden` from `!isDirty`, :2562). EditorApp renders it after the
   workspace, hidden with no session, as :2333.
5. **Post-render effect sync — one owner per line:** a `useLayoutEffect` in
   ToolsPanel runs only its own panel's part of the old `refresh()` after
   every render — `effectControls.update(...)` with the same state inputs,
   then `preview.request(previewRequest())` (the closing lines of `refresh()`,
   :2566–2576, minus the `setBrushRadius` line at :2575). Same inputs, same
   order. `controller.previewRequest()` is a pure read (:1678–1683: it builds
   a request from `tool`, the session and the port's `effect(kind)`, and
   writes nothing), so calling it from the effect is not a command call
   under binding contract #4; `effectControls.update` and `preview.request`
   are island calls, not controller calls. A basis about to be discarded never reaches it: S07 moved the
   discard (:2360–2366, `setTool("move")`) into the controller's pre-notify
   step, so by the time any notify renders ToolsPanel, `tool` is already
   Move and `basis` null — `effectControls.update` and `preview.request`
   never fire for the dropped basis (today's `refresh()` returned early
   before them, then re-ran via `setTool`; the outcome is the same). The stage setters `setCropBox` and `setBrushRadius` stay
   CanvasPanel's (S08's version-keyed effect, reading `controller.warpRadius`
   — never `effectControls.warp`), and the no-session `effectControls.hide()`
   (:2356) moves into this effect's no-session branch. ToolsPanel's layout
   effect never touches the stage.
6. **Delete** the toolbar, tools-panel and status-strip el() sections from
   `src/views/editor.ts` and their sections from the interim driver, and the
   lazy build's `subscribeView` subscription that writes the zoom label (S08
   step 2) — unless the StatusStrip slip fired, in which case the strip, its
   driver lines and that subscription stay and S10 step 0 deletes them; the
   remaining el() code (right panel, text section, save flows) stays for
   S10/S11.
7. **Land per plan.md › Session protocol**, with this session's checks: the
   CSS byte-identity check, the rendered-DOM comparison below, and the
   checklist.

## Deliberately out of scope

- Porting EffectControls internals (slider wheel/typed-commit/blur contracts
  and never-clobber-while-typed sync stay hand-tuned vanilla — the phase's
  island table rules them **Wrap, not port**).
- The text section and the FontPicker (embedded until S11; a combobox port is
  post-adoption).
- The eyedroppers (ref-embed only; porting would fork them).
- The right panel (S10), the text controls and save flows (S11).
- CSS files (byte-identical), icons, new aria/role attributes.
- No `<StrictMode>` anywhere in `src/` (binding contract #3 — double-invoked
  effects would churn the Konva stage and double-run the ToolsPanel
  `effectControls.update()`/`preview.request()` sync).

## Exit criteria

- `bun run build` + `bun test` pass; all five CSS files byte-identical.
- Every class string and title of the old toolbar/tools-panel/status-strip
  markup appears identically in the new tree (diff the rendered DOM against a
  capture from the pre-S09 build, or verify line-by-line against git history).
- Sizing-tool blockers (`sizeToolBlocker` with `stage.contentBounds()`)
  produce the same titles/enabled states at odd sizes as before, including
  while typing into the side input.
- Tool-tab surfacing follows the active tool exactly as before, and survives a
  tab switch away and back.
- Effect sliders commit by drag, wheel-hover and typing; invalid input
  reverts; Esc reverts + blurs (EffectControls untouched, so any drift is a
  wiring bug — the sync inputs must match the old `update()` call exactly).
- Apply/Cancel behave as before, including Outline-on-text (restyle) vs
  Glow-on-text (bake).
- Panning and zooming re-render only StatusStrip (React profiler or a render
  counter), and the zoom label tracks it — unless the StatusStrip slip fired
  (then this criterion moves to S10 step 0).
- The el() sections and their driver sections are gone: grep
  `src/views/editor.ts` finds no toolbar, tools-panel or status-strip el()
  build (none of the quoted class strings `"editor-toolbar"` :692,
  `"editor-tools"` :893, and — unless the StatusStrip slip fired —
  `"editor-status"` :1023; the right panel's
  `"editor-tools-body"` :1009 stays until S10) and the interim driver no longer writes
  `toolbar.hidden` (:2327), `toolsPanel.hidden` (:2329) or — unless the
  StatusStrip slip fired — `statusStrip.hidden` (:2333), the readout
  (:2456–2458), `resetViewButton.disabled` (:2459), `dirtyLabel.hidden`
  (:2562); nor any other line
  of the sizing/crop/Save/Close/Undo/Redo (:2400–2477), tool-button
  (:2339–2352), select/paint (:2500–2512) or effect (:2566–2576) sections; and
  (unless the StatusStrip slip fired) the lazy build no longer holds the zoom-label
  `subscribeView` subscription (step 6).
- If step 0b fired: grep all of `src/` (editor.ts, EditorApp.tsx,
  CanvasPanel.tsx) finds no `setDropTarget`, no `canvasHostRef`/`emptyRef`
  and no `classList` write of `drop-target`; a file dragged over the empty state
  and over an open session highlights the same element as before, and the
  highlight clears on leave/drop.
- If step 0 fired: grep finds no `view.isConnected` and no
  `setEditorViewElement` left; the keydown ladder's order matches S08 step 5
  line by line (Ctrl+S `preventDefault` before the no-session return); Ctrl+S
  refused mid-stroke with its reason, Ctrl+V/X, Alt suppression and the Esc
  cascade behave as before.
- Windows checklist (below) passed.
- PR merged with `gh pr merge <N> --merge`.

## Review-cycle coverage

- DOM identity: class names, titles, button order and nesting identical to
  the pre-S09 build (the reviewer's primary axis this session).
- The `useLayoutEffect` sync block passes exactly the inputs the old
  `refresh()` passed to `effectControls.update()` / `preview.request()` —
  stale or missing state would show as a silently stale preview.
- No EffectControls/FontPicker/eyedropper internals changed (grep the diff:
  those files must be absent), and CanvasPanel.tsx is absent from the diff
  (unless step 0b fired: then only the `drop-target` class prop).
- The text section's `hidden` toggles on the `<section>` (not the
  `display: contents` host) and keeps the `leftTabs.section` attributes.
- The side input is uncontrolled and never written; the tolerance input's
  pending-value write keeps the :1901 focus guard.
- Toolbar disabled states cover busy, save-refusal and sizing blockers with
  the exact reason strings; Open, Add and Reset view sit where step 2 says.
- No text-control JSX in ToolsPanel (S11's).

## Owner / Windows checklist

1. Hover a sweep of disabled controls — each shows its SPEC §2 reason in the
   title (blocked, not silent).
2. The four sizing tools' enable rules at odd image sizes (Fit/Cover/Long
   side/Resize): enabled exactly when their blocker passes.
3. Effect sliders: commit by drag, by wheel over the slider, by typing a
   value (invalid reverts on blur/Enter; Esc reverts and blurs).
4. Apply/Cancel on a raster layer vs a text layer: Outline-on-text restyles,
   Glow-on-text bakes — the distinction preserved.
5. Switch tools across sections — the left panel surfaces the right section;
   switch app tabs and back — the same section shows.
6. Type into the side-length field — Resize enables as you type, the typed
   value is never rewritten; type into the tolerance field, then wand-drag —
   the field you are typing in is not clobbered.
7. Zoom and pan — the zoom label follows; Reset view works and is disabled
   while busy.
8. Only if step 0 fired (S08's Alt/Ctrl items, re-run after the move): Alt
   press/release does not flip zoom or open the system menu, AltGr still
   types; Ctrl+S refused mid-stroke with the reason; Ctrl+V/X paste/cut as
   before; the Esc cascade in order (effect → text → selection); after three
   tab-switch round trips one set of document listeners is live.

## Risks and fallbacks

- **Focus-clobbering by re-render** (risk #4): uncontrolled inputs; the one
  value write here (tolerance) keeps its `document.activeElement` guard;
  EffectControls/FontPicker not ported at all.
- **DOM drift** (class/title/attribute mismatches): the git-history spec
  port is the mitigation; the reviewer diffs the rendered tree, not the code
  style.
- Fallback if the session overruns: StatusStrip can slip to S10 (it stays an
  embed with its driver section), as long as the toolbar, the tab set and the
  EffectControls embed land. **Pre-authorised when step 0 fires:** the ladder
  move takes StatusStrip's budget, so StatusStrip slips to S10 without a
  mid-session check; record it in the PR description, and S10 ports it first
  (with `statusStrip.hidden` leaving the driver there).
