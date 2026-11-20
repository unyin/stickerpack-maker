# Issue tracker: Trekker

Issues for this repo are tracked with **Trekker**, an agent-oriented issue tracker storing data in `.trekker/trekker.db` at the repo root. Use the `trekker` CLI for all operations. Full command reference: `docs/agents/trekker-quickstart.md`.

GitHub Issues (`unyin/stickerpack-maker`, `gh` CLI) were superseded by Trekker on 2026-11-18 by owner decision. Do not file issues to GitHub.

## Invocation (WSL global install)

The project lives in the `Ubuntu` WSL distro at `~/Projects/Stickerpack maker`. Trekker is installed globally via Bun (`~/.bun/bin/trekker`, package `@obsfx/trekker`); its launcher runs on Node.js, installed system-wide. `~/.bun/bin` is on PATH via `~/.profile` and `~/.bashrc`.

Agent shells may run on the Windows side, so wrap commands in WSL and `cd` to the repo root first — the DB lives at `.trekker/trekker.db` relative to the working directory:

```bash
wsl -d Ubuntu -- bash -lc "cd '/home/xuser/Projects/Stickerpack maker' && trekker --toon <command>"
```

From a WSL shell at the repo root, plain `trekker --toon <command>` works.

## Conventions

- **Structure**: epic → task → subtask. The v1 work packages (see `docs/SPEC.md` §10) live under three epics: Foundation, Editor, Pack Manager.
- **Spec first**: `docs/SPEC.md` is the source of truth for requirements; use `GLOSSARY.md` vocabulary in titles and descriptions; read relevant `docs/adr/` entries before implementing.
- **Descriptions**: detailed, actionable, with implementation steps, files to create/modify, and acceptance criteria. Future agents continue from them.
- **Comments are external memory**: add a summary comment before marking a task completed; add checkpoint comments before context resets.
- **Status discipline**: `in_progress` when starting a task, `completed` when done. When all of an epic's tasks are done, `trekker epic complete <epic-id>`.
- **Dependencies**: `trekker dep add <task-id> <depends-on-id>`. A task is startable when all its dependencies are completed. The dependency spine is in `docs/SPEC.md` §10.
- **Output**: always pass `--toon` for token-efficient output.
- **Session start**: `trekker --toon task list --status in_progress`, then read the task and its comments.
- **Triage vocabulary**: the five labels in `docs/agents/triage-labels.md` apply as Trekker **tags** where needed (e.g. `--tags "needs-info"`); Trekker statuses/priorities carry the rest.
