# Phase 2: Shell, shared widgets, Settings (2 sessions — S02–S03)

Drafted by planning subagent (verified against the tree at ca0b993: shell.ts 156 LOC,
dialog.ts 93, combobox.ts 266, settings.ts 306, shell-model.ts 38, theme.ts 65,
icons.ts 69; dialog imported by 7 files, Combobox by exactly 2 — font-picker.ts and
dialogs.ts:389; settings.ts has zero `title` attributes, shell.ts has two).
Session plans: [../sessions/S02-shell-mount-registry.md](../sessions/S02-shell-mount-registry.md),
[../sessions/S03-settings-hardening.md](../sessions/S03-settings-hardening.md)

**Goal.** The top bar (tabs, back button, banner), the shell chrome, and Settings render
as React; Pack Manager and Editor remain `el()` views mounted into the shell's content
container through the shared registry. `dialog.ts`, `combobox.ts`, `theme.ts`,
`shell-model.ts`, `ui.ts` and all five CSS files are untouched; `main.ts` gains only
two `unmountShell()` calls (S02 step 1).

**Definition of done.**
- `src/shell.tsx` renders header/banner/content with today's exact class names
  (`.topbar`, `.tb-slot`, `.nav`, `.nav-btn`, `.brand`, `.tb-back`/`.tb-hidden`,
  `.banner`, `.tab-sep`, `.tab-pack`, `.content`); `renderShell(container, state,
  onChanged)` keeps its signature, so main.ts's call is unchanged (its only edit is
  S02's two `unmountShell()` boot-path calls).
- `src/views/settings.tsx` renders the four cards identically; library re-point and
  create-fresh still fire the re-boot.
- `bun run build` + `bun test` pass; S02 passes its own Windows check before merging
  (plan.md › Session protocol), and S03's phase-gate Windows check covers all three
  screens, tab clicks, back button, library re-point re-boot, Settings dialogs,
  emoji-style change without re-boot; `git diff --stat` zero bytes in dialog.ts,
  combobox.ts, theme.ts, shell-model.ts, ui.ts, views/editor.ts, views/pack-manager.ts,
  all .css.

**Preconditions.** Phase 1 landed (deps, plugin, jsx key, mountView helper, first-run
pilot Windows-checked). None of it exists today in the tree (verified).

## Firm widget decisions

**Dialog (`src/dialog.ts`, 93 LOC): keep as an untouched imperative island. No re-
implementation, no wrapper.**
- Every Phase 2–3 consumer is non-React code: `views/editor.ts:189` (drop dialog),
  `pack-manager/view/dialogs.ts:33` (holds a `DialogHandle`), `save-dialog.ts:12`,
  `pack-view.ts:61`, `pack-list.ts:21`, `upload-list.ts:8`. Settings' single
  `confirmChoice` call is the only React-side caller this phase.
- The contract is API-shaped, not render-shaped: the Promise `result`,
  `action()`-before-close, Esc→cancel, `defaultChoice` focus, and `dialogOpen()`'s DOM
  poll of `dialog.app-dialog[open]` all behave identically whatever builds the subtree,
  because the dialog appends itself to `document.body` — outside every React root,
  immune to shell re-boots.
- A React re-implementation would still have to re-export the same imperative
  signatures for un-migrated callers: re-implementation risk with zero removed code.
- Deferred seam (for Phase 3, binding): when dialog *bodies* need React content, the
  bridge pattern (plan.md binding contract #2: createRoot on the dialog's own
  `.app-dialog-body` element, rendered in `flushSync`, unmount when the result
  settles) is the mechanism — a type widening, not a rewrite.

**Combobox (`src/combobox.ts`, 266 LOC): untouched imperative island through the whole
adoption.**
- Both consumers are imperative islands themselves (`FontPicker`, `packPicker` inside
  el()-built dialogs). React-ifying the class forces a ref-shim or migrating both
  consumers early — out of sequence.
- Its API is inherently imperative (`renderOption` mutates a DOM node, `setItems`
  reuses option DOM, blur-revert, mousemove highlight, mousedown preventDefault,
  `aria-activedescendant`) — behavior-drift bait with zero payoff.
