## Agent skills

### Issue tracker

Issues are tracked with Trekker (`.trekker/trekker.db`), managed via the `trekker` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

### Merging PRs

Land every PR into `main` with a regular merge commit (`gh pr merge <N> --merge`), never squash or rebase. Feature branches are often built on other unmerged branches, and squashing rewrites their commits, so later merges of `main` into the dependent branches conflict with their own changes.

### Review before manual testing

Always run the `review-cycle` skill on a change, until both axes converge, before asking the owner to test it by hand (a Windows check or re-test). A delta review of the changes since the last state the owner tested is enough. The owner's test time is the expensive step, so review catches what it can first.

### Review-cycle sub-agent models (OpenCode harness)

Pin model AND effort variant explicitly on every `review-cycle` spawn — a bare model ID leaves effort at its default. Reviewer sub-agents (both axes, every round): `mistral/zai-glm-5-3#high` — GLM-5.3 on the Mistral provider (listed there as `zai-glm-5-3`), high effort (owner, 2026-11-24: moves the reviewer off `opencode-go/glm-5.3#high`, the org's EU/US-only hosting block not applying through the Mistral provider, same rationale as the implementer below; no review round needs max — owner, 2026-11-23: the earlier same-day max/high pinning was itself an oversight, the effort change being meant from the start). Implementer sub-agent (applies the fixes): `mistral/deepseek-v4-1-flash-1017#low` — DeepSeek V4.1 Flash on the Mistral provider, low effort (owner, 2026-11-23: replaces the GLM-5.3 stand-in; the org's EU/US-only hosting block does not apply through the Mistral provider). Initial-build implementer (a task's from-scratch feature work): the same model at high effort, `mistral/deepseek-v4-1-flash-1017#high` (owner, 2026-11-24: subagents do the actual coding by standing instruction, and a from-scratch build runs at high effort; the #low pin above keeps its review-fix duty).

### Icons

An icon change never ships without being rendered at its real toolbar size first and judged: pixel math where fidelity is the question (bounds within the viewBox, overlap against a reference), the owner's eyes where taste is. No current model in this setup can view images — verify by measurement, and show the owner a rendered sheet before landing anything visual. (Owner, 2026-11-23, after the SPM-8 icon saga: CMT-300/301.)

### UI audience

The UI serves the owner's own mouse-and-screen use. Judge a UI change by what the owner sees and clicks: visual contrast counts and is measured. Screen-reader and Tab-only access sit outside that scope, so they never enter trade-offs, briefs or review findings; existing aria/role attributes stay as they are. (Owner, 2026-11-25, SPM-26.)
