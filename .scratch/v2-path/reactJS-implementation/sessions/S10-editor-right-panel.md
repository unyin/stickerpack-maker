# S10: Right panel — Layers, Actions, Emoji (Phase 4)

Anchors are `src/views/editor.ts` lines at commit `11bacb6` unless a file is named
(plan.md › Anchor base): after S07–S09 the code has moved, so read
`git show 11bacb6:<file>` and find today's code by the symbol named beside each line.

## Goal

Port the Editor's whole right panel (`<aside class="editor-layers">`, built at
:1005–1011) to JSX:

- `RightPanel` — the aside, the right tab row (the `tabSet("layer", …)` markup of
  `tabSet` :758–809: `editor-tabrow` tablist, three `editor-tool-tab` buttons with
  their titles :920–923) and the three `editor-tabpanel` sections inside
  `editor-tools-body`.
- `LayersPanel` — the layers list in its listbox, the **Layer-actions cells**
  (the phase file's "action grid", :926–948: Add, Delete, Move up, Move down,
  Merge with their `editor-cell-*` classes and disabled/title rules) and
  `layerHint`.
- `ActionsPanel` — the Actions listbox plus the "Read-only for now" note (:962);
  inside it, `ActionsList` (its own module, `ActionsList.tsx`), a pure component
  taking an `ActionListModel` — the JSX port of `renderActionList()` (actions-list.ts :114–143), which renders the
  Actions tab's history list (the read-only undo trail with nested Select steps).
- `EmojiPanel` — the Emoji String label, textarea and hint (:971–1000).

