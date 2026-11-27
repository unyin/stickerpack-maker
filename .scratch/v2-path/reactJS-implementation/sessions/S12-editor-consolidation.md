# S12: Editor consolidation — sweep, race audit, Windows check (Phase 4)

Corrections to the phase file: the phase says "the 27 sites in git history are
the checklist" for `refresh()` call sites. Measured at HEAD: the 27
`refresh()` occurrences in `src/views/editor.ts` are **18 real call sites +
8 comment references** (:305, :338, :342, :908, :1248, :1358, :1996, :2024)
**+ the definition** (`function refresh(): void` at :2323) — and the grep
misses the `session.subscribe(refresh)` wiring at :1249, which must be mapped
too. So the audit checklist is the **18 call sites plus the :1249 subscribe
wiring**. Everything else in the phase file verified as written.

## Goal

Close Phase 4: delete the last el() build path from `src/views/editor.ts` (the
file keeps only the mount entry, the hook layer and the `confirm*` helpers,
< ~400 LOC), run the written race/cleanup audit over the whole Editor React
tree, converge the review-cycle, and put the owner through a fresh-eyes
Windows pass of the S08/S11 lists plus a text-heavy session. When this session
ends, the Editor is a React view over the controller, all phase-4 exit
criteria hold, and nothing remains to convert.

**This session absorbs into S11 if S07–S11 all landed clean** (the plan's
5-vs-6 swing) — the master plan's named compression lever. If S11's PR closed
with every S12 audit item already checked and the Windows lists already
fresh-eyed, S12 is cancelled and Phase 4 ends at S11. Decide at session start
by running the audit below against S11's HEAD: any failed item un-cancels it.

## Preconditions

- S07–S11 landed: controller, React root + CanvasPanel, Toolbar + ToolsPanel,
  right panel, text controls + save flows.
- The pre-S07 `src/views/editor.ts` (2,951 LOC) is reachable in git history —
  it is the spec for the audit (the 18 `refresh()` call sites plus the :1249
  `session.subscribe(refresh)` wiring, the keyboard ladder, the race guards).
- The owner has passed the S08 and S11 Windows lists on those sessions'
  builds.
- No `<StrictMode>` anywhere in `src/` (binding contract #3) — the fence
  raised in S01 must still hold at phase close; StrictMode-safety stays the
  post-adoption follow-up.

## Files touched

| Path | Status |
|---|---|
| `src/views/editor.ts` | modified — final deletion of the el() build path; keeps `renderEditor()` (mount entry), the hook layer (:2812+ / `setEditorNav` :2827 / `forgetEditorOrigin` :2836 / `openFileInEditor` :2851 / `openThumbnailFileInEditor` :2866) and the `confirm*` helpers (:2872–2940) |
| any residue the audit finds | as measured — e.g. `src/views/editor/EditorApp.tsx`, an `ImperativeNode` embed left without a consumer |

No CSS file, no island, no model file unless the audit finds a defect.

## Work plan

1. **Final deletion:** remove the remaining el() build code from
   `src/views/editor.ts`. The exported surface does not change — src/shell.tsx
   (the editor branch of `show()`, converted by S02; the mount call is today
   shell.ts:83), pack-manager and settings call sites stay untouched.
   Target: the file keeps the mount entry, hook layer and `confirm*` helpers,
   under ~400 LOC.
2. **Residue sweep:** grep the tree for dead imports, unused el() helpers,
   `ImperativeNode` embeds whose imperative source no longer exists, and any
   leftover module state in `src/views/editor.ts` (the `root ??=` cache must
   be gone — the controller is the module state since S07). The EditorApp
   interim refresh-driver effect is deleted with the last un-ported section
   (S08's seam design: with the toolbar, tools panel and right panel ported,
   its body is empty — remove the effect, not just its contents). Also retire
   `withMessage` from `src/ui.ts`: its last callers died in S01/S02/S06
   (first-run, settings, pack-view) and in S07–S08 (the editor's message
   row became controller state). Grep ui.ts's exports for remaining
   consumers before deleting — and leave `el()` itself alone: dialog.ts,
   combobox.ts, the `confirm*` helpers (:2872–2940) and eyedropper.ts still
   call it.
3. **The written audit** (each item checked against the diff history, results
   recorded in the PR):
   1. No effect owns a gesture or `editAsync` lifetime — commands are plain
      controller methods; the only cleanup in the tree is the stage effect's
      `stage.destroy()` and the text overlay's settle-commit.
   2. The stage effect's deps are exactly session identity (grep the dep
      arrays of `CanvasPanel`).
   3. No closure captured a stage instance: every stage reference goes
      through `controller.stage` (grep for captured `stage` outside the
      CanvasPanel effect).
   4. Every `refresh()` call site from the pre-S07 file maps to a controller
      mutation or a session notify — the checklist is the **18 real call
      sites + the `session.subscribe(refresh)` wiring at :1249** (the 27
      occurrences in git history = 18 call sites + 8 comment references
      (:305, :338, :342, :908, :1248, :1358, :1996, :2024) + the :2323
      definition; the :1249 wiring is invisible to the grep). Walk the list
      one by one and record the mapping; an unmapped site is a lost redraw.
   5. All five CSS files byte-identical (styles.css 449, dialog.css 45,
      combobox.css 72, editor.css 908, pack-manager.css 1285 = 2,759 lines).
   6. Build + tests green.
   7. Fast Refresh works on the new `.tsx` files (Phase 1's payoff, now
      real): edit a component in a running dev session and confirm it
      hot-swaps without losing editor state.