- Escape hatch for later: a ~30-line `<ComboboxIsland config items value onChange/>`
  ref + useEffect wrapper. Because it exists and is cheap, the firm commitment is "do
  not touch combobox.ts at all."

**theme.ts: reused verbatim, no store.** Self-applying (`data-theme` on `<html>`,
native window theme). React's only interaction is the select's `onChange` calling
`setThemePreference`; selected option is component-local state seeded from
`getThemePreference()`.

**icons.ts: one-word edit + a twin component.** `export const PATHS` (only edit); new
`src/react/Icon.tsx` emitting byte-identical markup (`<svg class="icon icon-{name}"
viewBox="0 0 24 24" aria-hidden focusable="false">`, one `<path d>` per entry).
`icon()`/`explorerLabel()` stay for un-migrated sites. React cannot take a raw
`SVGSVGElement` as a JSX child; a ref-append would add a stray node.

## The mixed boundary (what the mount registry must guarantee)

The shell root (one `createRoot` per `renderShell` call, tracked separately and
unmounted before the next on re-boot — React 19 warns on a dirty container) renders the
top bar, the banner, and `<main className="content" ref={contentRef}/>` — an empty
ref-leaf with no JSX children, ever (React must never own mounted el() views' DOM).

1. **Exactly one view at a time**: on switch, unmount every tracked React root (from
   the navigation handler, before the screen state changes — never in an effect
   cleanup; binding contract #1's `unmountViews()`), then
   `container.replaceChildren()`, then mount the next — so `dialogOpen()` polls and
   `document.activeElement` checks never see two views.
2. Un-migrated views are plain DOM mounts the registry tracks as "not a root, dies
   with replaceChildren".
3. Navigation across the boundary is a module-level seam mirroring
   `setPackManagerListener`: `setNavigator((view: ViewId) => ...)` registered in an
   effect (registration only — it mounts no view); un-migrated code (setEditorNav callbacks, openFileInEditor closures,
   showPackList) calls it; cleanup restores a no-op only if still ours.
4. PM state for the chrome via `useSyncExternalStore(subscribe, packManagerState)` —
   a thin adapter over `setPackManagerListener`; `shell-model.ts` (`packTabLabel`,
   `tabClickAction`, `backButtonState`) reused verbatim as the render math.
5. **The re-boot callback stops at the boundary**: Settings receives `onLibraryChanged`
   doing `forgetPackManager(); resetPackMemory(); forgetEditorOrigin(); onReboot()` —
   exactly today's callback. Phase 2's full root unmount/remount per boot is the
   ADOPTED permanent design (binding contract #1: it reproduces today's scorched-earth
   boot semantics); the keyed persistent root is a post-adoption option, not scheduled.

## Session A (S02)

**A1. Mount registry + navigation seam.** Extend the Phase 1 helper; new
`src/react/navigation.ts` (~20 LOC). Exit: build passes; switch order documented in a
doc comment; no behavior change yet.

**A2. Shell chrome in React.** `src/shell.ts` → `src/shell.tsx` (only importer is
main.ts, extensionless import survives); `src/react/Icon.tsx`; the one-word icons.ts
edit. `refreshChrome` becomes render output driven by the PM store adapter; `show()`
stays the one navigation handler, outside React, never an effect (binding contract #1):
`unmountViews(); flushSync(() => setScreen(next)); mountScreen(next)` (`mountScreen`
a closure built in `renderShell`'s scope, passed to `Shell` as a prop — S02 step 4); at
boot `mountShell()` renders inside `flushSync`, then `mountScreen(initialScreen(state))`
mounts the initial view the same way — so no frame paints an empty content area, and every view root is created outside
any React commit. It must also re-run the mount for the *current* screen: today
clicking the PM tab while on the pack list re-runs `show("pack-manager")` →
`list.reload()` (`tabClickAction` returns `"show"`, shell-model.ts:31;
views/pack-manager.ts:76-83,106-115, header :2-4) — React's state-identity no-op
would silently drop that re-read. `setEditorNav` wired via the
navigator. NOT: shell-model.ts, theme.ts, main.ts (beyond the two `unmountShell()`
calls), CSS, banner wording, view modules.
Exit: build passes; `document.querySelector('.topbar').outerHTML` before/after
byte-equal (fresh-boot state); all three screens reachable; PM tab "› {Title}" follows renames live; back
button visibility/disabled per `backButtonState` incl. busy; PM-tab click on an open
pack goes to the list; broken-library boot lands on Settings with the banner; re-boot
unmounts cleanly (no dirty-container warning).

**A3. Settings in React.** `settings.ts` → `settings.tsx`; new
`src/react/use-message.ts` (~15 LOC, the React twin of `withMessage`: text in state,
the `<p class="message" role="alert">` always rendered, empty when unset). Four cards
as components; the emoji card as derived state replacing the imperative
`refreshEmojiCard()` loop — with the SPM-17 review-round-3 rule preserved: the state
snapshot re-read in the `finally`, on success *and* failure, so a failed choice cannot
strand the select; the controlled select re-syncs on the snapshot bump. `confirmChoice`
stays the imperative island call. NOT: emoji-style.ts, dialog.ts, api.ts, picker flow
logic, remembered-custom-font recovery (kept line-for-line), Credits text. Exit: four
cards render with identical classes in the same order; re-point → re-boot; create-fresh
shows the imperative confirm from the React caller and cancels cleanly; emoji style
applies in place without re-boot; broken custom-font choice rolls back (SPM-17
scenario); "Choose another file…" only visible while Custom is active; "Open licence
texts" still routes errors to its message line.

## Session B (S03)

**B1. Contract-preservation sweep and hardening.** Fixes wherever A2/A3 review finds
drift. Checks: (1) the two Phase-2 tooltip sites — back button static
`title={BACK_TO_LIST_TITLE}` and the PM tab `title={tab.tooltip || undefined}` (today
the tab has no `title` on first render; the attribute is omitted while empty — S02
step 4, which records the open-then-close `title=""` difference as an accepted,
invisible deviation); (2) `dialogOpen()` still true while a
Settings-spawned confirm is open; (3) stale navigation: open the create-fresh confirm,
cancel, immediately switch tabs — no dead-shell navigation; (4) banner + Settings focus
after re-boot lands where it does today; (5) the 148 tooltip sites: the 67 `title:`
attribute sites in el() become JSX `title` props mechanically; the 81 `.title =`
property writes in
un-migrated views are untouched this phase (verified: settings.ts has zero, shell.ts
the one dynamic site). SPEC §2's "Name (Shortcut) — description; disabled reason
replaces description" has no paired sites in Phase 2, so the spot-check reduces to the
two sites.

**B2. Review-cycle to convergence + Windows check.** Review per AGENTS.md on the delta
since S02's owner test, plus the S02 diff as the hardening subject. Windows checklist: the three screens and tab clicks
(incl. busy-pack tab refusal and back-button disabled), the long-pack-title tab cap
(160px ellipsis), broken-library banner boot, library re-point and create-fresh incl.
the confirm dialog, theme switch (native title bar follows), emoji style switching
incl. a broken custom font and the remembered-path no-re-pick rule, licence texts
button, DPI-scaled hover of both tooltips.

## Risks

1. `createRoot` on a dirty container / double shell during re-boot → module-level root
   handle + unmount-first; exit criterion checks for the dev warning.
2. React clobbering el() DOM in the content leaf → the leaf has zero children by
   construction; the registry (`src/react/mount.ts`) is the only writer; B1 review
   checks the JSX.
3. Stale `setPackManagerListener`/`setEditorNav` slots after unmount → adapters restore
   a no-op only when still registered (the same replace-semantics the existing code
   documents).
4. Async message elements held across re-renders → `useMessage` keeps text in state,
   always renders the `<p>` (stable tree position).
5. Emoji-select stranding (SPM-17 regression) → controlled select + `finally` snapshot
   re-read is an explicit exit criterion.
6. Widget decisions relitigated later → both islands reversible; record for ADR-0010
   so Phase 3/4 doesn't relitigate mid-migration.
7. Windows-specifics (backslash paths, native pickers, title-bar theme) → the one
   Windows check.

The 1-session variant is real only if A2+A3 land without review findings; with the
mixed-boundary registry brand new, plan 2 and treat an early finish as buffer for
Phase 3's start.
