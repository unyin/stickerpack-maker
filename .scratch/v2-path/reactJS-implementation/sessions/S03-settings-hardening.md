# S03: Phase-2 contract sweep and hardening (Phase 2)

Covers B1 (contract-preservation sweep and hardening) and B2 (review-cycle to
convergence + the phase-gate Windows check) of
[../phases/phase-2.md](../phases/phase-2.md).

Anchors are measured at commit `11bacb6` (plan.md › Anchor base); shell.ts and
settings.ts no longer exist after S02, so their anchors below are
`git show 11bacb6:<file>` lines, found in the `.tsx` successors by symbol.

Corrections to the phase file:
- B1 check (1)'s `title={tab.tooltip ?? ""}` is superseded by S02's decision
  (S02 step 4): `title={tab.tooltip || undefined}`, attribute omitted while
  empty, with the open-then-close `title=""` difference recorded as an accepted
  deviation. This session verifies that decision, not the phase's wording.
- The phase's single Windows check for Phase 2: S02 now runs its own before
  merging (plan.md › Session protocol); this session's check re-covers the
  whole phase after the hardening and stays the phase gate.

## Goal
Harden S02's output against the phase's named drift classes, fix what this
session's own B2 review of the S02 diff finds, converge the review-cycle, and
hand the owner the Windows check that gates the whole of Phase 2. When the
session ends, every B1 check is verified, both review axes have converged,
the owner's Windows checklist has passed, and the phase's definition of done
holds (shell + Settings in React with byte-identical
markup, all islands and CSS untouched).

## Preconditions
- Phase 0 decisions landed (framework ADR, ticket 08 verdict, sequencing).
- S02 landed (PR merged after its Windows check). Hand-off state:
  `src/react/mount.ts` with `mountView`, `mountDomView`, `unmountViews`,
  `mountShell`, `unmountShell`; `src/react/navigation.ts` (`setNavigator`,
  `navigate`); `src/react/Icon.tsx`; `src/react/use-message.ts` (`text`, `set`,
  `run`); `src/shell.tsx` (`renderShell` → `mountShell(<Shell/>)` then
  `mountScreen(initialScreen(state))`, `mountScreen` a `renderShell`-scope
  closure passed to `Shell` as a prop, `show()` as
  the navigation handler running `unmountViews(); flushSync(() =>
  setScreen(next)); mountScreen(…)`, no view-mounting effect, the
  `onLibraryChanged` closure); `src/views/settings.tsx` (`SettingsView`); main.ts's two added
  `unmountShell()` calls; `src/icons.ts` with `export const PATHS`.
