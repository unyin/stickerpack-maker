# Write the v2 plan down

Type: task
Status: resolved
Blocked by: 09

## Question

Update SPEC §9 to match the map: empty the v2 parking lot; move v3 verdicts into the v3 lot; create the 'Rejected ideas' list (Bulk emoji-set first) with each owner reason and date; commit the uncommitted shadcn/ui entry along with it. Then create the v2 epics and tasks in Trekker per docs/agents/issue-tracker.md Conventions, each task citing by path the decision tickets it rests on. Close SPM-37. Also reword SPEC §6's "woff2 decoding and bitmap blitting are parked for v2" to match [Triage: Emoji fonts](03-emoji-fonts.md) (bitmap painting v2, woff2 v3). Likewise update SPEC §8 per [Triage: §8 future seams](04-future-seams.md): each seam moves to the v3 lot, the v4 lot, or Rejected ideas (and the new manual-sync to-do list joins the v3 lot). Also write ADR-0010 "React + shadcn/ui view layer" in `docs/adr/` per [Triage: Look and feel](08-look-and-feel.md).

## Context note (2026-11-28)

[Group the v2 survivors into tasks and epics](09-group-v2-survivors.md) holds the epic/task list, the parallel tasks, the v1.1/v2.0 releases and the dependency edges to create in Trekker. It also adds one new v3-lot entry to SPEC §9: **macOS port** of the app.

## Answer

Done 2026-11-28 (PR #38, merged as 4787541; Trekker created the same day).

- **SPEC §9**: a new **v2 plan** subsection lists every v2 survivor under its Trekker epic and task. The **v2 parking lot (UX)** is empty. The v3 lot gains:
  - trash/recovery (staging area)
  - grid snapping
  - the shortcut rebinding UI
  - woff2 on the canvas
  - auto-slim at import
  - Bot API sync
  - the manual-sync to-do list
  - custom emoji packs
  - video .WEBM
  - Editor project files
  - the macOS port

  The v4 lot gains sticker version history. A new **Rejected ideas** list holds Bulk emoji-set, .ttc, SVG-in-OpenType, .TGS, DB reconstruction and export/prep folders, each with its reason and date. The uncommitted shadcn/ui lot entry was committed first (296fbaf), then folded into the plan's shadcn/ui pass entry.
- **SPEC §8**: each seam points to its v3 lot, v4 lot or Rejected ideas entry. **SPEC §5/§6**: bitmap emoji painting is v2, woff2 is v3, and SVG-in-OpenType is rejected.
- **New owner verdict (2026-11-28)**: the Editor single-key shortcut **rebinding UI goes to v3**. SPEC §6 had it "parked for v2" (SPM-15, CMT-400), but it never entered the §9 lot, so the triage had missed it.
- **ADR-0010** "React + shadcn/ui view layer" (`docs/adr/0010-react-shadcn-view-layer.md`): records React 19, vanilla Konva behind a ref, shadcn on Base UI with Tailwind v4 without Preflight, and the app's own colours. It also covers why option (c) and Basecoat lost, and notes the temporary Dialog/Combobox ruling.
- **Trekker**: seven epics, EPIC-4 React adoption through EPIC-10 Editor icon pass, holding 34 tasks:
  - SPM-41 to SPM-52: React sessions S01 to S12
  - SPM-53 to SPM-56: the shadcn/ui pass, T1 to T4
  - SPM-57 to SPM-59: Pack Manager interactions
  - SPM-60 to SPM-66: Editor tools and layers
  - SPM-67 and SPM-68: Real clipboard
  - SPM-69 to SPM-71: Emoji fonts
  - SPM-72: Editor icon pass
  - SPM-73: Release v1.1.0 (no epic)
  - SPM-74: Release v2.0.0 (no epic)

  Each task cites its decision tickets by path. The dependency edges follow [Group the v2 survivors into tasks and epics](09-group-v2-survivors.md):
  - S01 through S12 run in a chain, then shadcn T1, which comes before T2 to T4.
  - Every UX-phase task waits on all of T2 to T4, and the icon pass waits on every task of E3 to E6.
  - The UX-phase edges are kept as ticket 09 sets them.
  - v1.1.0 waits on the four parallel tasks, and v2.0.0 on the icon pass.

  Open owner calls are tagged `needs-info`: SPM-53, 57, 58, 59, 65 and 72. Ready to start now: React S01 (SPM-41) and the four v1.1 tasks (SPM-63, 67, 69, 70).
- **Open question carried into SPM-73**: whether React sessions merged to main by then ship in v1.1. It is confirmed with the owner at release time.
- **Review**: an Opus high-effort accuracy review of the SPEC, ADR and Trekker against tickets 01 to 09 found 0 blockers, 1 major and several minors/nits, all applied. It marked inferred design suggestions (lock undo, strike choice) as not owner decisions.
