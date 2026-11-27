# Phase 1: React scaffolding + first-run pilot (1 session — S01)

Drafted by planning subagent (verified against HEAD 64a809f); spot-checked by the main
session (see [../plan.md](../plan.md) verification record). Session plan:
[../sessions/S01-scaffolding-first-run.md](../sessions/S01-scaffolding-first-run.md)

**Verdict: one session, not 0.5 + 0.5.** The scaffolding is ~30 minutes of mechanical
config; the pilot is 100 lines (`src/views/first-run.ts`) with no imperative islands, no
Konva, no drag systems, no focus-preservation logic and no test coverage to keep green
(`renderFirstRun` is referenced only by `src/main.ts` (:7 import, :24 call) and itself
(first-run.ts:9) — none of the 25 test files touch it). The one genuinely non-trivial design bit (the default-path
race) is contained. Splitting would double the review-cycle and Windows-check overhead
for the same total diff. One session with a natural mid-session checkpoint (end of WP2).

**index.html does not change, and neither does main.ts's name.** index.html loads
`/src/main.ts` as a module script and holds `<div id="app">`; plugin-react transforms at
module level, so a `.tsx` import chain behind main.ts needs no HTML change and main.ts
legitimately stays `.ts` (it is orchestration, not markup). The only structural touch on
the boot path is inside `boot()`: the React mount call replaces the direct
`renderFirstRun` call.

**Goal / definition of done.** React 19 is a working build-time citizen (deps, types,
`jsx: react-jsx`, plugin-react) without a single byte of CSS, HTML, test, or Rust change;
the first-run view runs as a React component mounted into the existing `#app` shell; a
root-tracking `mountView()` helper in shell.ts (or src/react/) enforces "React roots
never outlive their view" for both view switches and re-boots; the licence notices
include react/react-dom; the converted view passes a Windows check.

**Preconditions.** Phase 0 decisions landed (framework ADR, ticket 08 verdict,
sequencing). Nothing else: this phase touches no code any later phase rewrites except
shell.ts, and it touches shell.ts additively.

### WP1: Tooling scaffold + notices

- package.json + bun.lock via `bun add`: `react@^19`, `react-dom@^19`; devDeps
  `@types/react@^19`, `@types/react-dom@^19`, `@vitejs/plugin-react@^5`.
- tsconfig.json: add `"jsx": "react-jsx"` — the only compilerOptions change.
- vite.config.ts: `plugins: [react()]`.
- `bun run licenses` regenerates src-tauri/licenses/THIRD-PARTY-NOTICES.txt (npm section
  auto-collects the runtime dependency closure; react/react-dom ship MIT LICENSE files).
  Risk: if the closure surprises, the fix is one `BORROWED_LICENSE_FILES` line.
- Deliberately NOT: no Tailwind, no shadcn, no eslint/prettier/react-testing-library, no
  test changes, no main.ts or index.html edit, no React component yet.
- Exit criteria: `bun install` clean; `bun run build` passes on the unchanged source
  tree; `bun run test` passes (25 files); `git status` shows only package.json,
  bun.lock, tsconfig.json, vite.config.ts, THIRD-PARTY-NOTICES.txt; the notices diff is
  exactly two new MIT entries; `git diff --stat` empty for all five CSS files.

### WP2: mountView() helper + boot wiring

- A module-level `Map<string, Root>` plus `mountView(container, id, element)` (re-render
  into an existing root for fresh props on re-boot; otherwise unmount and drop every
  other tracked root, then createRoot + render) and `unmountViews()` (called from
  `show()`'s teardown point next to `clear(content)`, so the invariant holds from day
  one even though no shell view is React yet).
- main.ts `boot()`: the `unconfigured` branch mounts the pilot component; the
  `ready`/`invalid` branch calls the unmount path before `renderShell`. The re-boot
  callback still stops at this boundary — shell and its views remain opaque `el()`
  renderers. The keyed-generation Library invalidation is Phase 2+, not built
  speculatively.
