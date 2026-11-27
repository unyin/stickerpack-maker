# React-adoption effort analysis (ticket 05 addendum source)

2026-11-27, Vibe session (SPM-37). Question, per owner: how much work would it take to add
ReactJS to the frontend, as the prerequisite step that makes converting the UI to shadcn/ui
trivial. This file holds the full findings; the headline numbers are appended to
[05-shadcn-fit.md](../issues/05-shadcn-fit.md) and ticket 08 points at them.

Methodology: four parallel analysis subagents (UI inventory, build/tooling, state/Konva flow,
prior-research cross-check), each independently measuring the working tree at HEAD 64a809f.
Honesty note: the owner asked for high-effort GLM-5.3 subagents; Vibe exposes no subagent
model pinning and the OpenCode harness (where the AGENTS.md pin applies) is out of budget
this month, so these ran on the Vibe session's stack. Mitigation: the cross-check subagent
re-measured every headline number of ticket 05's researcher and they all reproduce (375
`el()` sites, 110 listeners, 42 re-render sites, 147 tooltip sites, CSS 2,759 lines across
5 files), and the new numbers converge with ticket 05's independent 13-16 total rather
than contradicting it.

## Headline

**~8-10 focused agent sessions** (build + review-cycle included; owner test time and the
one-Windows-check-per-converted-view excluded) to adopt React while keeping the current
look. All 2,759 lines of CSS and ~4,500 lines of pure model code survive untouched.
shadcn/Tailwind on top afterwards: ~5-6 more sessions - consistent with ticket 05's 13-16
for "React + real shadcn". A codemod over the uniform `el()` helper could pull 2-3 sessions
out of the React block.

