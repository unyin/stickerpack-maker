# Research: what adopting shadcn/ui would take

Type: research
Status: resolved

## Question

What would adopting shadcn/ui (https://ui.shadcn.com/) take in this webview: plain TypeScript + Konva, no UI framework, Vite, ~17.5k lines TS/CSS, its own token-based CSS (src/styles.css, theme.ts) and inline icon set (src/icons.ts)? Compare the options: React + Tailwind with real shadcn components; a community port (shadcn-svelte, shadcn-vue, any vanilla/web-component port); adopting shadcn's look (tokens, Radix-style patterns) in plain CSS without a framework. For each: build changes, how it coexists with Konva-owned canvas DOM, migration path (incremental vs big bang), bundle and licence impact, and a rough size in sessions. Note overlaps with the unified tone styles and Editor icon pass entries.

## Answer

shadcn/ui is copied-in React + Tailwind v4 source (Base UI by default since 2026-07, Radix optional), themed by CSS variables, with no success/warning colour. Today's webview: hand-built DOM via one `el()` helper (375 calls), 4 views, ~2.8k lines CSS, Konva confined to one container in `stage.ts`, 127 kB gzip JS (Konva ~60).

- **(a) React + real shadcn:** ~13-16 focused sessions, ~+125 kB gzip JS (about double); two Vite plugins, Tailwind v4 with a reset that clashes (can be disabled), a `data-theme` dark-mode tweak. Konva sits untouched in its container; the cost is moving Editor state into React and re-creating the SPEC §2 tooltip and dialog contracts. Incremental per view.
- **(b) Ports:** shadcn-svelte / shadcn-vue (MIT, active) cost about as much as (a), lighter runtimes (21/26 kB). Basecoat (MIT, plain HTML/CSS/JS) keeps `el()` and Konva: ~6-8 sessions, but still brings Tailwind + reset and a `.dark` class. The Lit web-component port is dormant.
- **(c) shadcn's look in plain CSS:** ~3-5 sessions, no build, bundle or Konva risk: adopt its token names, radius scale, control sizes and button variants.

Every option: shadcn's default light border (1.26:1) and focus ring (2.59:1) fail the repo's 3:1 contrast rule, so keep the app's colour values and take shadcn's structure. Overlaps: "Unified tone styles" is the same job as shadcn's button variants (one pass under (c)/Basecoat); the icon pass should come after control sizes settle; Lucide (ISC, 24x24 outline currentColor) is a candidate icon source, Icons rule still applies. Licences: MIT plus ISC (Lucide) and Apache-2.0 (cva), notices only. Researcher's read of the cheapest path: (c), folded into tone styles, Basecoat as fallback; (a)/(b) are a framework choice needing its own ADR.

Findings: branch `research/shadcn-fit` (commit 2655357), file `research/shadcn-fit.md`. Never merged.

### Addendum (2026-11-27): React-adoption effort, measured

Owner question: how much work to add ReactJS as the standalone prerequisite step. Four
analysis subagents measured the tree (Vibe session; the GLM-5.3 high pin is OpenCode-only
and that budget is exhausted this month - full methodology in the findings file). The
answer's 13-16 splits: **React adoption per se ~8-10 sessions** (Editor 4-6,
Pack Manager 2-3, shell/widgets/Settings 1-2, scaffolding 0.5-1), **shadcn/Tailwind on
top ~5-6**; a codemod over the uniform 375-site `el()` helper could pull 2-3 out.
Codebase is unusually React-friendly: Rust is already the state container, ~4,500 of
14.7k TS lines are pure model code that survives verbatim, all 2,759 CSS lines stay
byte-identical for the React-only step, `EditorSession` is already an external store, and
Konva stays vanilla behind a ref (no react-konva). Costs concentrate in
`views/editor.ts` (2,951-line closure knot), the `boot()` re-boot idiom, and
hand-tuned DOM behavior. One sequencing decision this forces: tickets 01/02's greenlit
UX work builds on `el()` and gets re-ported after a React conversion - React first puts
it on every UX item's critical path.

Full findings, phase breakdown and open questions:
[react-adoption-analysis.md](../research/react-adoption-analysis.md).