4. **Behavior-contract spot-checks** (binding contract #6, Editor items):
   the changed-files drain (Editor save → Pack Manager invalidation), the
   focus-preservation guards, the keydown guard ladder incl. the Windows
   Alt rulings, `run()`'s busy-gate, `editAsync`'s doc-identity refusal.
5. **Review-cycle to convergence** (AGENTS.md) over the whole phase-4 delta
   or the remaining delta since the owner's last tested state.
6. **Owner Windows pass:** fresh-eyes run of the S08 and S11 lists (both are
   re-run in full, not skimmed) plus the text-heavy session below.

## Deliberately out of scope

- Restyling anything; changing icons (Icons rule); adding a11y work beyond
  keeping existing attributes (UI-audience rule).
- StrictMode-safety (binding contract #3: follow-up, not an exit criterion).
- The FontPicker combobox swap, any SaveDialog port deferred by S11's
  decision, and the packPicker bridge (which survives the adoption if S11's
  decision kept save-dialog.ts imperative) — named post-adoption follow-ups,
  not Phase 4 work.
- New features, new commands, new CSS classes.

## Exit criteria

- `src/views/editor.ts` < ~400 LOC: mount entry + hook layer + `confirm*`
  helpers only; `grep -c "el("` in it ≈ 0.
- The written audit's seven items all pass, recorded in the PR.
- Build + tests pass; the five CSS files byte-identical (2,759 lines total).
- Grep clean: no captured stage instance; stage effect deps = session
  identity; no `root ??=`; no `StrictMode` anywhere in the editor root.
- Review-cycle converged; PR lands via `gh pr merge --merge`.
- Owner's Windows checklist (below) passes. Phase 4 done: the master plan's
  11–12 sessions complete (or 10–11 if this session was cancelled into S11).

## Review-cycle coverage

- The audit's item 4 is the reviewer's spine: the 18-site refresh mapping
  plus the :1249 `session.subscribe(refresh)` wiring,
  checked against git history, not against memory.
- Any new cleanup added since S08 beyond the two allowed ones
  (`stage.destroy()`, overlay settle) — the #1 cost risk of the whole
  adoption.
- DOM identity spot-checks on the panels converted in S09–S11 (a delta review
  may have missed class/title drift introduced then).
- Residue sweep correctness: deletions must not remove still-referenced
  exports (shell.tsx, pack-manager, settings call sites unchanged).

## Owner / Windows checklist

1. Re-run the S08 list in full: tool gestures, zoom/pan persistence across
   tab switch, Alt/AltGr behavior, Ctrl+S mid-stroke refusal, Explorer
   drag-drop onto empty editor and open session, overlay typing while
   panning, Esc cascade.
2. Re-run the S11 list in full: the save matrix incl. PNG over cap → WEBP
   offer → exhausted give-up, saved-note links navigating (and reporting
   gone after a re-point), text controls + eyedroppers + FontPicker,
   `lastFormat` persistence.
3. The text-heavy session (the analysis's "where a working port fails"):
   open an image, add text, type in the overlay, pick a font in the
   combobox, change colour via the eyedropper, move the text layer, undo to
   each step, save — every step must feel and read exactly as pre-adoption.

## Risks and fallbacks

- **Audit uncovers a lost redraw** (an unmapped refresh site): fix in this
  session — the mapping list exists precisely so a miss is findable in
  minutes, not in owner testing.
- **Fresh-eyes regression in an early-converted panel** (S09/S10 drift that
  passed its own review): fix forward in this session; if the fix is larger
  than a session, it becomes a follow-up PR before Phase 4 is called done —
  the phase does not close on a known regression.
- **Session overrun:** the Fast Refresh check (item 7) and the residue sweep
  can move to a small follow-up PR without gating the phase close — but the
  audit items 1–6 and the owner pass are non-negotiable. If the S11-absorption
  path was taken and the audit then fails, re-open S12 rather than patching
  S11 post-merge.
