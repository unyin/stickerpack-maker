# React adoption — implementation plan

Status: planning artifact (2026-11-27), pre-verdict at drafting time — since then ticket
08's verdict landed (2026-11-27): **React adoption goes to v2, first**, built on this
plan ("starts once that plan is confirmed and this map is done"), followed by the shadcn
pass that folds in the tone styles. What remains of Phase 0: the owner's confirmation of
this plan, the sequencing is decided (React first; the v2 UX items build on shadcn
components, never on `el()`; Rust/model-only parts may run alongside the port), and
ADR-0010 "React + shadcn/ui view layer" is written in ticket 10. See
[ticket 08](../issues/08-look-and-feel.md), the
[effort analysis](../research/react-adoption-analysis.md), and the map's Decisions.
This plan feeds ticket 09/10; the Trekker epics/tasks of ticket 10 would be created
from it.

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
  excluded). Every session follows the **Session protocol** below: review-cycle to
  convergence before any owner testing (AGENTS.md), a PR merged with a regular merge
  commit (`gh pr merge <N> --merge`) only after the surfaces it converts pass their
  Windows check.
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

**Total: 11–12 sessions, two named compression levers** (3.1+3.2 merge if S04 lands
clean, decided at S05's start; 4.6 absorbs into 4.5 if S07–S10 land clean, decided at
S11's start; "land clean" as defined under Session protocol) → realistic floor ~10. This sits above
the analysis's 8–10 headline for a stated reason: the sessionization isolates the Editor
state bridge as its own zero-behavior-change session (S07) rather than mixing it with
React work, and budgets consolidation/review sessions per slice instead of assuming them.
Per-session plans: [sessions/](sessions/).

## Session protocol (every session)

Each session file's landing step points here; this is the one copy.

1. **Start**: from the main checkout, set the session's Trekker task `in_progress`
   (trekker only ever from the main checkout, never inside a worktree;
   docs/agents/issue-tracker.md). Create a feature branch (or worktree) off `main`
   named `react/sNN-<slug>`.
2. **Build**: sub-agents do the coding (AGENTS.md). Model pins by harness: under
   OpenCode, AGENTS.md's pins; under Claude Code, the build on Sonnet at default effort.
   Set model and effort explicitly on every spawn.
3. **Verify**: `bun run build` (tsc + vite), `bun test`, and the session's CSS
   byte-identity check (`git diff --stat <session base> -- 'src/**/*.css'` empty).
   **`<session base>`** = `git merge-base main HEAD` on the session branch. Every
   diff-based check in these files is limited to the code pathspec
   `-- src index.html tests src-tauri package.json bun.lock vite.config.ts tsconfig.json`,
   so tracker commits (`.trekker/`) and Wayfinder files (`.scratch/`) pushed to `main`
   never show up in it.
4. **Review**: run the `review-cycle` skill to convergence over the session's diff
   (reviewers: OpenCode per AGENTS.md; Claude Code on Opus at medium effort, fixer on
   Sonnet at medium effort). Review always comes before any owner test.
5. **PR**: push the branch, open the PR (`gh pr create`, body per the `pr` skill).
6. **Owner Windows check** on the PR's build, against the session file's checklist. A
   fix found there goes back through a review-cycle round before re-test.
7. **Merge**: only after the checklist passes, `gh pr merge <N> --merge` (never squash
   or rebase). Then, from the main checkout, a summary comment on the Trekker task and
   `completed`.

**Anchor base.** Every `file:line` anchor in these files was measured against the tree
at commit `11bacb6` (pre-S01). Earlier sessions move code, so a later session reads an
anchor as `git show 11bacb6:<file>` and finds today's location by its symbol, never by
the bare line number.

**Clean landing** (used by the compression levers): a session landed clean when its
review-cycle converged in at most two rounds with no blocker or major finding, its
Windows checklist passed first time, and it used none of its own overrun fallbacks
(nothing slipped to the next session).

## Binding cross-phase contracts

These decisions bind all sessions; relitigating one mid-phase is plan drift.

1. **Incremental mounting.** Phase 1 builds a `mountView()` root-tracking helper in
   `src/react/`; Phase 2 extends it into a heterogeneous registry (React roots + el()
   DOM mounts, exactly one view mounted at a time, unmount-before-clear-before-mount
   order, shell root tracked separately and unmounted on re-boot: two named functions,
   `unmountViews()` for the content views and `unmountShell()` for the shell root, and
   never `root.unmount()` from inside a React render or commit. Views mount and unmount
   only from the navigation handler, outside React, never from an effect:
   `unmountViews(); flushSync(() => setScreen(next)); mount<View>(contentLeaf)`; the
   first view mounts the same way right after `mountShell()`'s `flushSync` render, so no
   frame paints an empty content area and every view's own roots — including
   in-place bridges like the PackList — are created outside any React commit). Phase 3/4 mount
   through it. Navigation across the React/el() boundary is a module-level navigator
   seam mirroring `setPackManagerListener`. Per-boot shell remount is the ADOPTED
   design (it reproduces today's scorched-earth boot semantics: fresh DOM per
   Library); the keyed persistent `<Shell key={libraryGeneration}/>` alternative is
   DROPPED — a post-adoption optimization option only, never scheduled.
2. **Dialog and Combobox stay imperative islands** (Phase 2's firm decision, recorded for
   ADR-0010 candidacy). `dialog.ts` (93) and `combobox.ts` (266) are untouched through the
   whole adoption. React content inside a dialog body happens only via the bridge
   pattern (Phase 3): call `openDialog(title, [], buttons, …)` with an empty body, then
   `createRoot` **on the dialog's own `.app-dialog-body` element** (found through
   `handle.dialog`) and render inside `flushSync`, so the body's children exist before
   the orchestrator's next line (focus, width fit, `scrollTop`) and the DOM stays
   node-for-node today's (no wrapper element). The bridge root is unmounted when the
   dialog's `result` settles. Never move React-rendered nodes out of their root's
   container: React 19 delegates events at the container, so a moved node's handlers
   never fire. The same rule holds for every non-dialog bridge (a React subtree inside a
   still-el() view): the root's container is the real host element in place. The
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
   owns. Mutable-snapshot pattern: version bump + notify, **one notify per command**
   (a command that sets several fields notifies once, at its end). A *command* is a
   public controller method entered from a view event, a keyboard shortcut or an async
   continuation; commands called from inside another command do not notify on their
   own (a depth counter batches them). **The depth bracket covers synchronous code
   only**: it is never held across an `await`, so every async continuation (a
   download progress tick, editAsync's commit, a `.then`, a tab click during a long
   action) is its own outermost command and notifies; only an action's synchronous
   prefix nests. The pre-notify step runs inside the bracket, before the decrement,
   on every path including the session forwarder's (the forwarder raises the depth
   around it), so its nested `setTool` never adds a notify. Every command that writes
   a rendered field notifies, even when today's code skipped the `refresh()` because
   nothing else changed. The one named exception is `run()`: its own notifies are
   exactly two, at its start (busy on) and in its `finally` (busy off), the `finally`
   being its own bracket; notifies from async continuations during the run are
   theirs, not `run()`'s. Normalisations today's `refresh()` performs by calling a
   command (the effect-basis discard, `setTool("move")`) run in the controller's
   pre-notify step, inside the same command, never from a render or an effect.
   **Lifecycle exception:** `attachStage()` / `detachStage()` are not commands but
   the stage's registration with the controller, and the only *notifying* controller
   calls made synchronously from an effect body (CanvasPanel's stage effect and its
   cleanup). Besides them, an effect body may make only silent registrations (the
   text-overlay register/unregister) and silent consumes of a pending value (e.g.
   ToolsPanel clearing `toleranceValue` once applied); none of these notifies. One
   more call is allowed there, through the stage: `stage.onViewChange` calls its
   listener at once on registration (stage.ts:444–447), so `controller.setZoom` runs
   synchronously inside the stage effect; it notifies the zoom view channel
   (`subscribeView`) only, never bumps `version`, and is not a command.
   `attachStage()` bumps the version and notifies, so anything rendered from the
   stage (crop box, size blockers) catches up on every session start and remount.
   Handlers an effect registers (keydown, drag-drop, `onViewChange`) are event
   paths and may call commands. Commands live outside React
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
the takeChangedStickers drain at :644–646 (inside `reread()` :643–648), 50 `el(` sites.

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
