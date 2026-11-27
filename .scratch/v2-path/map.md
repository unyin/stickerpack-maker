# Path to v2

## Destination

A v2 plan: every entry of SPEC §9's v2 parking lot (UX), and every §8 future seam, has a verdict (v2 / v3 / rejected); the v2 survivors are grouped into implementation tasks under new v2 epics in Trekker; SPEC §9 is updated so the v2 lot is empty. Tracker: SPM-37.

## Notes

- Domain: Stickerpack maker, a Tauri v2 desktop app (Rust core + plain-TypeScript/Konva webview, ~17.5k lines TS/CSS) for making Telegram sticker packs. Spec: `docs/SPEC.md`; vocabulary: `GLOSSARY.md`; ADRs: `docs/adr/`.
- Source material: SPEC §9 "v2 parking lot (UX)" and §8 "Out of scope for v1 (future seams)". Read each item's full SPEC entry and the tracker comments it cites before triaging it.
- Verdicts: **v2** (taken into the plan; leaves the lot), **v3** (moves to SPEC's v3 parking lot), **rejected** (moves to a new "Rejected ideas" list in SPEC §9 with the owner's reason and date; "Bulk emoji-set" goes there first). Triage is not complete while any v2-lot entry remains (owner rule, CMT-667).
- No fixed theme for v2: judge each item on value against cost; the grouping ticket then checks the survivors hang together and pushes odd ones out to v3 (owner, 2026-11-27).
- The v3 lot is out of scope as a pass, but may be consulted for items obviously related to a v2 grouping (owner, 2026-11-27).
- Source of truth: this map and its tickets record how each item was decided; SPEC §9 is updated afterwards to reflect it (owner, CMT-670).
- Execution override: the last ticket, "Write the v2 plan down", carries execution into the map: updating SPEC §9 and creating the Trekker epics/tasks. The owner judges it minor enough to count as planning (2026-11-27).
- Standing rules: AGENTS.md (Icons rule; UI audience = the owner's mouse-and-screen use; merge --merge), trekker and these files from the main checkout only. Claude Code subagents: research/analysis on Opus.
- Grilling tickets: call the Skill tool for "grilling" and "domain-modeling"; the agent gives a rough cost and an opinion per item, the owner gives the verdict.

## Decisions so far

- [Triage: Pack Manager interactions](issues/01-pack-manager-interactions.md): v2: double-click to Edit, reusable right-click menu, hold-to-reorder (~500ms, adjustable in Settings) with group drag, emoji picker; v3: trash/recovery (via a staging area).
- [Triage: Editor tools and layers](issues/02-editor-tools-and-layers.md): v2: ratio-keeping edge handles, custom canvas resize (centre), Crop drops all-transparent crossing layers, text-to-image, whole-pixel moves/resizes/Rectangle selections, layer locking, mirror (both axes), crop layer to content, full Editor defaults in Settings + reset, Editor right-click menu; v3: grid snapping.
- [Triage: Emoji fonts](issues/03-emoji-fonts.md): v2: emoji font library (with a 128 MB guard matching WebView2's limit), bitmap (CBDT/sbix) emoji painting on the canvas; v3: woff2 on the canvas, auto-slim at import; rejected: .ttc support, SVG-in-OpenType. Also triages SPEC §6's parked woff2/bitmap item.
- [Triage: §8 future seams](issues/04-future-seams.md): nothing to v2; v3: Bot API sync (may slip to v4), a manual-sync to-do list for Live packs (new), custom emoji packs, video .WEBM, Editor project files; v4: sticker version history; rejected: .TGS, DB reconstruction, export/prep folders.
- [Triage: real clipboard Cut/Copy](issues/07-real-clipboard.md): v2: Ctrl+C, Ctrl+X as a standard clipboard cut, in-place paste of the app's own copy at full fidelity, Paste button via Rust, "Copy image" in the Pack Manager; the Cut button becomes "Lift to new layer" (Ctrl+Shift+J, layer named "Lifted").
- [Research: what adopting shadcn/ui would take](issues/05-shadcn-fit.md): real shadcn means React + Tailwind (~13-16 sessions, ~2x JS, a framework ADR); Basecoat ~6-8; shadcn's look in plain CSS ~3-5, folds into tone styles; shadcn default contrast fails the 3:1 rule, keep the app's colours.
- [Research: image clipboard in Tauri 2 on Windows](issues/06-image-clipboard.md): feasible with transparency; do it in Rust with arboard (PNG + CF_DIBV5), keep the webview paste event for Ctrl+V; needs a Windows paste-target hand test.
- [React-adoption addendum](research/react-adoption-analysis.md) (sharpens ticket 05, feeds ticket 08): React alone ~8-10 sessions, shadcn/Tailwind on top ~5-6; models and CSS survive untouched; Konva stays vanilla; the sequencing call vs tickets 01/02 is part of ticket 08's verdict.

## Not yet specified

- Triage may surface v2 items that need a design decision before they can be written as implementation tasks (e.g. how a right-click menu or trash area should look). Whether those become extra decision tickets here or are left to the implementation tasks gets settled once the survivors are known.

## Out of scope

- A promotion pass over the v3 lot, the v4 lot, and SPEC's "Ignored edge cases": outside the destination (owner, 2026-11-27); v3 items may still be pulled into a grouping by name.
- Building anything from the v2 plan: the map ends at the plan.
