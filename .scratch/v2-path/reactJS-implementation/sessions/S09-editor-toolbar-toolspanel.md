# S09: Toolbar + ToolsPanel + effect controls embed (Phase 4)

## Goal

Port the Editor's top toolbar and the left tools panel from el() to JSX,
embedding EffectControls' imperative blocks at their slots, with every class
string, title (including blocked-title reasons), disabled rule and DOM shape
identical to today. When this session ends, `Toolbar` and `ToolsPanel` are React
components subscribed to the controller, the effect section of the old
`refresh()` runs as ToolsPanel's post-render `useLayoutEffect`, and the
toolbar/tools-panel el() code is gone from `src/views/editor.ts`.

## Preconditions

- S08 landed: `EditorApp` mounts, `CanvasPanel` owns the stage,
  `ImperativeNode` exists, the controller carries `viewTransform`/`mounted`.
- S07's controller holds `busy`, `tool`, `freeSide`, `brushSize`, `tolerance`,
  `feathered`, `basis`, `fonts`/`fontsProblem`, `nextStyle`, `lastFormat` and
  the command methods (`run`, `setTool`, …).

## Files touched

| Path | Status |
|---|---|
| `src/views/editor/Toolbar.tsx` | new |
| `src/views/editor/ToolsPanel.tsx` | new |
| `src/views/editor/EditorApp.tsx` (from S08) | modified — the toolbar/panel `ImperativeNode` embeds become `<Toolbar/>`/`<ToolsPanel/>` |
| `src/views/editor.ts` | modified — toolbar + tools-panel el() build sections deleted (still holds right-panel + text + save sections) |
| `src/editor/view/effect-controls.ts` (346 LOC) | **untouched** — its blocks embedded via `ImperativeNode` |
| `src/editor/view/eyedropper.ts`, `font-picker.ts` | untouched (embeds) |

## Work plan

1. **Spec-first port:** before writing JSX, extract the old markup from git
   history (the pre-S09 `src/views/editor.ts`). The old el() code is the spec;
   port line-by-line. Every class string and title must appear identically in
   the new tree — this is the session's exit test.
2. **`Toolbar.tsx`:** the top row (Open/Add/Undo/Redo/Fit/Cover/Long
   side/Resize/Guide/Crop/Reset view/Close/Save…) as it is built and then
   label/disabled/title-synced in `refresh()` (:2323–2579, e.g.
   `openButton.disabled = busy` :2334, `b.disabled = busy` :2351). Subscribes
   via `useSyncExternalStore`; renders from controller state; buttons call
   controller commands (`run(saveSession)` etc.) — no new commands invented.
   Every blocked-title rule from `refresh()` must survive: the reason strings
   of the §2-style blockers, notably `sizeToolBlocker(tool, doc, content,
   entered, constraints, freeSide)` (:2439, using `stage.contentBounds()`,
   stage.ts:463) for the four sizing tools, and the busy/save-refusal reasons.
3. **`ToolsPanel.tsx`:** the left tab set — select/paint/effects/text
   sections with the `TOOL_PANEL` surfacing rule (tool buttons switch tool via
   `setTool`; the panel surfaces the section of the active tool, exactly as
   the el() version does — copy the surfacing logic, do not re-derive it).
   - EffectControls' blocks embed at their slots via `ImperativeNode`:
     `outlineBlock`, `glowBlock`, `warpBlock`, `actions` (the fields exported
     at effect-controls.ts:60–66 — `outlineBlock` :60, `glowBlock` :62,
     `warpBlock` :64, `actions` :66).
   - The side input (freeSide) stays an **uncontrolled** input synced with a
     `document.activeElement` guard (one of the five focus-preservation
     guards) — a controlled re-render would clobber half-typed input.
   - The FontPicker stays an imperative embed in the text section until S11
     (binding contract #2: combobox swap is optional post-adoption, never an
     exit criterion). The eyedroppers stay embeds (`eyedropperButton`,
     `EYEDROPPER_STEM`, `EYEDROPPER_TITLE` — the single source of the
     §2 strings, kept as-is per the phase's island table).
4. **Post-render effect sync — one owner per line:** a `useLayoutEffect` in
   ToolsPanel runs only its own panel's part of the old `refresh()` after
   every render — `effectControls.update(...)` with the same state inputs,
   then `preview.request(previewRequest())` (the closing lines of `refresh()`
   at :2575–2579, minus the stage-setter line). Same inputs, same order.
   The stage setters are **CanvasPanel's**, not ToolsPanel's: per plan.md
   binding contract #4 and the phase's dissolution rule, `stage?.setCropBox`
   and `stage?.setBrushRadius(effectControls.warp.radius)` live in
   CanvasPanel's own version-keyed effect (controller-mediated, per S08's
   split), and this session those lines leave EditorApp's interim
   `refresh()` driver (S08 step 4) — one owner, one location, never three.
   ToolsPanel's layout effect never touches the stage.
