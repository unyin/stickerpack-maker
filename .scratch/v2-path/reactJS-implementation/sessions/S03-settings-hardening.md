# S03: Phase-2 contract sweep and hardening (Phase 2)

Covers B1 (contract-preservation sweep and hardening) and B2 (review-cycle to
convergence + the phase's one Windows check) of
[../phases/phase-2.md](../phases/phase-2.md).

Corrections to the phase file:
- Tooltip counts at HEAD ca0b993: 81 `.title =` property writes (phase says
  ~97) and 67 `title:` attribute sites (sum 148 vs the phase's 147; same
  counting pattern, off-by-one). No decision depends on the split — B1's
  Phase-2 scope remains exactly the two shell sites, and the `.title =` writes
  in un-migrated views stay untouched either way.

## Goal
Harden S02's output against the phase's named drift classes, fix everything
S02's review finds, converge the review-cycle on the delta since the Phase 1
owner test, and hand the owner the single Windows check that gates the whole of
Phase 2. When the session ends, every B1 check is verified, both review axes
have converged, the owner's Windows checklist has passed, and the phase's
definition of done holds (shell + Settings in React with byte-identical
markup, all islands and CSS untouched).

## Preconditions
- Phase 0 decisions landed (framework ADR, ticket 08 verdict, sequencing).
- S02 landed: A1 registry + navigator seam, `src/shell.tsx`,
  `src/react/Icon.tsx`, `src/views/settings.tsx`, `src/react/use-message.ts`;
  S02's exit criteria green (build, tests, outerHTML byte-equality, no
  dirty-container warning).
- The last owner-tested state is the S01 (Phase 1) Windows check — B2's review
  is a delta review from there, covering all of S02's diff plus this session's.
- Baseline facts for the sweep, verified at ca0b993: settings.ts had zero
  `title` attributes; shell.ts had exactly two (the back button's static
  `BACK_TO_LIST_TITLE`, shell.ts:49, and the PM tab's dynamic
  `pmTab.title = tab.tooltip ?? ""`, shell.ts:68-69).

## Files touched
No new files are planned. The sweep and S02's review findings land as fixes in:
- `src/shell.tsx` (exists after S02; new)
- `src/views/settings.tsx` (exists after S02; new)
- `src/react/Icon.tsx`, `src/react/navigation.ts`, `src/react/use-message.ts`,
  and the S01 mountView module `src/react/mount.ts` (exists after S02;
  modified only where a finding requires)

The ADR-0010 candidacy record (step 4) goes in the PR description — no ADR is
authored this phase, and nothing outside the sessions' converted surfaces
changes. If a check passes untouched, the file list shrinks accordingly; the
do-not-touch set is absolute (see Exit criteria).

## Work plan
1. **Tooltip site 1 — back button.** `src/shell.tsx`: the back button carries
   the static `title={BACK_TO_LIST_TITLE}` ("Back to the list of packs",
   shell-model.ts:9). Verify present; verify the button's other attributes and
   text unchanged (`secondary tb-back`, `type="button"`, `← Pack list`).
2. **Tooltip site 2 — PM tab, the `?? ""` rule.** Today's code sets the
   property to the empty string, not attribute removal (shell.ts:68-69). The
   JSX must be `title={tab.tooltip ?? ""}`. `grep -n 'title={tab.tooltip}'
   src/shell.tsx` must come back empty; `title={null}`-shaped expressions on
   the tab must not appear either. This is the whole of Phase 2's tooltip
   mechanics: the 148 repo-wide sites (81 `.title =` property writes + 67
   `title:` attribute sites, per the Corrections above) reduce to these two
   (SPEC §2 "Name (Shortcut)" pairs have no Phase-2 sites); settings.tsx has
   zero title attributes; the 81 `.title =` property writes in un-migrated
   views are untouched this phase.
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
   - Banner + Settings focus after re-boot lands where it does today: compare
     `document.activeElement` and the banner's presence against the pre-Phase-2
     behavior on the same broken-library fixture; a re-boot must not double the
     banner or leave focus on a detached node.
4. **Fix every S02 review finding** wherever it lands in the S02 file set;
   nothing else. Record the two firm island decisions (dialog.ts and
   combobox.ts stay untouched imperative islands through the adoption; the
   Phase-3 dialog-body bridge is the deferred seam) in the PR description as
   ADR-0010 candidacy notes, citing plan.md binding contract #2 — so Phase 3/4
   cannot relitigate mid-migration (phase risk 6).
5. **B2 — review-cycle per AGENTS.md** on the delta since the Phase 1 owner
   test, both axes to convergence, before any owner testing. Scope of the
   review: all of S02's diff plus this session's fixes. Implementer/fix rounds
   continue until both axes come back clean.