- Deliberately NOT: no shell chrome conversion, no store yet, no keyed `<Shell>`.
- Exit criteria: build passes; booting with a configured Library produces a DOM tree
  equivalent to today's shell render; no `createRoot` twice on the same container
  (dev-time instrumentation across createLibrary → onReady → re-boot); the boot error
  path (catch → `root.replaceChildren`) cannot leave a live root over a detached node.

### WP3: First-run pilot conversion

- Delete `src/views/first-run.ts`, create `src/views/first-run.tsx`.
- `chosenPath`/`userChose` → `useState`; the post-mount IIFE resolving
  `getDefaultLibraryPath()` → `useEffect(..., [])` with the race guard intact: the
  resolution must never clobber a folder the user picked while it was in flight — the
  guard reads *current* state at resolution time (functional setState bail or a
  `userChose` ref), not the value captured at mount. Naive porting here is the one
  regression class.
- `withMessage` cannot be reused (it mutates a `<p>` React owns): the choose-folder
  handler reimplements the contract inline — clear message state, run, route
  `errorMessage(err)` into state. `withMessage` stays untouched in ui.ts for un-migrated
  views.
- `createBtn.disabled` during `createLibrary` becomes busy state; error path re-enables.
- Class names identical: `.first-run`, `.card`, `.field-label`, `.path`, `.actions`,
  `.primary`, `.secondary`, `.message` + `role="alert"`, `.muted`, the "Resolving
  default…" placeholder. No new aria/role attributes (UI-audience rule).
- Deliberately NOT: no shared component extraction (Phase 2), no store, no Settings
  conversion.
- Exit criteria: build + tests pass; rendered DOM for the unconfigured state identical
  (same tags, class lists, button disabled states); four named behavioral branches
  preserved: (1) cancel folder pick changes nothing, (2) picking while the default
  resolution is in flight keeps the user's pick, (3) failed resolution shows the
  no-default message plus the error, (4) failed `createLibrary` re-enables Create
  Library and shows the error. Old first-run.ts deleted, not dead code.

### WP4: Review-cycle + Windows check

- Review-cycle per AGENTS.md (both axes to convergence) before any owner testing. The
  review must cover: config diffs (tsconfig gains `jsx` only, vite.config gains the
  plugin only, no strictness loss, only the five named deps); root lifecycle across the
  three transitions (first-run → shell re-boot, boot error path, `show()` switches);
  pilot fidelity line-by-line against the deleted first-run.ts (race guard, disabled
  gating, withMessage-parity, identical class names, no new attributes); invariants
  (five CSS files byte-identical, index.html untouched, 25 test files untouched, no
  `innerHTML`, React imports only in the new tsx + mountView site); the notices diff.
- Owner Windows check: reach the `unconfigured` state by removing/renaming config.json
  in the app-config dir for `com.stickerpackmaker.desktop`. (a) "Resolving default…"
  appears then resolves to Documents\Stickerpack Library with Create Library enabled;
  (b) Choose folder… → cancel leaves everything as it was; (c) pick a different folder,
  verify Create Library uses it; (d) create against an unwritable path shows the error
  and re-enables; (e) successful create lands in the Editor with the shell fully
  functional (proving the clean unmount); (f) one `bun run dev` pass to see Fast Refresh
  on the tsx (today every edit is a full reload — this phase's one dev-workflow payoff).

### Risks

1. Licence-closure surprise → run `bun run licenses` immediately in WP1; fix is one
   BORROWED_LICENSE_FILES line.
2. Boot error path leaks a root → named review item; dev-time instrumentation.
3. Race guard ported wrong (captured state instead of current) → WP3 exit criterion (2)
   + review item; one-line-mistake class.
4. `tsc --noEmit` widening: stray unused import in the tsx fails the build (caught by
   build, not the owner).
5. Windows-only timing: the race may not reproduce on a Linux dev box; Windows check
   items (a)+(c) carry it; the view counts as converted only after the Windows check.
6. Scope creep via "while we're here" → the "deliberately NOT" lists are the review's
   scope fence.