- Contingency (S02's overrun fallback): if S02 landed A1+A2 only, A3 (Settings)
  lands here as step 0, before B1, exactly as S02 steps 5-6 specify, with S02's
  fidelity bar and SPM-17 rules intact: `src/views/settings.ts` → `settings.tsx`
  (rename + rewrite, old file deleted), new `src/react/use-message.ts`, and
  `mountScreen`'s settings branch in `src/shell.tsx` switched from S02's
  interim `mountDomView` + `renderSettings` to `mountView(…, <SettingsView/>)`.
  Its review rides this session's review cycle (B2's scope then also covers
  A3), and S02's Settings exit criteria and checklist item 4 join this
  session's. The bullet above then holds by this explicit hand-off, not
  silently. (If S02 itself absorbed S01's WP3 as its step 0, nothing changes
  here: that work is part of S02's merged diff.)
- The last owner-tested state is S02's merged PR (its Windows check) — B2's
  AGENTS.md delta review starts there.
- Baseline facts for the sweep, verified at 11bacb6: settings.ts had zero
  `title` attributes; shell.ts had exactly two (the back button's static
  `BACK_TO_LIST_TITLE`, shell.ts:49, and the PM tab's dynamic
  `pmTab.title = tab.tooltip ?? ""`, shell.ts:68-69, written only when it
  differs from the current property — so no attribute on first render).

## Files touched
No new files are planned, except under the Preconditions' A3 contingency (then
`src/react/use-message.ts` is new and `src/views/settings.ts` → `settings.tsx`
is a rename + rewrite here, not in S02). The sweep and this session's review
findings land as fixes in these existing files (all created or modified by
S02, or by the contingency's step 0), each modified only where a finding
requires:
- `src/shell.tsx`
- `src/views/settings.tsx`
- `src/react/Icon.tsx`, `src/react/navigation.ts`, `src/react/use-message.ts`,
  `src/react/mount.ts`

The ADR-0010 candidacy record (step 4) goes in the PR description — no ADR is
authored this phase. If a check passes untouched, the file list shrinks
accordingly.

**Do-not-touch** (the one copy — exit criteria, review and Out of scope refer
here). Byte-identical across the whole phase (S02's merge diff plus this session's
diff, Exit criteria): `src/dialog.ts`, `src/combobox.ts`, `src/theme.ts`,
`src/shell-model.ts`, `src/ui.ts`, `src/views/first-run.tsx`,
`src/views/editor.ts`, `src/views/pack-manager.ts`, `src/editor/**`,
`src/pack-manager/**`, all five CSS files, `index.html`, `tests/**` — except
`src/views/first-run.tsx` (and the deleted `first-run.ts`) when S02 absorbed
S01's WP3 as its step 0: they are then part of S02's recorded diff. Phase diff
limited to S02's: `src/icons.ts` (the one-word `export`), `src/main.ts` (S02's
two `unmountShell()` calls + import). This session changes neither.

## Work plan
1. **Tooltip site 1 — back button.** `src/shell.tsx`: the back button carries
   the static `title={BACK_TO_LIST_TITLE}` ("Back to the list of packs",
   shell-model.ts:9). Verify present; verify the button's other attributes and
   text unchanged (`secondary tb-back`, `type="button"`, `← Pack list`).
2. **Tooltip site 2 — PM tab, S02's empty-means-absent rule.** The JSX must
   be `title={tab.tooltip || undefined}` (S02 step 4): no `title` attribute on
   first render, as today; the tooltip text when a pack is open; no attribute
   after the pack closes (today `title=""` — the recorded accepted deviation,
   invisible on hover). `grep -n 'title=' src/shell.tsx` shows exactly the back
   button's and this one; no `?? ""` or `title={null}`-shaped expression on the
   tab. Verify the `.topbar` outerHTML byte-equality in the fresh-boot state
   still holds. This is the whole of Phase 2's tooltip mechanics: the 148 repo-wide sites (81 `.title =` property writes + 67
   `title:` attribute sites, phase-2.md B1 (5)) reduce to these two
   (SPEC §2 "Name (Shortcut)" pairs have no Phase-2 sites); settings.tsx has
   zero title attributes; the other 80 `.title =` property writes (the 81st
   is shell.ts:69, this PM-tab site) sit in un-migrated views and are
   untouched this phase.
3. **B1 checks 2-4, each verified and fixed if drifted:**
   - `dialogOpen()` stays true while a Settings-spawned confirm is open: the
     confirm is dialog.ts's own `document.body` append, outside every React
     root — verify by opening the create-fresh confirm and checking
     `document.querySelector("dialog.app-dialog[open]")` is non-null (the
     dialog.ts:91 poll). No React tree may wrap or re-parent it.
   - Stale navigation drill: open the create-fresh confirm, cancel, immediately
     switch tabs — the shell must navigate live (no dead-screen, no stranded
     no-op in the navigator seam or the PM store adapter). Repeat after a
     re-boot: cancel a confirm, re-point, then navigate.
   - Banner + Settings focus after re-boot lands where it does today, judged by
     what the owner sees: after a re-point re-boot the banner shows once, and a
     keystroke lands where it did before Phase 2 (the owner's typing goes into
     the same field, or nowhere, not into a detached node).
     `document.activeElement` on the same broken-library fixture, compared
     against `11bacb6`'s build, is the measurement of that; a re-boot must not
     double the banner or leave focus on a detached node.