5. **Delete** the toolbar/tools-panel el() sections from
   `src/views/editor.ts`; the remaining el() code (right panel, text
   controls, save flows, message row) stays for S10/S11.

## Deliberately out of scope

- Porting EffectControls internals (slider wheel/typed-commit/blur contracts
  and never-clobber-while-typed sync stay hand-tuned vanilla — the phase's
  island table rules them **Wrap, not port**).
- The FontPicker (imperative embed until S11; combobox port is post-adoption).
- The eyedroppers (ref-embed only; porting would fork them).
- The right panel, text tool controls, save flows (S10/S11).
- CSS files (byte-identical), icons, new aria/role attributes.
- No `<StrictMode>` anywhere (binding contract #3 — double-invoked effects
  would churn the Konva stage and double-run the ToolsPanel
  `effectControls.update()`/`preview.request()` sync).

## Exit criteria

- Build + tests pass; all five CSS files byte-identical.
- Every class string and title of the old toolbar/tools-panel markup appears
  identically in the new tree (diff the rendered DOM against a capture from
  the pre-S09 build, or verify line-by-line against git history).
- Sizing-tool blockers (`sizeToolBlocker` with `stage.contentBounds()`)
  produce the same titles/enabled states at odd sizes as before.
- Tool-tab surfacing follows the active tool exactly as before.
- Effect sliders commit by drag, wheel-hover and typing; invalid input
  reverts; Esc reverts + blurs (EffectControls untouched, so any drift is a
  wiring bug — the sync inputs must match the old `update()` call exactly).
- Apply/Cancel behave as before, including Outline-on-text (restyle) vs
  Glow-on-text (bake).
- Review-cycle converged; PR lands via `gh pr merge --merge`.

## Review-cycle coverage

- DOM identity: class names, titles, button order and nesting identical to
  the pre-S09 build (the reviewer's primary axis this session).
- The `useLayoutEffect` sync block passes exactly the inputs the old
  `refresh()` passed to `effectControls.update()` / `preview.request()` —
  stale or missing state would show as a silently stale preview.
- No EffectControls/FontPicker/eyedropper internals changed (grep the diff:
  those files must be absent).
- The side input is uncontrolled with the activeElement guard intact.
- Toolbar disabled states cover busy, save-refusal and sizing blockers with
  the exact reason strings.

## Owner / Windows checklist

1. Hover a sweep of disabled controls — each shows its §2 reason in the
   title (blocked, not silent).
2. The four sizing tools' enable rules at odd image sizes (Fit/Cover/Long
   side/Resize): enabled exactly when their blocker passes.
3. Effect sliders: commit by drag, by wheel over the slider, by typing a
   value (invalid reverts on blur/Enter; Esc reverts and blurs).
4. Apply/Cancel on a raster layer vs a text layer: Outline-on-text restyles,
   Glow-on-text bakes — the distinction preserved.
5. Switch tools across sections — the left panel surfaces the right section.
6. Type into the side-length field and tab away mid-typing elsewhere — no
   clobbering.

## Risks and fallbacks

- **Focus-clobbering by re-render** (risk #4): uncontrolled inputs + explicit
  sync in layout effects with the same `document.activeElement` guards;
  EffectControls/FontPicker not ported at all.
- **DOM drift** (class/title/attribute mismatches): the git-history spec
  port is the mitigation; the reviewer diffs the rendered tree, not the code
  style.
- Fallback if the session overruns: the text-section portion of ToolsPanel
  (FontPicker embed + text controls skeleton) can slip to S11 wholesale — it
  is S11's subject anyway — as long as the toolbar, the tab set and the
  EffectControls embed land.
