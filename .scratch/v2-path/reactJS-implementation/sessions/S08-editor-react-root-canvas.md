# S08: React root + CanvasPanel — the Konva bridge (Phase 4)

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

- S07 landed: the `EditorController` singleton exists at
  `src/editor/app/editor-controller.ts` (methods per S07), hooks are headless.
- Phases 1–3 contracts: `mountView()` registry (exactly one view mounted at a
  time, unmount-before-clear-before-mount), navigator seam, dialog/combobox
  islands, **no `<StrictMode>`** (binding contract #3).
- `src/views/editor.ts` still contains the el() build for toolbar/panels — it
  stays this session and is consumed via the ref-embed helper.
- `ImperativeNode` already exists at `src/react/ImperativeNode.tsx` (created
  in S04) — this session imports it; no helper is created here.

## Files touched

| Path | Status |
|---|---|
| `src/views/editor.ts` | modified — mount switches to `mountView("editor", …)`; the canvas-host/listener/overlay code of `buildEditor()` deleted |
| `src/shell.tsx` (S02's conversion of shell.ts) | modified — the editor branch of `show()` (today `content.append(renderEditor())` at shell.ts:83), one line |
| `src/views/editor/EditorApp.tsx` | new |
| `src/views/editor/CanvasPanel.tsx` | new |
| `src/react/ImperativeNode.tsx` (from S04) | **untouched** — imported for the toolbar/panel embeds |
| `src/editor/app/editor-controller.ts` (from S07) | modified — add `viewTransform` cache + `mounted` flag |
| `src/editor/view/stage.ts` (1,286 LOC) | modified — one small addition only: a way to snapshot/restore pan/zoom into a rebuilt stage |

`src/editor/model/session.ts` and every other island/model file untouched
beyond the stage addition.

## Work plan

1. **stage.ts addition (the only stage change allowed this phase):** add a
   getter that snapshots the current view transform (Konva-held pan/zoom —
   the stage is `draggable`, zoom via `zoomAtClient`) and a setter that
   restores it into a stage instance. Today an unmount silently resets the
   view to fit; with it, CanvasPanel restores pan/zoom across remounts. No
   gesture code touched.
2. **Controller additions:** a `viewTransform` field (written by CanvasPanel
   before `stage.destroy()`, read on rebuild) and a `mounted` flag (the
   keydown ladder's second guard — the standalone no-session/not-mounted
   return after the Ctrl+S `preventDefault`). Both are ordinary
   version-bumped fields.
3. **`ImperativeNode` (from S04, `src/react/ImperativeNode.tsx`):** the
   ~15-line ref-embed helper — given a function
   returning an `HTMLElement` (or the element itself), renders a host div and
   appends the node on mount / removes it on unmount, never re-diffing its
   children. S08 imports it; no new file is created. This is how the
   not-yet-ported toolbar/panels (from the
   remaining el() build in `src/views/editor.ts`) stay on screen inside the
   React tree this session.
4. **`EditorApp.tsx`:** subscribes via
   `useSyncExternalStore(controller.subscribe, () => controller.version)`
   (mutable-snapshot pattern, binding contract #4) and renders the message
   row, the empty state, and the workspace skeleton — with the
   still-imperative toolbar/panels embedded through `ImperativeNode`.
   - The message row renders **from controller state** (S07's
     `{ text, tone, links }` fields). No code path may write DOM React owns:
     the `say()`/`withMessage` two-writers violation is already gone — S07
     moved the message to controller state — and EditorApp's render is the
     single writer.
   - EditorApp derives the empty state and the workspace's visibility from
     **session presence** (`controller.session === null`), not from any
     imperative flag.
   - **The interim refresh driver:** a single EditorApp `useLayoutEffect`
     keyed on `controller.version` calls the surviving sections of the old
     `refresh()` — everything not yet ported (toolbar, tools panel, right
     panel) must keep updating between controller notifies, because
     `ImperativeNode` never re-diffs its embedded nodes. Each port session
     (S09/S10/S11) removes its own section from this driver; S12 deletes the
     remainder. Without the driver the embedded imperative panels freeze
     between notifies and the owner checklist (tool switching, busy states)
     cannot pass.
   **Tree order matters:** CanvasPanel is placed first among the workspace
   children so the canvas redraws before the panels measure (refresh()
   dissolution ordering rule).
5. **`CanvasPanel.tsx`:** owns `canvasHost`. A `useRef` + `useEffect` keyed on
   **session identity alone** does: `new EditorStage(canvasHost, session)`
   (constructor `(container: HTMLDivElement, session: EditorSession)`,
   stage.ts:346), wire the stage callbacks to controller methods, restore the
   cached `viewTransform`, and re-assert `setTool` /
   `setCropGuidesVisible` / `setBrushRadius` / the in-flight EffectPreview
   override on remount. Cleanup: save the transform to the controller, then
   `stage.destroy()` — **this is the only new cleanup in the whole adoption**
   (risk #1), and its deps are session identity only; brush radius, crop box
   and preview override ride separate effects/setters so nothing else can
   cancel a gesture.
6. **Keyboard ladder as a mount effect:** the document-level
   keydown/keyup/paste listeners (src/views/editor.ts:2597–2735) become mount
   effects with the keydown guard ladder copied as a unit, in this exact order:
   Ctrl+S `preventDefault` first (`if (view.isConnected && isSaveShortcut(e))
   e.preventDefault()` — never reaches the webview's save page, even while
   busy) → the standalone mounted/no-session return (`if (!current ||
   !view.isConnected) return`, via the `mounted` flag) → Alt suppression →
   `textOverlay.isOpen` → busy/downloadNote → isTextTarget → pick/lasso
   keys → `shortcutOf` → undo/redo/save/cut/Esc-cascade/Delete. Any
   reordering shows up as Alt-menu
   or shortcut regression on Windows (risk #6) — do not "improve" the ladder.
   The save-refusal guard `saveRefusal(stage?.strokeInProgress() ?? false,
   current.doc, constraints)` (:2649) keeps its exact reason text.
7. **Drag-drop registration as a mount effect:** over/enter sets
   `setDropTarget(!dialogOpen())` (:2745); the drop plan stays
   `dropPlan(payload.paths, kind, busy, dialogOpen())` (:2750).
8. **Text overlay:** `TextEditOverlay` (built today at :1027 as
   `new TextEditOverlay(canvasHost, …)`) is owned by CanvasPanel. Mount
   cleanup **commits via the overlay's own settle path rather than dropping
   it** — a mid-typing tab switch commits the text, never eats it.
9. **Mount switch:** `renderEditor()` in `src/views/editor.ts` becomes the
   `mountView("editor", …)` entry creating the React root; `src/shell.tsx`'s
   editor branch of `show()` (S02's conversion; the
   `content.append(renderEditor())` line, today shell.ts:83) changes one line
   to mount through the registry (unmount-before-clear-before-mount order per
   binding contract #1). The toolbar/panel el() build code still present is
   what `ImperativeNode` embeds; the canvas-host/listener/overlay portion of
   `buildEditor()` is deleted.

## Deliberately out of scope

- Porting any panel markup (toolbar, tools panel, right panel — S09/S10),
  EffectControls internals, the FontPicker, or any eyedropper.
- Touching `dialogOpen()` gating semantics or any dialog behavior.
- Changing stage gesture code beyond the view-restore addition.
- StrictMode (excluded by binding contract #3 — double-mount would build and
  destroy the stage twice).
- CSS files (byte-identical), icons (Icons rule), new aria/role attributes
  (UI-audience rule).

## Exit criteria

- Build + tests pass; all five CSS files byte-identical.
- Mid-drag warp/wand/erase: tab-switch away and back shows the session intact,
  the stage rebuilt, **pan/zoom restored**, undo trail intact, and no stroke
  cancelled by cleanup.
- Ctrl+S/V/X, Alt suppression, the Esc cascade and `strokeInProgress()`
  save-refusal behave exactly as before.
- A mid-typing tab switch commits the text overlay, never eats it.
- The message row renders from controller state only: grep proves no code
  path writes message DOM that EditorApp owns (the `say()`/`withMessage`
  two-writers violation died in S07).
- The embedded imperative toolbar/panels keep updating between controller
  notifies — tool switching and busy/disabled states change without a
  remount (the EditorApp version-keyed `useLayoutEffect` driver) — and the
  empty state / workspace visibility derive from session presence.
- Grep: no `StrictMode` import anywhere in `src/` — the fence from S01
  still holds (double-mount would build and destroy the stage twice).
- Grep: the stage effect's dependency array is exactly session identity; no
  other effect owns a gesture or `editAsync` lifetime.
- Review-cycle converged; PR lands via `gh pr merge --merge`.
- Windows checklist (below) passes — this session's list is the keyboard- and
  window-management-heavy one (risk #6).

## Review-cycle coverage

- The keydown guard ladder moved as a unit with identical order and guard
  expressions (line-by-line against git history; the Ctrl+S
  `preventDefault` fires before the mounted/no-session return, exactly as at
  :2599–2601).
- The stage effect: deps exactly `[session identity]`; cleanup does
  transform-save-then-destroy and nothing else; no effect can cancel a
  pending `editAsync` or in-flight wand fill.
- No closure captured a stage instance: all stage references inside callbacks
  go through `controller.stage` (grep for `stage)` captures).
- The ref-embed helper never re-parents or re-diffs the embedded nodes
  (re-render must not rebuild the el() panels).
- shell.tsx change is the one editor-branch line; `renderEditor()`'s export
  signature unchanged.

## Owner / Windows checklist

1. All tool gestures: move/rect/lasso/wand (Shift and Alt drag)/warp
   drag/erase/restore — each usable, each undoable.
2. Zoom/pan persists across a tab switch and back.
3. Alt press/release does not flip zoom or open the system menu; AltGr still
   types (the 2026-11-24 Windows Alt rulings).
4. Ctrl+S refused mid-stroke with the reason; Ctrl+V/X paste/cut as before.
5. Drag an image file from Explorer onto the empty editor (first-run open) and
   onto an open session (drop target, incl. while a dialog is open → refused).
6. Type in the text overlay while panning; switch tabs mid-typing — the text
   commits.
7. Esc cascade still works in order (effect → text → selection).

## Risks and fallbacks

- **Effect cleanup cancels what today always finishes** (risk #1): the only new
  cleanup is `stage.destroy()`; the mid-drag tab-switch exit test targets
  exactly this. If a gesture cannot survive remount, the fix is moving more
  state into the controller — never an effect-owned cancellation.
- **Stage rebuild loses Konva-held view state** (risk #2): the
  `viewTransform` cache + restore is the one deliberate deviation from today
  (a rebuilt stage), contained here where it is testable in isolation.
- **Keyboard contract drift** (risk #6): ladder moves as a unit; Windows
  checklist this session, not at the end of the phase.
- Fallback if the session overruns: the text-overlay settle-path polish and
  the drop-target effect can slip to S09 (they don't gate the
  toolbar/panel ports), provided the mid-drag tab-switch and Alt/Ctrl items
  already pass — those are non-negotiable for this session to land.