6. **B2 — owner Windows check** (checklist below). The converted surfaces count
   as done only after it passes. Land the session's PR into `main` with
   `gh pr merge <N> --merge` (AGENTS.md merge rule).
7. Re-verify the phase definition of done mechanically after any last fix:
   `bun run build` + `bun test`, and the byte-identical greps in Exit criteria.

## Deliberately out of scope
- dialog.ts, combobox.ts, theme.ts, shell-model.ts, ui.ts, main.ts,
  views/editor.ts, views/pack-manager.ts, src/editor/**, src/pack-manager/**,
  all five CSS files, index.html, tests/**: byte-identical — the sweep must not
  "mechanically" touch the 81 `.title =` sites or any tooltip in un-migrated
  views; that is later phases' conversion work, not hardening.
- No new aria/role attributes, no icon changes, no `<StrictMode>`, no
  dialog-body bridge, no keyed `<Shell>`, no FontPicker/ComboboxIsland work.
- No Phase 3 scope: Pack Manager stays el(); the registry is not extended
  further here.

## Exit criteria
- `bun run build` passes; `bun test` passes (25 files).
- `grep -n 'title={tab.tooltip}' src/shell.tsx` empty; back button static title
  present; no `title` attributes added or removed in settings.tsx.
- B1 checks verified by name: dialogOpen() true with the Settings confirm open;
  no stale navigation after cancel-then-switch (and after re-boot); banner and
  Settings focus after re-boot match pre-Phase-2 behavior.
- `git diff --stat` for the whole phase against its start shows zero bytes in:
  dialog.ts, combobox.ts, theme.ts, shell-model.ts, ui.ts, main.ts,
  views/editor.ts, views/pack-manager.ts, all five .css files (phase definition
  of done). The `.title =` write sites in un-migrated views: no diff lines
  outside shell.tsx/settings.tsx/src/react/.
- Review-cycle both axes converged (AGENTS.md) on the delta since the Phase 1
  owner test; the PR carries the ADR-0010 candidacy note.
- Owner Windows checklist passed in full (below); PR landed with
  `gh pr merge --merge`.
- Named behaviors that must not regress, re-checked: PM tab "› {Title}" follows
  renames live; back-button visibility/disabled incl. busy; SPM-17 emoji-select
  rollback; re-point → re-boot with no dirty-container warning.

## Review-cycle coverage
The review-cycle must specifically examine:
- The two tooltip sites' exact semantics (the `?? ""` rule vs attribute
  removal) and that the sweep did not touch any other tooltip site.
- The dialog island boundary: nothing in the React trees re-parents, wraps or
  re-implements dialog.ts; `confirmChoice` called from the React caller with
  today's Promise/action/Esc semantics.
- The stale-navigation and focus drills as diff-level reasoning, not just
  manual checks: navigator-seam and PM-store-adapter cleanup paths are
  still-ours-guarded; no closure captured across a re-boot.
- That fixes stayed inside the S02 file set; the do-not-touch greps hold after
  the fixes; icons.ts still exactly the one-word diff; CSS byte-identical.
- The PR description records the two island decisions for ADR-0010 candidacy.

## Owner / Windows checklist
Run on Windows, after review convergence, covering the whole of Phase 2:
1. The three screens and tab clicks, including the busy-pack tab refusal
   (clicking the PM tab while a busy pack is open does nothing) and the
   back button's disabled state while busy.
2. A long pack Title: the PM tab caps it at 160px with an ellipsis
   (styles.css:186 `max-width: 160px`), and the top bar does not move.
3. A broken Library: boot lands on Settings with the banner, and the banner +
   Settings focus look exactly as before Phase 2.
4. Library re-point and create-fresh, including the create-fresh confirm
   dialog (opens, cancels cleanly, confirms and re-boots).
5. Theme switch: the native Windows title bar follows the choice.
6. Emoji style switching: to each built-in style; a broken custom font rolls
   back to Android with the problem line shown and does not strand the select;
   the remembered-path rule (switching away and back to Custom does not force
   a re-pick).
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
- Overrun fallback: if the S02 review findings are large, B1's checks 1-4 and
  the review convergence are non-negotiable, but non-regression polish items
  can be recorded as Phase-3 review items; the owner Windows checklist itself
  never slips past this session's end — it is the phase's single gate.
- If S02 landed with zero review findings, B1 collapses to verification-only;
  treat the early finish as buffer for Phase 3's start (phase file's own
  note), not as an invitation to pull Phase 3 scope in.