`RightPanel` renders hidden with no session (`controller.session === null`,
today's `layersPanel.hidden = current === null`, :2331).

When this session ends, the right panel is fully React (under the EmojiPanel slip,
less the emoji section's contents — Risks and fallbacks); both lists reveal on every
render *and* on tab show (today's behaviour, phase-4 S10); the Actions list renders
identically for the same history; `renderActionList()` is deleted from
`actions-list.ts` while `actionList()` and `revealCurrentAction()` stay verbatim; and
the right-panel section of EditorApp's interim refresh driver is gone.

## Preconditions

- S09 landed: Toolbar + ToolsPanel are JSX; the remaining el() code in
  `src/views/editor.ts` is the right panel + text controls + save flows.
- S07's controller exposes `session`, `emoji` (`SessionEmoji`), `emojiLeafHidden`,
  `rightTab` (the shown right tab — controller state, so it survives React
  remounts), `emojiDraft` and `commitEmoji(value)` (takes the typed value; writes the
  stored result to `emojiDraft`, replacing the `emojiInput.value` read/write at
  :1060 and :1064–1065).
- S08's interim refresh driver (EditorApp's `useLayoutEffect` keyed on
  `controller.version`) still runs this session's section of `refresh()` (step 6).
- **Contingency from S09:** if S09 slipped StatusStrip (its Risks and fallbacks;
  pre-authorised whenever S09's step 0 fired), the strip is still an el() embed with
  its driver lines, and it lands here as step 0 by explicit hand-off, before the
  right-panel work; S09's Work plan item 4 is its spec. The S09 PR description
  records whether the slip fired.

## Files touched

| Path | Status |
|---|---|
| `src/views/editor/StatusStrip.tsx` | new — **contingent** on step 0 (S09 slipped StatusStrip); otherwise S09's and untouched here |
| `src/views/editor/RightPanel.tsx` | new — aside, tab row, tabpanel sections (under the EmojiPanel slip, the emoji `<section>` holds the three interim `ImperativeNode` embeds; Risks and fallbacks) |
| `src/views/editor/LayersPanel.tsx` | new |
| `src/views/editor/ActionsPanel.tsx` | new — `ActionsPanel` (imports the controller) |
| `src/views/editor/ActionsList.tsx` | new — the pure `ActionsList`; imports only the model (`actions-list.ts`'s `ActionListModel`/`ACTION_LIST_ROWS`/`revealCurrentAction`) and React, never the controller, so the step 4 test loads no stage.ts/Konva/Tauri graph |
| `src/views/editor/EmojiPanel.tsx` | new — unless the EmojiPanel slip fires (Risks and fallbacks): then not created here, but in S11 step 0 |
| `src/views/editor/EditorApp.tsx` (from S08) | modified — the right-panel `ImperativeNode` embed becomes `<RightPanel/>`; the driver loses the right-panel section (and, if step 0 fires, the status-strip embed becomes `<StatusStrip/>` and its driver lines go) |
| `src/views/editor.ts` | modified — right-panel el() build sections deleted (and the status-strip el() build, if step 0 fires) |
| `src/editor/app/editor-controller.ts` (from S07) | modified — the emoji-leaf / reset-to-Layers rule moves in from `refresh()` (step 1) |
| `src/editor/view/actions-list.ts` (159 LOC) | modified — `renderActionList()` (:114–143) removed, and with it `import { el } from "../../ui"` (:21), which `noUnusedLocals` would otherwise flag; `actionList()` (:60), `SESSION_START` (:47), `ACTION_LIST_ROWS` (= 20, :57) and `revealCurrentAction()` (:152) stay verbatim |
| `src/editor/view/reveal.ts` (24 LOC) | **untouched** — `revealRow()` (:17) used verbatim |
| `tests/editor-actions-panel.test.tsx` | new — the DOM-identity check of step 4 |

## Work plan

0. **(Contingent: S09 slipped StatusStrip.)** Port it first, as this PR's first
   commit — S09's Work plan item 4 is the spec: the `editor-status` strip
   (:1013–1023) with the readout (:2456–2458, text + `off` class), the zoom label
   (`${Math.round(zoom * 100)}%`, as :1251) from `controller.zoom` via its own
   `useSyncExternalStore(controller.subscribeView, …)` so pan/zoom frames re-render
   only the strip, Reset view (`disabled` from `busy`, :2459; click
   `controller.stage?.fit()`, :344) and the dirty dot (`hidden` from `!isDirty`,
   :2562); EditorApp renders it after the workspace, hidden with no session (:2333).
   Delete the status-strip el() build and its embed, the lazy build's
   `subscribeView` subscription that wrote `zoomLabel.textContent` (S08), and the
   driver's strip lines (`statusStrip.hidden` :2333, readout :2456–2458,
   `resetViewButton.disabled` :2459, `dirtyLabel.hidden` :2562). StatusStrip never
   slips twice: if this session then overruns, EmojiPanel takes the slip (Risks and
   fallbacks), never the strip. Otherwise this step is empty.
1. **`RightPanel.tsx`:** the aside `editor-layers` (aria-label "Layers, actions and
   emoji"), the tab row exactly as `tabSet` builds it for group `"layer"` (ids
   `editor-layer-tab-<name>` / `editor-layer-panel-<name>`, `aria-selected`,
   `aria-controls`, `aria-labelledby`, `hidden` on the non-shown sections) and the
   three titles at :920–923 verbatim (reuse S09's left-tab component if it already
   renders `tabSet`'s markup). The shown tab is `controller.rightTab`; a tab click
   is a controller command (set `rightTab`, one notify). The Emoji leaf's `hidden`
   follows `emojiLeafHidden`. **The reset-to-Layers rule moves into the controller
   this session:** S07 left it in `refresh()` (:2374–2379: recompute
   `emojiLeafHidden` from `constraints.mode` on every pass; when it changes, set
   `rightTab = "layers"` and show it). S10 moves that recompute into the
   controller's pre-notify step (plan.md contract #4, the same place as the
   effect-basis discard), where it sets `emojiLeafHidden` and `rightTab = "layers"`
   — never an effect or a render that writes `rightTab`. **Guard it on
   `session !== null`:** today the rule runs only after `refresh()`'s no-session
   return (:2353), and `endSession` resets `constraints = STICKER` (:1408), so an
   unguarded recompute would flip `emojiLeafHidden` on Close and send a reopened
   Thumbnail session from Actions to Layers (today it stays on Actions: the leaf
   state is unchanged across the Close). **S10 deletes S07's tab-show counter**
   (S07 step 5): after S09 the left tabs render from `leftTab`, so the right
   tabs' `show()` call is its last reader, and that call goes in step 6; the
   tab-show reveal keys on `rightTab` switches instead (step 3). The whole aside
   renders `hidden` while `controller.session === null` (:2331).
2. **`LayersPanel.tsx`:** ported line-by-line from `renderLayers` (:2287–2321). Each
   row is an `li` (class `selected` or empty, `data-layer-id`) holding a kind span
   (`editor-layer-kind`: "Image" for a raster layer, else "Text"), the name span
   (`editor-layer-name`, `layer.name`) and, on `selection[0]` only, the
   `editor-layer-size` span from `selectedLayerSize` (:2291); a click calls
   `current.select(layer.id, selectModeFor(e))` (:2316). `layerLabel` (:2580) is
   *not* used here — it names the effect target (:2569, S09's section). Below the
   listbox, the `editor-layer-actions` group (:939–947, role/aria-label as today)
   with the five buttons in DOM order Add, Delete, Move up, Move down, Merge
   selected: labels and base classes as `button()` makes them (:293, :361–366),
   the cell classes `editor-cell-add/delete/up/down/merge` (:931–935), titles from
   :294 and :664–665, and the disabled/title rules from `refresh()`: Add `busy`
   (:2427); Move up/down (:2480–2492); Merge via `mergeBlocker` (:2423, :2493–2494);
   Delete via `deleteReasonOf` with its region-dependent title (:2426,
   :2495–2499). Then `layerHint` (`p.editor-hint.muted`, :287) with
   `layerHintText(…)` (:2556–2561), its cut/editText reasons recomputed from the
   same pure functions (`cutBlocker` :2500, `editTextBlocker` :2520).
3. **Reveal on render *and* on tab show — keep both.** Today `renderLayers` ends
   with `revealSelectedLayer(...)` (:2320) and `renderActionList` with
   `revealCurrentAction(list)` (actions-list.ts :142), so both lists reveal on
   **every** render; while a tab is hidden its zero-size rects make that a no-op
   (the comment at :2273–2275), and the `afterShow` hooks (:954 Layers, :969
   Actions) reveal again when the tab is shown. Port as: a post-render
   `useLayoutEffect` in each list (every render, no dep filter) calling
   `revealSelectedLayer`'s logic / `revealCurrentAction(list)`, plus the same call
   when `rightTab` switches to that tab (a layout effect keyed on `rightTab`; no
   counter). A write of the already-shown tab (a click on it, the leaf rule while
   on Layers) is no switch, but it notifies, and the every-render reveal covers
   it, as today's `afterShow` did. A render while the tab is hidden still
   calls the reveal, which still does nothing — exactly today. `revealRow`
   (reveal.ts :17) used verbatim; its 0.5px rule means an in-view row is never
   nudged — never replace it with `scrollIntoView`.
4. **`ActionsPanel.tsx` + `ActionsList.tsx`:** `ActionsPanel` renders the listbox and
   note around `ActionsList`; `ActionsList` (controller-free module, Files touched)
   ports `renderActionList` (:114–143): the `is-current` row with
   `aria-current="step"` and its `editor-actions-badge` "current" span, the Select row's nested `ol.editor-actions-sub`, the
   `editor-actions-empty muted` "No actions yet." line, the `editor-actions-fill`
   blanks (`aria-hidden="true"`) topping up to `ACTION_LIST_ROWS`, and the
   terminal-tail reveal (keeping the present row scrolled into view, like a
   terminal's last line) via `revealCurrentAction` (step 3). The model still comes
   from `actionList(trail, selection)` (:60) verbatim. **DOM-identity check, before
   deleting the old function:** `tests/editor-actions-panel.test.tsx` renders
   `ActionsList` with `renderToStaticMarkup` (react-dom/server, no DOM needed) for
   model fixtures built the way `tests/editor-actions.test.ts` builds them —
   fresh session (start row, empty line, 18 fills), a trail with the present mid-way (after
   undo), a Select row with nested steps, and more than 20 rows (no fills) — and
   asserts each equals an expected-markup string transcribed from
   `renderActionList` at `11bacb6`. The reviewer checks each expected string
   against that function line by line. Rows stay **read-only**.
5. **`EmojiPanel.tsx`** (the designated overrun slip — Risks and fallbacks; when it
   fires, this item is S11 step 0's spec and S10 ships the three interim embeds instead):
   label `editor-emoji-label`, textarea `editor-emoji-input`
   (id, `rows="5"`, `spellcheck="false"`, aria-label), hint text (:975–999):
   - Enter (without Shift) prevents the default and blurs; blur calls
     `controller.commitEmoji(textarea.value)` (:983–990). Shift+Enter falls
     through and inserts a newline, as today (`e.shiftKey` check, :986).
   - The stored result arrives via `emojiDraft` (S07's seam): EmojiPanel's layout
     effect writes a pending `emojiDraft` into the uncontrolled textarea
     **unguarded**, as :1065 did (S07 step 5), then clears it silently — a consume
     of a pending value, which plan.md contract #4 allows in an effect body and
     which never notifies. `SessionEmoji` semantics
     unchanged (staged for a fresh image, `setEmojiString` for an origin sticker,
     SPM-15). Warn-only validation: >20 warns in the message row, never blocks.
   - Blocked box: `disabled = busy || emoji === null || blocked !== null` and the
     `blockedTitle(...)` title (:2386–2393) — same conditions, same strings.
   - The textarea stays uncontrolled; the same layout effect's `emoji.value` sync
     keeps the `document.activeElement !== input` guard (:2394) — a re-render never
     clobbers half-typed input (focus-preservation contract). Only the pending
     `emojiDraft` write skips the guard, as today.
6. **Driver section out:** delete the right-panel lines from EditorApp's interim
   refresh driver — `renderLayers` + the leaf rule + `renderActionList` + the emoji
   sync (:2368–2394), the no-session clears (:2354–2355), the right panel's
   `layersPanel.hidden = current === null` (:2331, left in the driver by S08), the
   counter-driven right-tab `show()` call (S07 step 5: `rightTabs.show(rightTab)`
   when the tab-show counter moved — now RightPanel renders `rightTab` and runs the
   tab-show reveal of step 3) together with the counter itself (step 1), the Add line (:2427), the move/merge/delete lines
   (:2478–2499) and the `layerHint` write (:2556–2561). Under the EmojiPanel slip
   the emoji lines (:2383–2394) stay (Risks and fallbacks).
7. **Delete** the right-panel el() sections from `src/views/editor.ts` (and
   `button()` :2949 if the layer buttons were its last callers; under the EmojiPanel
   slip the emoji label/textarea/hint nodes stay for the embeds); what remains is
   text controls + save flows (S11) and the S12 sweep.
8. **Land per plan.md › Session protocol.**

## Deliberately out of scope

- Making the Actions rows interactive (still read-only).
- Changing focus-preservation semantics (the emoji input's activeElement guard).
- `reveal.ts`, `actionList()`, `revealCurrentAction()` internals.
- The text tool controls and save flows (S11), EffectControls/FontPicker (S09
  embeds), CSS files (byte-identical), icons.
- No `<StrictMode>` anywhere in `src/` (binding contract #3 — double-invoked
  effects would churn the Konva stage and double-run the reveals).
- No new aria/role attributes; existing ones stay as-is (UI-audience rule).

## Exit criteria

- Build + tests pass; all five CSS files byte-identical.
- `tests/editor-actions-panel.test.tsx` passes: `ActionsList` markup equals the
  `renderActionList` transcription for every fixture.
- Layers reveal never nudges an in-view row (`revealRow`'s 0.5px rule intact);
  both lists reveal on render and on tab show.
- The five layer-action buttons keep their order, classes, disabled rules and
  titles; the right tab row keeps its ids, titles and aria wiring.
- Emoji commit goes through `commitEmoji(value)` → `SessionEmoji`, with the stored
  result shown via `emojiDraft`; the textarea has no `value=` prop (unless the EmojiPanel slip fired: then
  this criterion moves to S11 step 0).
- The right panel's shown tab survives a tab switch away from the Editor and back
  (read from `controller.rightTab`).
- EditorApp's driver holds no right-panel line: a grep of it finds no `layersPanel`,
  `layersList`, `actionsList`, `emojiInput`, `layerHint`, `addButton`,
  `deleteButton`, `upButton`, `downButton`, `mergeButton` or `rightTabs`
  reference (`emojiInput` and the emoji lines :2383–2394 excepted when the
  EmojiPanel slip fired — they move with it to S11 step 0); `refresh()` no longer holds the emoji-leaf rule (it lives in the
  controller's pre-notify step, guarded on `session !== null`); the tab-show
  counter is gone from the controller.
- The right panel is hidden with no session.
- If step 0 fired: `src/views/editor.ts` holds no `"editor-status"` el() build
  (:1023); EditorApp's driver no longer writes `statusStrip.hidden` (:2333), the
  readout (:2456–2458), `resetViewButton.disabled` (:2459) or `dirtyLabel.hidden`
  (:2562), and no `zoomLabel` reference is left anywhere; panning and zooming
  re-render only StatusStrip (S09's exit check, run here).
- Windows checklist passed.
- PR merged with `gh pr merge <N> --merge`.

## Review-cycle coverage

- DOM identity: the test's expected strings against `renderActionList` at
  `11bacb6` — striping math and badge placement are the likely drift points.
- `actionList`/`revealCurrentAction`/`revealRow` byte-identical (only
  `renderActionList` and its `el` import deleted from actions-list.ts).
- Reveal: on every render (no data-keyed filter) and on tab show; no
  `scrollIntoView`.
- Layer-action buttons and layer rows against `renderLayers` / :2423–2499.
- Leaf rule: the pre-notify recompute is skipped with no session (the :2353
  return), so `endSession`'s `constraints = STICKER` never moves `rightTab`.
- Emoji: disable conditions and reason string unchanged; commit via
  `commitEmoji(value)`; the activeElement guard present in the sync effect. Today
  no mouse-and-screen action can notify while the box keeps focus (any click
  elsewhere blurs and commits), so this guard is verified by reading, not by the
  owner.

## Owner / Windows checklist

1. Layers: select a layer far down the stack (scrolled out of view) — the list
   reveals it without nudging already-visible rows.
2. Layer actions: Add, Delete, Move up/down, Merge enable and disable as before;
   hover each disabled one — the same reason shows; the hint line under them reads
   as before.
3. Actions: the current badge follows undo/redo (undo ×3, redo) and sits on the
   right row; the lined-paper striped fill looks identical.
4. Actions reveal: make the list long, switch tabs away and back — the present row
   is in view on show.
5. Emoji box: Enter commits and hands focus back as before; Shift+Enter adds a
   line; >20 characters warns without blocking; a blocked box shows its reason
   tooltip. (If the EmojiPanel slip fired: moves to S11's checklist, step 0.)
6. Leave the right panel on Actions, switch to Pack Manager and back — it is still
   on Actions.
7. Open a Thumbnail session — the Emoji leaf is hidden and the panel lands on
   Layers; switch back to a sticker session — the leaf returns. Then in a
   Thumbnail session pick the Actions tab, Close, and open another Thumbnail —
   the panel is still on Actions.
8. Type in the emoji box, then press Ctrl+Z, Delete and a tool letter without
   leaving it — the keys act on the box only (no editor action), and the text stays.
   (If the EmojiPanel slip fired: moves to S11's checklist, step 0.)
9. (Only if step 0 fired.) Status strip: the readout turns red when off-spec, the
   zoom label tracks pan/zoom, Reset view fits and is disabled while busy, the
   unsaved dot appears after an edit and clears on save; the strip hides with no
   session.

## Risks and fallbacks

- **Focus-clobbering by re-render** ([phase-4 Risks item 4](../phases/phase-4.md#risks)):
  the emoji input stays uncontrolled with the same guard; the reviewer greps for any
  `value={…}` that would make it controlled.
- **Reveal drift:** a reveal keyed on tab visibility alone would stop the list
  following new layers/actions while it is shown; one keyed on data alone would
  miss the show path. Both calls stay (step 3).
- **Fallback if the session overruns — the EmojiPanel slip.** EmojiPanel is the
  designated slip (its commit flow sits next to S11's SessionEmoji/save work);
  Layers + Actions must land here, since their driver section and
  `renderActionList`'s deletion are this session's to remove. It slips to **S11's
  step 0 by explicit hand-off** (S11's Preconditions name the contingency; this
  PR's description records that the slip fired) — never a silent absorption. When
  it fires, S10 ships in its place:
  - **The emoji `<section>` is React-owned.** Today the tabpanel comes from
    `rightSection("emoji", …)` (:991, `rightTabs.section` :924). RightPanel
    renders that `<section>` itself, with the same id/class/role/aria wiring as
    the other two and `hidden` from `rightTab` — no effect writes it.
  - **Only its contents are embedded.** editor.ts keeps the label, textarea
    and hint el() nodes (:975–999, the keydown/blur listeners included; the
    blur passes `emojiInput.value` to `controller.commitEmoji`, S07) and drops the
    `rightSection` call; RightPanel mounts the three nodes through three
    `ImperativeNode` embeds inside the section, one per node (each host is
    `display: contents`, so the tabpanel's flex `gap` between label, textarea
    and hint holds; never one wrapper around all three). The leaf's `hidden` still follows
    `emojiLeafHidden` (step 1).
  - **The emoji driver lines stay** (:2383–2394: the blocked box's
    `disabled`/`title`, the guarded `emoji.value` sync and the pending
    `emojiDraft` write), writing only the embedded el() nodes, until S11 step 0
    deletes them with the embeds.
  - Moved to S11 step 0: Work plan item 5, the Emoji-commit exit criterion, the
    driver grep's `emojiInput` term, and checklist items 5 and 8.
- **Interaction with the StatusStrip hand-off:** step 0 is S09's slip, not this
  session's fallback, so running it does not by itself cost S10 its clean landing
  (plan.md › Clean landing); an EmojiPanel slip still does. S09 having slipped
  already means S09 did not land clean, which rules out S11's absorption of S12
  either way.
