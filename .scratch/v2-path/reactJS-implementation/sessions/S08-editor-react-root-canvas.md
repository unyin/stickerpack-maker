# S08: React root + CanvasPanel — the Konva bridge (Phase 4)

Anchors are `src/views/editor.ts` lines at commit `11bacb6` unless a file is named
(plan.md › Anchor base): S07 moved the state and commands, so read
`git show 11bacb6:<file>` and find today's code by the symbol named beside each line.

## Goal

Mount the Editor as a React root through `mountView()` and port only the canvas
half: `EditorApp` renders the still-imperative toolbar/panels through a
ref-embed helper (strangler pattern: one session, one converted panel), and
`CanvasPanel` owns the Konva stage behind a useRef/useEffect keyed on session
identity. When this session ends, the Editor mounts as React, the stage is
rebuilt on remount with pan/zoom restored, and the document-level keyboard
guard ladder and drag-drop registration run as mount effects with the exact
same order and guards as today.

## Preconditions

- S07 landed: the `EditorController` singleton at
  `src/editor/app/editor-controller.ts` holds every closure var plus the
  message fields `{ text, tone, links }` and the view-state fields `leftTab`,
  `rightTab`, `emojiDraft`, `toleranceValue`; commands notify once each and
  write no view DOM; `attachStage(stage)` sets `controller.stage` and
  (re)subscribes the session forwarder after the stage; `startSession`/
  `endSession` emit synchronous session-start/session-end events that the
  el() view handles (stage build, overlay close); the hook layer is
  installed at module init; `renderEditor()` is a lazy builder.
