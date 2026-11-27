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

## Not yet specified

- Triage may surface v2 items that need a design decision before they can be written as implementation tasks (e.g. how a right-click menu or trash area should look). Whether those become extra decision tickets here or are left to the implementation tasks gets settled once the survivors are known.

## Out of scope

- A promotion pass over the v3 lot, the v4 lot, and SPEC's "Ignored edge cases": outside the destination (owner, 2026-11-27); v3 items may still be pulled into a grouping by name.
- Building anything from the v2 plan: the map ends at the plan.
