## Agent skills

### Issue tracker

Issues are tracked with Trekker (`.trekker/trekker.db`), managed via the `trekker` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

### Merging PRs

Land every PR into `main` with a regular merge commit (`gh pr merge <N> --merge`), never squash or rebase. Feature branches are often built on other unmerged branches, and squashing rewrites their commits, so later merges of `main` into the dependent branches conflict with their own changes.