- Phases 1–3 contracts: `mountView()` registry (exactly one view mounted at a
  time, unmount-before-clear-before-mount), navigator seam, dialog/combobox
  islands, no `<StrictMode>` anywhere in `src/` (binding contract #3).
- `src/views/editor.ts` still contains the el() build for toolbar/panels — it
  stays this session and is embedded through `ImperativeNode`, which this
  session creates (S04–S06 build no such helper; they attach el() nodes to
  existing React elements by ref).

## Files touched

| Path | Status |
|---|---|
| `src/views/editor.ts` | modified — the shell mounts the Editor through the registry; the canvas-host/listener/overlay code of `buildEditor()` and the session-start/session-end view handlers deleted; `renderEditor()` stays the lazy builder of the remaining el() pieces |
| `src/shell.tsx` (S02's conversion of shell.ts) | modified — the editor line of `mountScreen()` (S02 step 4: `mountDomView(content, "editor", renderEditor())`; at 11bacb6 the `content.append(renderEditor())` of `show()`, shell.ts:83), one line |
| `src/views/editor/EditorApp.tsx` | new |
| `src/views/editor/CanvasPanel.tsx` | new |
| `src/react/ImperativeNode.tsx` | new — the ref-embed helper (step 3) |
| `src/editor/app/editor-controller.ts` (from S07) | modified — add the `viewTransform` cache, `warpRadius`, `zoom` + `subscribeView`, and the text-overlay registration (step 7); `endSession`'s `stage?.destroy(); stage = null` becomes `this.detachStage()` and the destroy moves to CanvasPanel's cleanup (step 4) |
| `src/editor/view/stage.ts` (1,286 LOC) | modified — one small addition only: a restore setter for pan/zoom |

`src/editor/model/session.ts` and every other island/model file untouched
beyond the stage addition.

## Work plan

1. **stage.ts addition (the only stage change allowed this phase):** the
   getter already exists — `view(): ViewTransform` (stage.ts:449, `{ scale, x,
   y }` read from Konva). Add only a setter that restores a `ViewTransform`
   into a stage instance (the inverse of `view()`, firing the view-change
   listener as `onViewChange` does). Today an unmount silently resets the view
   to fit (the constructor fits, stage.ts:440); with the setter, CanvasPanel
   restores pan/zoom across remounts. No gesture code touched.
2. **Controller additions:**
   - `viewTransform: ViewTransform | null` — written by CanvasPanel's cleanup
     from `stage.view()` before `destroy()`, read on rebuild; reset to `null`
     by `startSession`/`endSession`, so a new session fits as today. Order:
     on a session change the cleanup runs *after* the command's reset (it is
     a passive-effect cleanup in the commit that command's notify caused),
     so it saves the transform **only when `controller.session` is still the
     session its effect was built for** (a pure unmount); otherwise the
     command's `null` wins and the new session fits.
   - `endSession`'s `stage?.destroy(); stage = null` (kept by S07) becomes
     `this.detachStage()` at the same point: `controller.stage` is `null`
     from there, as today, and the stage instance is destroyed once, by
     CanvasPanel's cleanup (step 4).
   - `warpRadius` (initial `WARP_DEFAULTS.radius`) — the stage's brush radius
     source, so CanvasPanel never reads into EffectControls: written where the
     radius changes, read through S07's effects port as
     `this.effects.warp().radius` (backed by the island's getter,
     effect-controls.ts:160; no `effectControls` reference in the controller,
     per S07's port rule and exit grep) — in S07's `effectSettingsChanged()` command (the
     EffectControls `change` callback, :406), which notifies, so the
     version-keyed `setBrushRadius`, `effectControls.update` and
     `preview.request` re-run on every slider change; and in endWarp after its
     `setWarp(…)` (:1790).
   - `zoom` (the stage view's `scale`) with its own `subscribeView(listener)`
     set, apart from `version`: the stage's `onViewChange` fires on every pan
     and zoom frame, and must not re-render the Editor or run the interim
     driver. CanvasPanel's `onViewChange` handler calls `controller.setZoom(v.scale)`;
     the zoom label (`${Math.round(zoom * 100)}%`, as :1251) renders from it —
     this session in the still-el() status strip, which subscribes through the
     lazy build; from S09 in `StatusStrip` (from S10 step 0 if the StatusStrip slip fired).
   - No `mounted` flag: the document listeners exist only while the Editor is
     mounted (step 5), so `view.isConnected` has no replacement state.
3. **`ImperativeNode` + `EditorApp.tsx`.** `ImperativeNode` (~15 lines,
   `src/react/`): given an `HTMLElement` and an optional host tag (`as`,
   default `"div"`; the message row passes `"span"`, below), renders one host
   element of that tag with `style={{ display: "contents" }}` (no box of its own, so the `.view` and
   `.editor-workspace` flex rows lay out as today), appends the node on
   mount and removes it on unmount, never re-diffing its children — the
   not-yet-ported el() nodes stay on screen inside the React tree.
   **Accepted deviation (lead ruling, 2026-11-27):** the `display: contents` host
   is the one wrapper element the adoption adds to the DOM. It is invisible
   (flex gaps and order unchanged; editor.css has no child selector across
   these slots), React fully owns the parent's children (no foreign nodes mixed
   among React siblings), and it is an inline style, not a CSS-file change.
   DOM-identity checks compare with these hosts unwrapped. Embeds that later
   port (S09–S11) drop their host; only blocks that stay islands keep it.
   `EditorApp` subscribes via
   `useSyncExternalStore(controller.subscribe, () => controller.version)`
   (mutable-snapshot pattern, binding contract #4) and renders, in today's
   order (:1028–1037), the toolbar embed, the message row, the empty state,
   the workspace and the status-strip embed:
   - The message row renders **from controller state** (S07's
     `{ text, tone, links }`); EditorApp's render is its single writer. Until
     S11, `links` still holds the `HTMLElement` nodes `say(…extra)` passes
     (`stickerLink`/`thumbnailLink` buttons) next to strings: EditorApp renders
     strings as text and each node through an interim `ImperativeNode` embed
     (keyed by position in that `say()`'s `links`; `as="span"`, since the row is a `p`), so the nodes keep their
     el()-built handlers. S11 replaces this with links-as-data (a typed
     descriptor React renders as a button) and drops the embed.
   - The empty state (:675–681) is React's, **Open image button included**:
     its `disabled` renders from `controller.busy` (today :2334).
   - The workspace keeps today's DOM order — toolsPanel embed, CanvasPanel,
     layersPanel embed (:1025); `.editor-workspace` is a plain flex row
     (editor.css:324–329), so tree order is visual order and must not change.
   - Empty-state and workspace visibility derive from **session presence**
     (`controller.session === null`), not from any imperative flag.
   - **The interim refresh driver:** a single EditorApp `useLayoutEffect`
     keyed on `controller.version` calls the surviving sections of the old
     `refresh()` — everything not yet ported (toolbar, tools panel, right
     panel, status strip, tab rendering of `leftTab`/`rightTab`) must keep
     updating between controller notifies, because `ImperativeNode` never
     re-diffs its embedded nodes. Each port session (S09/S10/S11) removes its
     own section; S12 deletes the remainder. **Removed from the driver this
     session** (their DOM is React's now, or CanvasPanel's): the message render;
     `empty.hidden` / `workspace.hidden` (:2325–2326); `openButton.disabled`
     (:2334); S07's zoom-label render line (the label renders from
     `controller.zoom`, step 2); `stage?.setCropBox(box)` (:2449) and
     `stage?.setBrushRadius(…)` (:2575), which move to CanvasPanel (step 4).
     The driver calls no command: S07 moved the basis discard
     (`setTool("move")`, :2360–2366) into the controller's pre-notify step.
     The `.hidden` writes on the still-el() toolbar, tools panel, right panel
     and status strip (:2327–2333) stay.
   - **Canvas redraws first** (the :1247–1249 invariant) is held by
     subscription order, not tree order: `attachStage` puts the controller's
     session forwarder after the stage's own session listener, so the stage
     re-renders inside the session notify, and React's store update is only
     scheduled there — the driver runs later, at commit. Within one commit
     React runs all layout effects child-first (CanvasPanel's version-keyed
     layout effect — `setCropBox`/`setBrushRadius` — then EditorApp's
     driver), then all passive effects child-first (CanvasPanel's
     session-keyed stage effect — cleanup, then build — then EditorApp's).
     So on a version bump with a stage already attached, the crop box is
     placed before the driver measures.
   - **Stage build → catch-up render.** The stage is built in the passive
     effect, i.e. *after* that commit's layout effects ran with
     `controller.stage === null` (on mount, or on a new session: the crop
     box unplaced, `sizeToolBlocker` saying "There is nothing to resize."
     for Fit/Cover/Long side/Resize). `attachStage()` is contract #4's
     lifecycle exception — the stage's registration, not a command, and with
     `detachStage()` the only *notifying* controller call made synchronously
     from an effect body (S07 step 2; silent registrations aside, contract #4): it bumps `version` and notifies, so a second commit
     re-runs both layout effects with the stage. On a session start while
     mounted, EditorApp is already subscribed and the notify schedules that
     commit directly. On mount/remount, EditorApp's `useSyncExternalStore`
     subscribes in its own passive effect, which runs *after* CanvasPanel's
     (parent after child), so it misses the notify itself — but the hook
     re-reads the snapshot when it subscribes and, seeing `version` moved
     since render, forces a re-render. Both paths are sync-lane renders
     (store updates and `flushSync` mounts), whose passive effects React
     flushes synchronously at the end of the commit, so the catch-up commit
     lands before the browser paints.
4. **`CanvasPanel.tsx`:** owns `canvasHost`. A `useRef` + `useEffect` keyed on
   **session identity alone** does: `new EditorStage(canvasHost, session)`
   (constructor `(container: HTMLDivElement, session: EditorSession)`,
   stage.ts:346), then re-asserts everything `startSession` set (:1237–1253):
   `setCropGuidesVisible(showBox)`, `setTool(tool)`, `onEditText`,
   `onBrush`, `onWand`, `onCompose`, `setBrushSize(brushSize)` (:1243; the
   stage's brush size, distinct from the radius), `onBrushBlocked` /
   `onPickBlocked` (→ `controller.say`), all wired to controller methods;
   plus what a remount mid-session needs: `setInteractive(!busy)`,
   `controller.attachStage(stage)`, the restore setter with
   `controller.viewTransform` (if cached), `onViewChange` (`controller.setZoom(v.scale)` +
   `placeTextOverlay(v)`, :1250–1253), `setBrushRadius(controller.warpRadius)` and the in-flight
   EffectPreview override. No `setEditing` re-assert: the overlay is created
   per mount (step 7), so none is open on a remount. `setCropBox` is not
   re-asserted here: `attachStage`'s notify re-runs the version-keyed
   effect below, which places it. Cleanup: save the transform under step
   2's same-session rule, `controller.detachStage()` (skipped when
   `controller.stage` is no longer this instance — `endSession` already
   detached it), `stage.destroy()` on the effect's own
   instance — deps are session identity only. `attachStage`/`detachStage` in
   this effect and its cleanup are contract #4's named lifecycle exception, the
   only *notifying* controller calls an effect body makes (the text-overlay
   register/unregister is a silent registration — plan.md contract #4). One
   more synchronous call is allowed: `stage.onViewChange` calls its listener
   at once on registration (stage.ts:444–447), so `controller.setZoom` (and
   `placeTextOverlay`) run inside this effect body; `setZoom` notifies the
   zoom view channel (`subscribeView`) only, never bumps `version`, and is
   not a command (contract #4). Every other controller call here
   is inside a handler the effect registers (`onEditText`, `onBrush`, `onWand`,
   `onCompose`, `onBrushBlocked`, `onPickBlocked`, `onViewChange`), which are
   event paths and may call commands. A separate layout effect keyed on
   `controller.version` runs the two stage setters that left the driver:
   `setCropBox(cropState(doc).box)` and `setBrushRadius(controller.warpRadius)`,
   both through `controller.stage?.` (null until the stage attaches).
5. **Keyboard ladder as a mount effect:** the document-level
   keydown/keyup/paste listeners (:2597–2734) are registered in a
   `useLayoutEffect` on mount and removed in its cleanup, which runs in the
   same commit that unmounts the view — so a listener exists exactly while the
   Editor is mounted, and `view.isConnected` is always true inside one. Its
   checks are dropped, nothing else changes: keydown's Ctrl+S line becomes
   `if (isSaveShortcut(e)) e.preventDefault();` (S08 adds `export` to
   `isSaveShortcut` in editor.ts, :2920, body untouched, since its callers move into
   EditorApp's keyboard effect) and stays first (never reaches
   the webview's save page, even while busy) → `if (!current) return` → Alt
   suppression → `textOverlay.isOpen` → busy/downloadNote → isTextTarget →
   pick/lasso keys → `shortcutOf` → undo/redo/save/cut/Esc-cascade/Delete;
   keyup's guard (:2681) and paste's (:2687) lose only `!view.isConnected`.
   Any reordering shows up as Alt-menu or shortcut regression on Windows
   (risk #6) — do not "improve" the ladder. The save-refusal guard
   `saveRefusal(stage?.strokeInProgress() ?? false, current.doc, constraints)`
   (:2649) keeps its exact reason text.
6. **Drag-drop registration as a mount effect** (EditorApp):
   `getCurrentWebview().onDragDropEvent(handler)` returns
   `Promise<UnlistenFn>`. The effect keeps the promise and a local `active =
   true`; the handler starts `if (!active) return;` (replacing
   `view.isConnected`, :2743); the cleanup sets `active = false` and runs
   `void unlisten.then((f) => f()).catch(() => {})`, so remounts never pile up
   handlers and an event before the promise resolves is ignored.
   `setDropTarget` (:2736–2740) becomes EditorApp state `dropTarget: "empty" |
   "canvas" | null`, set to `on ? (controller.session ? "canvas" : "empty") :
   null` at the event (today's choice of element), rendered as the
   `drop-target` class on the empty div or (prop) on `canvasHost`. Over/enter
   sets it with `!dialogOpen()` (:2745); the drop plan stays
   `dropPlan(payload.paths, kind, busy, dialogOpen())` (:2750).
7. **Text overlay:** `TextEditOverlay` (built at :1027 as
   `new TextEditOverlay(canvasHost, …)`, wheel → `controller.stage?.zoomAtClient`)
   is created per mount by CanvasPanel, which registers it on the controller
   for `editText` (:2039) and `placeTextOverlay` (:2087) the way
   `attachStage` registers the stage; text-edit.ts stays untouched.
   - **Unmount keeps today's commit-on-blur.** Today a mid-typing tab switch
     commits because the click on the shell tab takes focus first: the
     textarea's blur handler commits (text-edit.ts:84) before the view goes.
     That still happens before React unmounts anything. The cleanup only
     covers a leftover open overlay: in a `useLayoutEffect` cleanup (it runs
     before React detaches the host), if `isOpen` and the textarea holds focus,
     blur it so the overlay's own blur handler commits. The textarea is
     private (text-edit.ts:32), so the check goes through the document:
     `overlay.isOpen && document.activeElement instanceof HTMLTextAreaElement
     && canvasHost.contains(document.activeElement)` →
     `document.activeElement.blur()`. The same cleanup then unregisters the
     overlay from the controller (the inverse of the registration above), so
     no later `editText`/`placeTextOverlay` reaches a dead instance. It never
     calls `close()` on an open overlay: `close()` settles it first (:116, the
     `settle` flag of :33–34 stops the blur commit) and removes it without
     committing (:113) — that would eat the text.
   - **Session end closes without commit, as today:** CanvasPanel handles the
     controller's session-end event (moving S07's view handler here) with
     `close()` (:1409's semantics), synchronously inside `endSession`, before
     its notify renders.
8. **Mount switch:** `src/shell.tsx`'s editor line in `mountScreen()` (S02
   step 4: the closure in `renderShell`'s scope that maps a screen to its
   registry call; today's line is `mountDomView(content, "editor",
   renderEditor())`, the successor of `show()`'s `content.append(renderEditor())`,
   shell.ts:83 at 11bacb6) changes one line to `mountView(content, "editor",
   <EditorApp/>)`, mounting `EditorApp` through the registry
   (unmount-before-clear-before-mount order per binding contract #1). The
   registry mounts the Editor view only on navigation. `renderEditor()` stays
   exported as a lazy builder with no mount side effect: it builds (once) and
   caches the still-el() toolbar/panel/status-strip nodes the embeds use;
   `openFileInEditor`/`openThumbnailFileInEditor` keep calling it (:2852,
   :2866) while the Pack Manager is showing; its return value is no longer
   appended by the shell. The canvas-host/listener/overlay portion of
   `buildEditor()` and S07's session-start/session-end view handlers are
   deleted, and the controller's session-start event is removed from
   `startSession` (no listener is left: CanvasPanel builds the stage on session
   identity); the session-end event stays, now consumed by CanvasPanel's
   overlay close.
9. **Land per plan.md › Session protocol**, with this session's checks: the
   CSS byte-identity check and the checklist below.

## Deliberately out of scope

- Porting any panel markup (toolbar, tools panel, status strip — S09; right
  panel — S10), EffectControls internals, the FontPicker, or any eyedropper.
- Touching `dialogOpen()` gating semantics or any dialog behavior.
- Changing stage gesture code beyond the restore setter.
- `<StrictMode>` anywhere in `src/` (excluded by binding contract #3 — double-mount would build and
  destroy the stage twice).
- CSS files (byte-identical), icons (Icons rule), new aria/role attributes
  (UI-audience rule).

## Exit criteria

- `bun run build` + `bun test` pass; all five CSS files byte-identical.
- Stage-derived UI is right on the first paint: after opening an image, and
  after a tab switch away and back mid-session, the crop box is placed and
  Fit/Cover/Long side/Resize show their real enabled state and titles (never
  "There is nothing to resize.") without any further click — `attachStage`'s
  notify drives the catch-up commit (step 3).
- Mid-drag warp/wand/erase: tab-switch away and back shows the session intact,
  the stage rebuilt, **pan/zoom restored**, undo trail intact, and no stroke
  cancelled by cleanup.
- Ctrl+S/V/X, Alt suppression, the Esc cascade and `strokeInProgress()`
  save-refusal behave exactly as before.
- A mid-typing tab switch commits the text overlay, never eats it; grep:
  no `close()` call in any unmount cleanup.
- The message row, the empty state (with Open image) and the workspace
  visibility render from controller state only: grep proves the driver no
  longer writes `message`, `empty.hidden`, `workspace.hidden` or
  `openButton.disabled`.
- The embedded imperative toolbar/panels keep updating between controller
  notifies — tool switching and busy/disabled states change without a
  remount (the EditorApp version-keyed `useLayoutEffect` driver).
- Workspace DOM order is toolsPanel, canvasHost, layersPanel (rendered DOM
  check); after a remount the session's listener order is stage first,
  controller forwarder second (unit check or temporary assertion).
- After three tab-switch round trips, one drag-drop handler and one set of
  document listeners are live (one drop outline, one drop open).
- Grep: no `<StrictMode>` anywhere in `src/`.
- Grep: the stage effect's dependency array is exactly session identity; no
  other effect owns a gesture or `editAsync` lifetime.
- Windows checklist (below) passed — this session's list is the keyboard- and
  window-management-heavy one (risk #6).
- PR merged with `gh pr merge <N> --merge`.

## Review-cycle coverage

- The keydown guard ladder moved as a unit with identical order and guard
  expressions (line-by-line against git history; the Ctrl+S
  `preventDefault` still fires before the no-session return, as at
  :2599–2601); only the `view.isConnected` checks are gone.
- The stage effect: deps exactly `[session identity]`; the re-assert list
  matches startSession's (:1237–1253) plus `setInteractive(!busy)`, the
  restore and the preview override; cleanup does transform-save, detach,
  destroy and nothing else.
- The cleanups S08 adds — the stage effect's (save transform, detach,
  destroy), the text overlay's (blur a leftover open overlay so it commits),
  the document listeners' removal and the drag-drop unlisten — none cancels a
  command: no effect can cancel a pending `editAsync`, an in-flight wand fill
  or a `run()`.
- No closure captured a stage instance: all stage references inside callbacks
  go through `controller.stage` (grep for `stage)` captures).
- The ref-embed helper never re-parents or re-diffs the embedded nodes
  (re-render must not rebuild the el() panels).
- shell.tsx change is the one editor-branch line; `renderEditor()` stays
  exported, mounts nothing, and its two hook-layer callers are unchanged.

## Owner / Windows checklist

1. All tool gestures: move/rect/lasso/wand (Shift and Alt drag)/warp
   drag/erase/restore — each usable, each undoable.
2. Zoom/pan persists across a tab switch and back; a newly opened image
   still fits.
3. Alt press/release does not flip zoom or open the system menu; AltGr still
   types (the 2026-11-24 Windows Alt rulings).
4. Ctrl+S refused mid-stroke with the reason; Ctrl+V/X paste/cut as before.
5. Drag an image file from Explorer onto the empty editor (first-run open) and
   onto an open session (drop target, incl. while a dialog is open → refused);
   repeat after switching tabs a few times — one open, not several.
6. Type in the text overlay while panning; switch tabs mid-typing — the text
   commits.
7. Esc cascade still works in order (effect → text → selection).

## Risks and fallbacks

- **Effect cleanup cancels what today always finishes** (risk #1): the
  cleanups S08 adds (listed under Review-cycle coverage) only tear down view
  objects; the mid-drag tab-switch exit test targets exactly this. If a
  gesture cannot survive remount, the fix is moving more state into the
  controller — never an effect-owned cancellation.
- **Stage rebuild loses Konva-held view state** (risk #2): the
  `viewTransform` cache + restore is the one deliberate deviation from today
  (a rebuilt stage), contained here where it is testable in isolation.
- **Keyboard contract drift** (risk #6): ladder moves as a unit; Windows
  checklist this session, not at the end of the phase.
- Fallback if the session overruns: the drop-target state can slip to S09
  (it doesn't gate the toolbar/panel ports; it then lands as S09's contingent
  step 0b, S09 › Work plan). Only the state slips: step 6's registration still
  lands in EditorApp.tsx's drag-drop effect, and the slipped `setDropTarget`
  (:2736–2740, body unchanged except that it reads `emptyRef.current` /
  `canvasHostRef.current` for `empty` / `canvasHost`) lives in that effect as an interim, writing the
  `drop-target` class through refs — `emptyRef` on EditorApp's own empty div,
  and `canvasHostRef`, which EditorApp passes to CanvasPanel as a prop that
  CanvasPanel attaches to `canvasHost` (step 8 deletes the lazy build's
  canvas-host code, so nothing else holds either element). The slip is allowed only if the mid-drag tab-switch,
  the text-overlay commit and the Alt/Ctrl items already pass — those are
  non-negotiable for this session to land. The keyboard-ladder move (step 5)
  may slip to S09 too, decided by a mid-session check once steps 1–4 and 7–8
  build: if the EditorApp mount, CanvasPanel and the overlay have not yet
  passed a local smoke (open, gesture, tab switch and back, overlay commit),
  the ladder stays in the el() build for this PR — registered from
  `renderEditor()`'s lazy build as today, its `view.isConnected` checks
  intact and pointed at EditorApp's top-level rendered element (the `.view`
  div, held in a ref that EditorApp hands to the lazy build through
  `setEditorViewElement(el)` in a layout effect and clears to `null` in its
  cleanup; React removes that element on unmount, so `isConnected` goes false
  — never the shell's content leaf, which stays connected), so it acts only
  while mounted; its `textOverlay.isOpen` guard reads the overlay CanvasPanel
  registered on the controller (step 7; `isOpen` on that registered
  instance, false when none is registered), since the lazy build's own
  `TextEditOverlay` is deleted by this session (step 8) — and moves as S09's step 0 (S09 › Work plan). This session's Alt/Ctrl Windows
  items are still checked here (on the unchanged ladder) and re-run in S09
  after the move. Never split the ladder itself: it moves
  whole or not at all.