4. **Fix the drift steps 1-3 find** wherever it lands in the Files-touched
   set; nothing else. Findings of this session's B2 review of the S02 diff
   (step 6) are fixed inside its review-cycle rounds, under the same file
   fence. (S02's own review converged before it landed; these are new
   findings from the hardening pass.) Record the two firm island decisions
   (dialog.ts and combobox.ts stay untouched imperative islands through the adoption; the
   Phase-3 dialog-body bridge is the deferred seam) in the PR description as
   ADR-0010 candidacy notes, citing plan.md binding contract #2 — so Phase 3/4
   cannot relitigate mid-migration (phase risk 6).
5. **Verify the phase definition of done mechanically**: `bun run build` +
   `bun test`, and the phase-wide byte-identity check in Exit criteria
   (S02's merge diff plus this session's own diff).
6. **Land per plan.md › Session protocol.** Session-specific inputs: the B2
   review's scope is this session's diff (the AGENTS.md delta since S02's
   owner-tested state) plus the S02 diff as the hardening subject, coverage
   list below, to convergence before any owner testing; the owner Windows check
   runs this file's checklist, the phase gate. A fix found during the Windows
   check goes back through a review-cycle round and step 5 before re-test
   (protocol step 6).

## Deliberately out of scope
- Everything on the Do-not-touch list (Files touched). The sweep must not
  "mechanically" touch the 80 remaining `.title =` sites or any tooltip in un-migrated
  views; that is later phases' conversion work, not hardening.
- No new aria/role attributes, no icon changes, no `<StrictMode>` anywhere in `src/`, no
  dialog-body bridge, no keyed `<Shell>`, no FontPicker/ComboboxIsland work.
- No Phase 3 scope: Pack Manager stays el(); the registry is not extended
  further here.

