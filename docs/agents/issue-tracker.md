# Issue tracker: Trekker

Issues for this repo are tracked with **Trekker**, an agent-oriented issue tracker storing data in `.trekker/trekker.db` at the repo root. Use the `trekker` CLI for all operations except Wayfinder maps and their tickets, which are markdown files (see **Wayfinding operations**). Full command reference: `docs/agents/trekker-quickstart.md`.

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

## Wayfinding operations

Used by `/wayfinder`. Wayfinder maps and their decision tickets live as markdown files in `.scratch/`; Trekker holds implementation work. The **map** is a file with one **child** file per ticket. Map and ticket files are edited in the main checkout only (never in a worktree, the same rule as Trekker), and every change to them (create, claim, resolve, update) is committed and pushed straight to `main` at once, like tracker commits, so concurrent sessions see the same state.

- **Effort**: `<effort>` is a short kebab-case slug of the map's name (e.g. `v2-path`, giving `.scratch/v2-path/`). A map is referenced by its folder path (`.scratch/<effort>/`) wherever the skill says URL or number.
- **Map**: `.scratch/<effort>/map.md`, titled `# <map name>`, with the body sections the skill defines.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. Header lines go directly under the `# <ticket name>` title, one per line, in this order: `Type: <type>` (`research`/`prototype`/`grilling`/`task`), `Status: <status>` (`claimed`/`resolved`/`out-of-scope`; omitted while open), `Blocked by: NN, NN` (omitted when none). A file with no `Status:` line is open and unclaimed.
- **Labels**: `wayfinder:map` and `wayfinder:<type>` are expressed by the file location and the `Type:` line.
- **Links**: refer to a map or ticket by its `#` title, linked by relative path (from `map.md`: `[<title>](issues/NN-<slug>.md)`).
- **Blocking**: the `Blocked by:` header line. A ticket is unblocked when every ticket it lists is `resolved` or `out-of-scope`. Create new ticket files first, then add `Blocked by:` lines and cross-reference links in a second pass, using the real numbers.
- **Frontier**: pull `main`, then scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Zoom**: read a ticket (open or closed) by opening its file via the map's link; resolved and out-of-scope tickets keep their file and `## Answer`.
- **Claim**: pull `main` and check the ticket is still unclaimed, then set `Status: claimed`, commit and push before any work. If the push is rejected, undo the local claim commit with `git reset --keep HEAD~1` (it keeps unrelated uncommitted changes, such as the tracker DB), pull, and re-check; if another session claimed it first, pick again from the frontier.
- **Resume**: a claimed ticket belongs to the session that claimed it, so the frontier skips it. Resume one only when the user names it. Before a context reset, add a short `## Progress` note to the claimed ticket, then commit and push it (the counterpart of Trekker checkpoint comments).
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions so far.
- **Rule out of scope**: set `Status: out-of-scope`, then add one line (gist, why it is out of scope, link) to the map's Out of scope section.
- **Update or delete**: when a decision invalidates a ticket, edit its file in place or delete it, and update every `Blocked by:` line that lists it. Never reuse a deleted ticket's number.

When a map's way is clear (every ticket `resolved` or `out-of-scope`, Not yet specified empty) and the plan is executed into work, create the resulting epics and tasks in Trekker per **Conventions**; each task's description cites by path the decision tickets it rests on.
