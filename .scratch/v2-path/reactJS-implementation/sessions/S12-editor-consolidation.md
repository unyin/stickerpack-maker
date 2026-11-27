# S12: Editor consolidation — sweep, race audit, Windows check (Phase 4)

Anchors are `src/views/editor.ts` lines at commit `11bacb6` unless a file is named
(plan.md › Anchor base): read `git show 11bacb6:<file>` and find today's code by the
symbol named beside each line.

## Goal

Close Phase 4 and the adoption: delete the last el() build path from
`src/views/editor.ts` (the file keeps only the mount entry, the hook layer and the
`confirm*` helpers, < ~400 LOC), run the closing sweep and the written race/cleanup
audit over the whole Editor React tree, and put the owner through a fresh-eyes
Windows pass of the S08/S11 lists plus a text-heavy session. When this session
ends, the Editor is a React view over the controller, all phase-4 exit criteria
hold, and nothing remains to convert beyond the named survivors (the el()
islands of step 3, `packPicker` staying el(), and save-dialog.ts if S11 kept it
imperative).

**This session absorbs into S11 if S07–S10 each landed clean** (plan.md › Clean
landing; the plan's "4.6 absorbs into 4.5", the 5-vs-6 swing). S11 cannot judge its
own landing, so S11 takes the decision at its start on S07–S10 alone and runs this
file's Work plan and audit as its tail; any failed audit item un-cancels S12. Clean
landing requires that a session used none of its overrun fallbacks, so an S10
EmojiPanel hand-off to S11 rules absorption out. Under absorption the owner's pass
is S11's list plus this file's checklist items 1 and 3 (item 2 is S11's list, run
once). When S11 did not absorb it, this session runs as written.

## Preconditions

- S07–S11 landed: controller, React root + CanvasPanel, Toolbar + ToolsPanel,
  right panel, text controls + save flows.
- The pre-S07 `src/views/editor.ts` (2,951 LOC at `11bacb6`) is the spec for the
  audit (audit item 4's refresh checklist, the keyboard ladder, the race guards).
- The owner has passed the S08 Windows list on its session's build, and the S11
  list on S11's build (absorbed: S11's list runs once, in this pass, inside S11).
- No `<StrictMode>` anywhere in `src/` (binding contract #3) — the fence
  raised in S01 must still hold at phase close; StrictMode-safety stays the
  post-adoption follow-up.

## Files touched

| Path | Status |
|---|---|
| `src/views/editor.ts` | modified — final deletion of the el() build path; keeps `renderEditor()` (mount entry), the hook layer (:2812+ / `setEditorNav` :2827 / `forgetEditorOrigin` :2836 / `openFileInEditor` :2851 / `openThumbnailFileInEditor` :2866) and the `confirm*` helpers (:2872–2947, `isSaveShortcut` :2920 among them) |
| `src/ui.ts` | modified — `withMessage` removed (step 2); `el()` and the rest untouched |
| any residue the audit finds | as measured — e.g. `src/views/editor/EditorApp.tsx`, an `ImperativeNode` embed left without a consumer |

No CSS file, no island, no model file unless the audit finds a defect (`src/ui.ts` above is a view helper, not a model file).

## Work plan

1. **Final deletion:** remove the remaining el() build code from
   `src/views/editor.ts` (with `button()` :2949 if still present — its callers were
   the build). The exported surface does not change in this session. It is
   `renderEditor`, the hook layer, and the `confirm*` helpers + `isSaveShortcut`
   that S07/S08 exported when their callers moved to the controller and
   EditorApp (S11 step 6). The call sites in src/shell.tsx (the editor branch of
   `show()`, converted by S02; the mount call is shell.ts:83 at `11bacb6`),
   pack-manager and settings stay untouched. Target: the
   file keeps the mount entry, hook layer and `confirm*` helpers, under ~400 LOC,
   with exactly 8 `el(` calls, all in the `confirm*` helpers
   (`grep -cE '\bel\(' src/views/editor.ts` = 8).
2. **Residue sweep:** grep the tree for dead imports, unused el() helpers,
   `ImperativeNode` embeds whose imperative source no longer exists, and any
   leftover module state in `src/views/editor.ts` (the `root ??=` cache must
   be gone — the controller is the module state since S07). The EditorApp
   interim refresh-driver effect is deleted outright (S08's seam design: with the
   toolbar, tools panel, right panel and text controls ported, S09–S11 each
   removed its section, so its body should be empty — remove the effect, not just
   its contents). Audit item 4 maps `refresh()` call sites, not driver lines, so
   a leftover line is checked here: each one still in the driver is either ported
   to its component's render or removed with a recorded reason, and audit item 8
   confirms no render or effect path calls a command. Also retire
   `withMessage` from `src/ui.ts`: its last callers died in S01/S02/S06
   (first-run, settings, pack-view) and in S07–S08 (the editor's message
   row became controller state). Grep ui.ts's exports for remaining
   consumers before deleting — and leave `el()` itself alone (survivors in step 3).
3. **Adoption-wide closing sweep** (this is the adoption's last session; record the
   results in the PR):
   - Every content view mounts through `mountView()` (first-run, settings, Pack
     Manager, Editor); no view is built by an el() call outside the registry.
   - `el()` remains only in the listed survivors. Editor side (`grep -cE '\bel\('`
     at `11bacb6`): `src/dialog.ts` (4), `src/combobox.ts` (5),
     `src/editor/view/eyedropper.ts` (1), `src/editor/view/effect-controls.ts`
     (12), `src/editor/view/save-dialog.ts` (22, only if S11 kept it imperative),
     the 8 `confirm*` calls in `src/views/editor.ts`, and `src/ui.ts` (1 — `el()`'s
     own definition, `export function el(`, which the grep matches); plus any non-Editor
     survivor Phases 2–3 recorded in their PRs. Any other `el(` call is a stray
     view build.
   - No `StrictMode` anywhere in `src/` (`git grep -n StrictMode -- src` empty).
4. **The written audit** (each item checked against the diff history, results
   recorded in the PR):
   1. No effect owns a gesture or `editAsync` lifetime, and **no cleanup cancels a
      command** — commands are plain controller methods. List every cleanup in
      the tree and show each only tears down its own resource: start from
      S08's list (its Review-cycle coverage: the stage effect's transform save,
      `detachStage()` and destroy; the text overlay's blur-to-commit of a
      leftover open overlay and its unregistration; the document
      keydown/keyup/paste listener removal; the drag-drop unlisten), then add
      any cleanup added since.
   2. The stage effect's deps are exactly session identity (grep the dep
      arrays of `CanvasPanel`).
   3. No closure captured a stage instance: every stage reference goes
      through `controller.stage` (grep for captured `stage` outside the
      CanvasPanel effect).
   4. Every `refresh()` call site from the pre-S07 file maps to a controller
      mutation or a session notify — the checklist is the **18 real call
      sites + the `session.subscribe(refresh)` wiring at :1249** (the 27
      occurrences at `11bacb6` = 18 call sites + 8 comment references
      (:305, :338, :342, :908, :1248, :1358, :1996, :2024) + the :2323
      definition; the :1249 wiring is invisible to the grep). Walk the list
      one by one and record the mapping; an unmapped site is a lost redraw.
   5. All five CSS files byte-identical (styles.css 449, dialog.css 45,
      combobox.css 72, editor.css 908, pack-manager.css 1285 = 2,759 lines).
   6. Build + tests green.
   7. Fast Refresh works on the new `.tsx` files (Phase 1's payoff, now
      real): edit a component in a running dev session and confirm it
      hot-swaps without losing editor state. This item alone may move to a
      follow-up PR (see Risks); record it in this PR if it does.
   8. **The driver is gone and no render/effect path calls a command.**
      EditorApp holds no interim refresh-driver effect (`git grep -n 'refresh('
      -- 'src/views/editor*'` finds no call; comments quoting the word are not
      hits). No command is called synchronously in a component body or an
      effect body (plan.md contract #4): commands are entered only from event
      handlers, shortcuts and async continuations. Check it by running
      `git grep -nE 'controller[.?!]' -- src/views/editor/` (extended regex) and reading every
      hit — broad on purpose, so it also catches optional-chained calls
      (`controller.method?.(…)`) and calls chained through a controller property
      (`controller.session.select(…)`, `controller.session!.x(…)`), whose session
      mutations notify through the forwarder; components reach the
      controller only under the name `controller` (no alias, no destructured
      method), so the reviewer first confirms `git grep -nE
      '(=|:)\s*controller\b|\{[^}]*\}\s*=\s*controller'` under
      `src/views/editor/` finds no alias or destructuring, and greps any it does
      find the same way. Every hit of the call grep is read: a hit is allowed
      when it sits inside a handler an effect registers (keydown, drag-drop,
      `onViewChange` → `setZoom`; event paths — `setZoom`'s immediate call on
      registration inside the stage effect included, since it notifies the
      view channel only, contract #4) or a JSX
      event prop, or when it is the named lifecycle exception, CanvasPanel's
      stage effect calling `attachStage()` and its cleanup `detachStage()`
      (the only *notifying* calls allowed in an effect body). Two silent
      kinds of effect-body call are also allowed, and neither may notify:
      silent registrations (the text-overlay register/unregister, S08) and
      silent consumes of a pending value (ToolsPanel clearing
      `toleranceValue` once applied, S09; EmojiPanel clearing `emojiDraft`
      once written, S10 — S11 step 0 if the EmojiPanel slip fired); for each, read the controller method and confirm
      it does not notify. Any other command call in a render body or directly in an effect body
      fails (state reads and `subscribe`/`getSnapshot` are not commands). The
      normalisations today's `refresh()` made by calling a command — the
      effect-basis discard `setTool("move")` (:2360–2366) — live in the
      controller's pre-notify step (S07), as does the emoji-leaf
      reset-to-Layers rule (S10), so neither appears in any effect.
5. **Behavior-contract spot-checks** (binding contract #6, Editor items):
   the changed-files drain (Editor save → Pack Manager invalidation), the
   focus-preservation guards, the keydown guard ladder incl. the Windows
   Alt rulings, `run()`'s busy-gate, `editAsync`'s doc-identity refusal, and the
   reveal-scroll timing (both right-panel lists reveal on every render and again
   on tab show, S10).
6. **Land per plan.md › Session protocol.** The review-cycle covers the whole
   phase-4 delta or the remaining delta since the owner's last tested state; the
   owner's Windows pass is the fresh-eyes run below (the S08 and S11 lists re-run
   in full, not skimmed, plus the text-heavy session).

## Deliberately out of scope

- Restyling anything; changing icons (Icons rule). Screen-reader and Tab-only
  access are out of scope (UI-audience rule): existing aria/role attributes stay
  as they are; visual contrast stays in scope.
- StrictMode-safety (binding contract #3: follow-up, not an exit criterion).
- The FontPicker combobox swap and a SaveDialog port if S11 kept it imperative —
  named post-adoption follow-ups, not Phase 4 work. `packPicker` stays el(); its
  port is the named follow-up.
- New features, new commands, new CSS classes.

## Exit criteria

- `git grep -n 'withMessage' -- src` → no hits.
- `src/views/editor.ts` < ~400 LOC: mount entry + hook layer + `confirm*`
  helpers only; `grep -cE '\bel\(' src/views/editor.ts` = 8, all in the
  `confirm*` helpers.
- The closing sweep (step 3) is clean and recorded in the PR.
- Audit items 1–6 and 8 pass, recorded in the PR; item 7 passes or has its follow-up PR
  recorded.
- Build + tests pass; the five CSS files byte-identical (2,759 lines total).
- Grep clean: no captured stage instance; stage effect deps = session
  identity; no `root ??=`; no `StrictMode` anywhere in `src/`.
- Windows checklist passed.
- PR merged with `gh pr merge <N> --merge`. Phase 4 done: the master plan's
  11–12 sessions complete (or 10–11 if this session was absorbed into S11).

## Review-cycle coverage

- Audit item 4 is the reviewer's spine: its refresh mapping, checked against
  `11bacb6`, not against memory.
- Any cleanup added since S08 beyond audit item 1's list — the #1 cost risk of the
  whole adoption.
- DOM identity spot-checks on the panels converted in S09–S11 (a delta review
  may have missed class/title drift introduced then).
- Residue and closing sweep correctness: deletions must not remove
  still-referenced exports (shell.tsx, pack-manager, settings call sites
  unchanged).

## Owner / Windows checklist

1. Re-run the S08 list in full: tool gestures, zoom/pan persistence across
   tab switch, Alt/AltGr behavior, Ctrl+S mid-stroke refusal, Explorer
   drag-drop onto empty editor and open session, overlay typing while
   panning, Esc cascade.
2. Re-run the S11 list in full: the save matrix incl. PNG over cap → WEBP
   offer → exhausted give-up, saved-note links navigating (and reporting
   gone after a re-point), text controls + eyedroppers + FontPicker,
   `lastFormat` persistence.
3. The text-heavy session (the
   [analysis](../../research/react-adoption-analysis.md)'s "where a working port
   fails"): open an image, add text, type in the overlay, pick a font in the
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
- **Session overrun:** the Fast Refresh check (audit item 7) can move to a small
  follow-up PR without gating the phase close; audit items 1–6 and 8, the closing sweep
  and the owner pass are non-negotiable. If the S11-absorption path was taken and
  the audit then fails, re-open S12 rather than patching S11 post-merge.