## Exit criteria
- `bun run build` passes; `bun test` passes (25 files).
- PM tab is `title={tab.tooltip || undefined}` (step 2's grep); back button
  static title present; no `title` attributes in settings.tsx.
- B1 checks verified by name: dialogOpen() true with the Settings confirm open;
  no stale navigation after cancel-then-switch (and after re-boot); banner and
  Settings focus after re-boot match pre-Phase-2 behavior.
- Phase-wide byte-identity, as two diffs (so Rust- or model-only work that
  plan.md lets merge to `main` alongside the port never shows up), each
  limited to plan.md › Session protocol's code pathspec (step 3), so
  `.trekker/` and `.scratch/` commits never appear either:
  - **S02's merge diff.** `S02_MERGE=$(git log --first-parent --merges
    --format=%H -1 --grep='react/s02' main)` (S02's merge commit on `main`)
    and `PHASE_START=$S02_MERGE^1`. `git diff --stat $PHASE_START $S02_MERGE
    -- <code pathspec>` lists only `src/shell.ts` (deleted),
    `src/shell.tsx`, `src/views/settings.ts` (deleted),
    `src/views/settings.tsx`, `src/react/**`, `src/icons.ts`, `src/main.ts`
    (plus `src/views/first-run.ts`/`.tsx` if S02 absorbed S01's WP3; minus
    the settings paths and `use-message.ts` if S02's overrun fallback ran),
    so no Do-not-touch path appears; `git diff $PHASE_START $S02_MERGE --
    src/icons.ts src/main.ts` is exactly S02's recorded diff (the one-word
    `export`; the two `unmountShell()` calls + import, plus S01's step-9
    wiring in the WP3 case).
  - **This session's diff.** `git diff --stat <session base> -- <code
    pathspec>` lists only this session's Files-touched paths (plus, under
    the A3 contingency, the deleted `src/views/settings.ts`); no
    Do-not-touch path, `src/icons.ts` or `src/main.ts` appears.
- Review-cycle both axes converged (step 6 scope); the PR carries the
  ADR-0010 candidacy note.
- Windows checklist passed in full (items 1–8 below).
- PR merged with `gh pr merge <N> --merge`.
- Named behaviors that must not regress, re-checked: PM tab "› {Title}" follows
  renames live; back-button visibility/disabled incl. busy; SPM-17 emoji-select
  rollback; re-point → re-boot with no dirty-container warning.

## Review-cycle coverage
The review-cycle must specifically examine:
- The two tooltip sites' exact semantics (S02's `|| undefined` rule and its
  recorded deviation) and that the sweep did not touch any other tooltip site.
- The dialog island boundary: nothing in the React trees re-parents, wraps or
  re-implements dialog.ts; `confirmChoice` called from the React caller with
  today's Promise/action/Esc semantics.
- The stale-navigation and focus drills as diff-level reasoning, not just
  manual checks: navigator-seam and PM-store-adapter cleanup paths are
  still-ours-guarded; no closure captured across a re-boot.
- That fixes stayed inside the Files-touched set; the Do-not-touch list holds
  after the fixes (Exit criteria's phase-wide diff).
- The PR description records the two island decisions for ADR-0010 candidacy.

## Owner / Windows checklist
Run on Windows, after review convergence and step 5, covering the whole of
Phase 2:
1. The three screens and tab clicks, including the busy-pack tab refusal
   (clicking the PM tab while a busy pack is open does nothing) and the
   back button's disabled state while busy.
2. A long pack Title: the PM tab caps it at 160px with an ellipsis
   (styles.css:186 `max-width: 160px`), and the top bar does not move.
3. A broken Library: boot lands on Settings with the banner, and the banner +
   Settings focus look exactly as before Phase 2 (after a re-point, typing
   lands where it did before).
4. Library re-point and create-fresh, including the create-fresh confirm
   dialog (opens, cancels cleanly, confirms and re-boots).
5. Theme switch: the native Windows title bar follows the choice.
6. Emoji style switching: to each built-in style; the remembered-path rule
   (switching away and back to Custom does not force a re-pick). A broken
   custom font, two cases:
   (a) picked in-session (a broken file chosen, or a broken remembered file
   with the replacement picker cancelled): nothing sticks — the select returns
   to the PREVIOUS style, the error shows in the emoji card's message line, and
   the select is not stranded (`chooseEmojiStyle` throws, emoji-style.ts:162;
   the `finally` re-syncs);
   (b) at boot with a stored Custom whose file no longer loads: emoji render as
   Android and Settings shows the problem line ("…showing Android emoji
   instead.", `applyEmojiStyle`, emoji-style.ts:138-139).
7. "Open licence texts" button: opens the licence files; a failure routes to
   its message line.
8. DPI-scaled hover of both tooltips: the back button's and the PM tab's
   (hover text readable at the owner's usual display scaling).

## Risks and fallbacks
- Review finds structural drift (not spot fixes) → the sweep becomes repair
  work; the Windows check still gates, and S03 may absorb it, but the phase
  definition of done cannot ship partial — the fallback below applies.
- Windows-specifics (backslash paths, native pickers, title-bar theme) are
  invisible on a Linux dev box → the one Windows check carries them (phase
  risk 7).
- Overrun fallback: if this session's review of the S02 diff finds a lot,
  steps 1-3 and the review convergence are non-negotiable, but
  non-regression polish items can be recorded as Phase-3 review items; the
  owner Windows checklist itself never slips past this session's end — it is
  the phase gate.
- If this session's B2 review of the S02 diff and steps 1-3 find nothing, B1
  collapses to verification-only; treat the early finish as buffer for Phase
  3's start (phase file's own note), not as an invitation to pull Phase 3
  scope in.