Decomposition cross-check (ticket 05's own line items): React adoption per se is ~55-60%
of the 13-16 (the constant across the Svelte/Vue ports is the framework, not shadcn);
the shadcn/Tailwind block (~5-6) is option (c)'s 3-5 plus ~1-2 of Tailwind work.

## Why this codebase is unusually React-friendly

- **Rust is already the state container**: every UI fact arrives via one `getAppState()`
  pull; the app re-renders whole trees already (`boot()`, 42 `clear`/`replaceChildren`
  sites). React slots in as a pure view layer - no router, no state library, no
  data-fetching layer.
- **~4,500 of 14,752 TS lines are pure and survive verbatim**: all 27 `model/` files
  (13 pack-manager, 14 editor - zero real DOM references), `save.ts`, `shell-model.ts`,
  the three api wrappers, `geometry.ts`. The ADR-0005 "Konva never holds state the model
  lacks" discipline pays off here.
- **`EditorSession` (session.ts, 269 lines) is already an external store** with
  `subscribe()`; it wires into React via `useSyncExternalStore` as-is.
- **Keep Konva vanilla**: `stage.ts` (1,286 lines) stays an imperative leaf behind
  `useRef` + one `useEffect` keyed on session identity. Do NOT adopt react-konva: the
  gesture/pixel half (lasso drafts, wand drags, brush strokes painted via `putImageData`
  into cached canvases, the loupe, `queueMicrotask` transform commits, `Konva.Transformer`)
  is not declarative tree diffing; porting it is pure regression risk with zero payoff.
  All four subagents agree.
- **CSS is 100% class-based with stable names**: React components emit identical
  classes; all five stylesheets stay byte-identical for the React-only step.

## What a React port touches (~9,100 LOC across 30 files)

- **Mechanical (~5,300 LOC, ~58%)**: shell, first-run, settings, panels, dialog bodies,
  pack-list/pack-view renders, upload-list markup, icons, actions-list, theme - template
  to JSX, `on*` to props, `replaceChildren` to return. The single `el(tag, attrs,
  ...children)` signature (375 sites, 0 `innerHTML`) and the 42 re-render sites double as
  a free map of where state boundaries go; a codemod over the mechanical ~60% is
  feasible and was never priced by the prior research.
- **Re-design (~3,800 LOC, ~42%)**: `views/editor.ts` (2,951 lines, ~25 mutable closure
  vars, 27 `refresh()` call sites) decomposed into ~5-8 components over the session
  store; combobox.ts (266) and dialog.ts (93) contract re-implementations; the two drag
  systems (pack-list-drag 163 + reorder-drag 91, keep imperative behind refs);
  `views/pack-manager.ts` cache-to-state; text-edit overlay.

## Phase breakdown (sessions)

| Phase | Scope | Sessions |
|---|---|---|
| 0 | Decisions: framework ADR, ticket 08 verdict, sequencing call | - |
| 1 | Scaffolding + pilot: react+react-dom@19, @types, @vitejs/plugin-react, `jsx: react-jsx`, root-tracking helper, first-run (100 LOC) as pilot | 0.5-1 |
| 2 | Shell + shared widgets + Settings (306 LOC); Dialog/Combobox contracts are re-implementation surfaces | 1-2 |
| 3 | Pack Manager: 2,333 view LOC, 165 `el()` sites, 2 imperative drag systems, focus-preservation rules | 2-3 |
| 4 | Editor: closure knot -> ~5-8 components over `useSyncExternalStore`; Konva ref leaf | 4-6 |

## Tooling facts (nearly free)

- Dependencies: `react@^19`, `react-dom@^19`; devDeps `@types/react@^19`,
  `@types/react-dom@^19`, `@vitejs/plugin-react@^5`. Config: `"jsx": "react-jsx"` in
  tsconfig, `plugins: [react()]` in vite.config. tauri.conf.json, index.html, scripts,
  tests untouched.
- Bundle: +55-60 kB gzip for React (ticket 05's +125 kB total splits roughly half React,
  half Base UI + shadcn source). Immaterial: Tauri embeds assets locally and dist/ is
  96.4% emoji fonts (6.8 MB).
- Tests: 25 files / 5,840 lines, DOM-free, target only `model/` code - untouched. Bun
  reads the tsconfig jsx setting; no new setup.
- Licences: MIT, auto-collected by `scripts/licenses.mjs`; no script changes.
- Dev workflow: net improvement - today there are zero `import.meta.hot` handlers (full
  page reload on every edit); plugin-react adds Fast Refresh for migrated .tsx.
- Tailwind (later, shadcn step): skip Preflight entirely (`theme.css` + `utilities`
  imports) - `styles.css` already resets box-sizing/body margin and unlayered app CSS
  beats layered Tailwind in the cascade; needs a `@custom-variant dark` for the
  `data-theme` attribute (app is manual-override, Tailwind defaults to
  prefers-color-scheme).

## The three real costs (all concentrated in Phase 4 / the Editor)

1. **`views/editor.ts` is a closure knot, not a component tree**: async busy-gating
   (`run()`), stale-document refusal in `editAsync`, warp/wand gesture state mutated
   mid-drag. React effect cleanup introduces new interleavings (an effect re-running
   mid-gesture cancels a stroke that today is guaranteed to finish because nothing ever
   unmounts). Highest blast radius, pixel-correct today, tested only by hand.
2. **The `boot()` re-boot idiom**: correctness leans on scorched-earth teardown plus
   four explicit `forget*()`/`reset*()` calls (shell.ts:88-95) and `libraryGeneration`.
   A persistent React root must centralize Library-re-point invalidation as a keyed
   generation (`<Shell key={libraryGeneration}/>`), or it shows stale packs and saves
   into the wrong Library.
3. **Behavior drift in hand-tuned interactions**: focus preservation on half-typed
   inputs (pack-view `render()` and editor `refresh()` both check
   `document.activeElement`), both drag systems, reveal-scroll timing, Dialog/Combobox
   keyboard contracts (dialogOpen() polling, blur-revert, aria-activedescendant,
   releaseFocusOnPick). Individually small, collectively what a "working" port fails on
   in owner tests.

## The one decision this forces before any of it counts

**Sequencing against tickets 01/02.** The map already greenlit Pack Manager interactions
(reusable right-click menu, hold-to-reorder with group drag, emoji picker) and Editor
tool work. Build them on `el()` first and React conversion re-ports them (built twice);
React first and it sits on the critical path of every v2 UX item. The prior research
never priced this; it is the biggest swing factor on the real cost.

## Open questions this analysis inherits from ticket 05 (for ticket 08's verdict)

- The framework ADR itself (nothing proceeds without it).
- Whether a shadcn rework subsumes the unified tone styles (same selectors styled twice
  if separate).
- Base UI vs Radix vs React Aria as the primitive base (chosen by default in 05, never
  compared).
- Which shadcn style pack (sets control metrics the icon pass renders against).
- Preflight strategy and the fate of the existing 2,759-line CSS.
- Bundle acceptance (~2x shipped JS, 127 -> ~250 kB gzip).
- Sequencing vs tickets 01/02 (above).
