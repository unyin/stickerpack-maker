# Group the v2 survivors into tasks and epics

Type: grilling
Status: resolved
Blocked by: 01, 02, 03, 04, 07, 08

## Question

Given every v2 verdict, how do the survivors bundle into implementation tasks (things that make sense to do at the same time) and those tasks into v2 epics? Check the whole hangs together; push odd ones out to v3; pull in any obviously related v3-lot item by name. Settle the ordering/dependencies between tasks.

## Context note (2026-11-27)

[Triage: Look and feel](08-look-and-feel.md) fixes the coarse order: React adoption -> shadcn pass -> the v2 UX items (built on shadcn components) -> icon pass last. This ticket picks which Rust/model-only parts may run alongside the React port, and weighs the ~35-session total.

## Answer

Owner decisions (2026-11-28). The survivors of [Triage: Pack Manager interactions](01-pack-manager-interactions.md), [Triage: Editor tools and layers](02-editor-tools-and-layers.md), [Triage: Emoji fonts](03-emoji-fonts.md), [Triage: real clipboard Cut/Copy](07-real-clipboard.md) and [Triage: Look and feel](08-look-and-feel.md) group into **seven v2 epics, ~35 sessions** (~33 if E1's two compression levers fire). Costs are rough session counts.

**Epics and tasks**

- **E1 React adoption** (11-12): one task per session file S01-S12 of the reviewed [React adoption plan](../reactJS-implementation/plan.md), taken as-is, with its two compression levers (3.1+3.2 merge if S04 lands clean; 4.6 absorbs into 4.5 if S07-S10 land clean).
- **E2 shadcn/ui pass** (5-6): T1 setup (React + Tailwind v4 without Preflight, Base UI) + the app's colours in shadcn's variables, measured against 3:1 + rendered style comparison sheet (owner picks the style); T2 Dialog / Command / Tooltip replacing the imperative Dialog, Combobox and tooltips (SPEC §2 contracts as exit criteria); T3 shell, Settings and Pack Manager controls + shared tone variants; T4 Editor controls.
- **E3 Pack Manager interactions** (~4-4.5): T1 reusable right-click menu component + the Pack Manager menu + double-click to Edit (~1.5); T2 hold-to-reorder + group drag + hold-duration setting (~1-1.5); T3 emoji picker (~1-2).
- **E4 Editor tools and layers** (~7): T1 mirror (both axes), crop layer to content, text-to-image (~1.5); T2 ratio-keeping edge handles + whole-pixel moves/resizes/Rectangle selections (~1.25); T3a custom canvas resize (centre) (~0.5); T3b Crop drops all-transparent crossing layers (~0.5); T4 layer locking (~1); T5 Editor right-click menu (~0.5); T6 full Editor defaults in Settings + reset (~1.5+).
- **E5 Real clipboard** (~2): T1 Rust `arboard` commands (PNG + CF_DIBV5); T2 Ctrl+C, Ctrl+X, in-place paste of the app's own copy, Paste button via Rust, "Lift to new layer" (Ctrl+Shift+J), Pack Manager "Copy image", Windows paste-target hand test (~1.5).
- **E6 Emoji fonts** (~2): T1 bitmap (CBDT/sbix) emoji painting on the canvas (~1); T2a the 128 MB font guard; T2b the emoji font library + its Settings UI.
- **E7 Editor icon pass** (2-3): rendered sheet first (AGENTS.md Icons rule), then the SPEC-settled scope plus E4's new controls, `lucide-react`.

**Runs alongside the React port** (no new UI; checkable with today's UI or by tests): E6 T1, E4 T3b, E6 T2a, E5 T1.

**Releases**: v1.1 once those four parallel tasks land; v2.0 after E7.

**Ordering**: E1 -> E2 -> the view tasks of E3-E6 -> E7 (after all of E3-E6). Inside the UX phase only these edges: E3 T1 before E4 T5 and before E5 T2; E5 T1 before E5 T2 (and so before "Copy image"); E4 T1 before E4 T4; E6 T2b after E2. Nothing else is ordered.

**Scope check**: the whole hangs together; no v2 survivor moves to v3, and no v3-lot item is pulled in. New v3-lot entry: **macOS port** of the app (until now only SPEC §1 "Windows v1; macOS later" and ADR-0001; Linux stays the ADR's "maybe"); [Write the v2 plan down](10-write-v2-plan-down.md) adds it to SPEC's v3 lot.

**Open design calls**: no extra decision tickets. Each stays with its task: the menu contents (E3 T1, E4 T5), the hold-duration range (E3 T2), building or adopting the emoji picker (E3 T3), the shadcn style (E2 T1's sheet), the icon choices (E7's sheet).
