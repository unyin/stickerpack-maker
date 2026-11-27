# React adoption — implementation plan

Status: planning artifact (2026-11-27), pre-verdict. This plan executes only after the
Phase 0 decisions land: the framework ADR (React 19, adoption-only), ticket 08's
look-and-feel verdict, and the sequencing call vs tickets 01/02 (see
[react-adoption-analysis.md](../research/react-adoption-analysis.md), "The one decision
this forces before any of it counts"). It feeds ticket 08/09; the Trekker epics/tasks of
ticket 10 would be created from it.

Methodology: four planning subagents drafted the phases (one per phase, verified against
the tree); the main session verified their claims by direct measurement and assembled this
plan; session-planner subagents then wrote [sessions/](sessions/), and clean reviewers
with fresh context reviewed the result. (Harness note: Vibe subagents; the AGENTS.md GLM-5.3
pinning is OpenCode-only and that budget is exhausted this month.)

## Hard constraints (owner-decided, 2026-11-27)

- **React adoption only.** React 19 + the current look kept. No Tailwind, no shadcn, no
  styling changes: all five CSS files stay byte-identical (styles.css 449, dialog.css 45,
  combobox.css 72, editor.css 908, pack-manager.css 1285 = 2,759 lines); React components
  emit the exact class names of today.
- **Hand-port everything.** No el()-to-JSX codemod.
- **No react-konva.** Konva stays a vanilla imperative leaf behind refs.
- **Pure model code reused verbatim**: all `*/model/*` files, `save.ts`, `shell-model.ts`,
  the api wrappers, `geometry.ts`.
- **Session** = one focused agent session (build + review-cycle included; owner test time
  excluded). Every session runs review-cycle to convergence before any owner testing
  (AGENTS.md), lands as a PR with a regular merge commit (`gh pr merge --merge`), and the
  surfaces it converts get their Windows check before they count as done.
- **UI audience rule** (AGENTS.md): existing aria/role attributes stay as-is; nothing new
  added. **Icons rule**: no icon change ships unviewed — this plan changes no icons.

## Phase overview

| Phase | Scope | Sessions | Detail |
|---|---|---|---|
| 0 | Decisions: framework ADR, ticket 08 verdict, sequencing | not counted | — |
| 1 | Scaffolding + first-run pilot | S01 (1) | [phase-1.md](phases/phase-1.md) |
| 2 | Shell, shared widgets, Settings | S02–S03 (2) | [phase-2.md](phases/phase-2.md) |
| 3 | Pack Manager | S04–S06 (3) | [phase-3.md](phases/phase-3.md) |
| 4 | Editor | S07–S12 (5–6) | [phase-4.md](phases/phase-4.md) |

**Total: 11–12 sessions, two named compression levers** (3.1+3.2 merge if both converge
clean; 4.6 absorbs into 4.5 if 4.1–4.5 land clean) → realistic floor ~10. This sits above
the analysis's 8–10 headline for a stated reason: the sessionization isolates the Editor
state bridge as its own zero-behavior-change session (S07) rather than mixing it with
React work, and budgets consolidation/review sessions per slice instead of assuming them.
Per-session plans: [sessions/](sessions/).

## Binding cross-phase contracts

These decisions bind all sessions; relitigating one mid-phase is plan drift.

1. **Incremental mounting.** Phase 1 builds a `mountView()` root-tracking helper in
   `src/react/`; Phase 2 extends it into a heterogeneous registry (React roots + el()
   DOM mounts, exactly one view mounted at a time, unmount-before-clear-before-mount
   order, shell root tracked separately and unmounted on re-boot). Phase 3/4 mount
   through it. Navigation across the React/el() boundary is a module-level navigator
   seam mirroring `setPackManagerListener`. Per-boot shell remount is the ADOPTED
   design (it reproduces today's scorched-earth boot semantics: fresh DOM per
   Library); the keyed persistent `<Shell key={libraryGeneration}/>` alternative is
   DROPPED — a post-adoption optimization option only, never scheduled.
2. **Dialog and Combobox stay imperative islands** (Phase 2's firm decision, recorded for
   ADR-0010 candidacy). `dialog.ts` (93) and `combobox.ts` (266) are untouched through the
   whole adoption. React content inside a dialog body happens only via the bridge
   pattern (Phase 3): `createRoot` into a detached div, the resulting element passed as
   the body node, the bridge root unmounted when the dialog's result settles. The
   FontPicker (Phase 4) is an imperative embed by default; a swap to a React combobox is
   an optional post-adoption follow-up, not an exit criterion.
3. **No `<StrictMode>`** anywhere during the adoption (double-invoked effects would churn
   the Konva stage and double-drain the changed-files queues). StrictMode-safety is a
   follow-up, not an exit criterion.
4. **Stores.** `useSyncExternalStore` over existing shapes: `packManagerState` +
   `setPackManagerListener` (Phase 2), a `PackViewStore` mirroring the EditorSession
   pattern (Phase 3), and the `EditorController` — the ~24 closure vars of
   `buildEditor()` (25 listed in early drafts; 24 measured) extracted into a
   subscribable singleton in S07 *before any React exists* (Phase 4). The S07/S08
   seam: the Editor message row is controller state from S07 (`say()` becomes
   mutation+notify); during S08–S11 the un-ported `refresh()` sections are driven
   from a single `EditorApp` `useLayoutEffect` keyed on `controller.version`,
   shrinking as panels port, deleted in S12. No component may write DOM that React
   owns. Mutable-snapshot pattern: version bump + notify; commands live outside React
   (event-driven, never effect-driven), so no effect cleanup can cancel what today
   always finishes.
5. **Imperative islands stay vanilla**: `stage.ts` (1,286; useRef + useEffect keyed on
   session identity, plus one view-transform restore addition in S08),
   `text-edit.ts`, `eyedropper.ts`, `warp-brush.ts`, `effect-preview.ts`,
   `effect-controls.ts` (blocks embedded at their slots), `font-picker.ts` (embed),
   both drag modules (`pack-list-drag.ts`, `reorder-drag.ts` — wired from JSX via
   `onPointerDown` + nativeEvent, code untouched), `reveal.ts`.
6. **Behavior contracts preserved verbatim**, each named in its session's exit criteria:
   the changed-files drain (Editor → Pack Manager invalidation), the focus-preservation
   guards (half-typed inputs survive background reloads), the keyboard guard ladders
   (the Editor keydown guard ladder incl. the Windows Alt rulings; pack-view
   keydown/drop guards via `dialogOpen()`), `run()`'s busy-gate, `editAsync`'s doc-identity refusal, the
   reveal-scroll timing, the SPM-17 emoji-select rollback.

## Verification record (main session, 2026-11-27)

Spot-checks measured directly against the tree, all reproducing: CSS line counts
(2,759 exact); `main.ts` boot calls (renderFirstRun :24, renderShell :30);
first-run closure vars and race guard (`if (userChose) return`, :91); shell.ts's
forget-trio in the Settings re-point callback; `editor.ts` refresh() at :2323, hook
layer at :2812+ (setEditorNav :2827), `markStickerFileChanged` :1539 /
`markThumbnailChanged` :1501, 88 `el(` sites; `dialogOpen()` at dialog.ts:91;
save-dialog.ts's `packPicker` import :14 / use :102; pack-view `render()` at :597 with
the takeChangedStickers drain at :644–648, 50 `el(` sites.

Two cross-phase conflicts found and resolved (recorded in Binding contracts #2 and the
FontPicker ruling): Phase 3's JSX dialog bodies vs Phase 2's untouched `dialog.ts`
(bridge pattern, unmount-after-settle); Phase 4's conditional combobox swap vs Phase 2's
firm island decision (embed is the default; swap is optional post-adoption).

One counting note: Phase 3 measures its view surface at 2,517 LOC vs the analysis's
2,333 — counting method (which files), not a scope change.

Clean review (2026-11-27): three fresh reviewers (accuracy, consistency,
adversarial) audited the full set with no prior context; they found one blocker (the
S08 strangler seam — now recorded in binding contract #4's seam design and Phase 4's
architecture decisions) and several majors (S02 anchor drift, missing landing steps in
S02/S04/S05/S06, the S05 bridge-unmount gap, the S06 asymmetry decision) plus
count/anchor corrections; four fixer agents applied them all. The final clean
re-review verified every fix against the tree, found five minors and two nits
(StrictMode fence in S11, Phase-3 merge-lever mentions in S04/S05, two stale
phase-4 lines, pre-existing S04/S05 anchor imprecisions, two clarity nits) — all
applied by the main session. Final verdict: CLEAR; every anchor and count in this
set was measured against the tree at HEAD at review time.
