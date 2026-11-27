# Triage: Look and feel

Type: grilling
Status: resolved
Blocked by: 05

## Question

Verdict (v2 / v3 / rejected) for the three overlapping look-and-feel items, decided together: unified tone styles; UI rework on shadcn/ui; the Editor icon pass (settled scope and Icons-rule process in its SPEC entry, CMT-404/407/414/415). If more than one survives, how they relate (e.g. does a shadcn rework subsume the tone styles?).

## Context note (2026-11-27, added for whoever picks this up)
The React prerequisite has since been measured: read ticket 05's
[Addendum](05-shadcn-fit.md) and
[react-adoption-analysis.md](../research/react-adoption-analysis.md) before giving costs
here. Headline: React adoption alone ~8-10 sessions (shadcn/Tailwind on top ~5-6, matching
05's 13-16 total); ~4,500 lines of model code and all 2,759 CSS lines survive it
untouched; Konva stays vanilla. The analysis also flags one decision this ticket should
make explicitly: **sequencing** - tickets 01/02's greenlit UX work builds on `el()` today
and would be re-ported after a conversion, so a React/shadcn verdict interacts with when
those land.

## Answer

Owner verdicts (2026-11-27): **all three items go to v2, plus React adoption as their prerequisite**. Built on [Research: what adopting shadcn/ui would take](05-shadcn-fit.md) and its [React-adoption addendum](../research/react-adoption-analysis.md). Look-and-feel cost about 18-21 sessions (rough), on top of tickets 01/02/03/07's ~15-18: v2 is now about 35 sessions, for [Group the v2 survivors into tasks and epics](09-group-v2-survivors.md) to weigh.

- **React adoption (v2, first)**: from the plan in [reactJS-implementation/](../reactJS-implementation/plan.md) (11-12 sessions; current look kept, CSS byte-identical, Konva vanilla behind a ref, no react-konva). Starts once that plan is confirmed and this map is done. Owner's rationale: do it first, so v2's new UI is built once, in React.
- **shadcn pass (v2, second)**: real shadcn/ui on React + Tailwind v4 (~5-6 sessions). **Unified tone styles fold into it**: no separate item; `.tone-success`/`.tone-danger` become the shared tone variants, so the tinted selectors are styled once. Scope and defaults:
  - Replaces the imperative Dialog, Combobox and tooltips with shadcn's Dialog, Command and Tooltip; the SPEC §2 tooltip and dialog contracts (`dialogOpen()` polling, blur-revert, the keyboard guards) are its exit criteria. The React plan's binding contract #2 (Dialog/Combobox stay imperative) therefore holds only for the duration of the port.
  - The app's own colour values go into shadcn's CSS variables (shadcn's default border 1.26:1 and focus ring 2.59:1 fail the 3:1 rule), plus new success and warning variables; every pair measured against 3:1 before landing.
  - Base UI primitives (shadcn's default); Tailwind without Preflight, with a `@custom-variant dark` for `data-theme`; the existing CSS retired component by component as shadcn replaces it; ~2x shipped JS (127 -> ~250 kB gzip) accepted.
  - The shadcn style (control heights, radius) is not chosen now: the pass opens with a rendered comparison sheet and the owner picks.
- **v2 UX items (third)**: tickets 01, 02, 03 and 07's view work is built on the shadcn components (ContextMenu for the right-click menus, Popover/Command for the emoji picker, Slider/Switch for the new Settings), never on `el()`. Rust/model-only parts (e.g. the `arboard` clipboard commands, bitmap emoji painting, the font library backend) may run alongside the React port; ticket 09 picks which.
- **Editor icon pass (v2, last)**: the SPEC-settled scope (Undo/Redo/Save.../Close, the ~21 left-panel tools icon-only, the four tab leaves; sizing-trio diagram icons still undecided until rendered) plus ticket 02's new Editor controls (~2-3 sessions). New icons from the `lucide-react` package (shadcn imports it anyway); the existing 11 icons are ported as-is, unless one clashes on the rendered sheet. The AGENTS.md Icons rule applies in full.
- **ADR-0010 "React + shadcn/ui view layer"**: written in [Write the v2 plan down](10-write-v2-plan-down.md). It records React 19, vanilla Konva behind a ref, shadcn on Base UI + Tailwind without Preflight, the app's own colours, and why plain-CSS shadcn (option c) and Basecoat lost; the temporary Dialog/Combobox ruling is a note in it, not its own ADR.
