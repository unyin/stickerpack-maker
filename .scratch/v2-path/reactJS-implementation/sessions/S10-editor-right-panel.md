# S10: Right panel — Layers, Actions, Emoji (Phase 4)

## Goal

Port the Editor's right panel to JSX: `LayersPanel` (layers list + layerHint),
`ActionsPanel` (the action grid as a pure React list) and `EmojiPanel` (the
Emoji String box). When this session ends, the right panel is fully React, the
`afterShow` reveal hooks are effects on tab show with the hidden-tab no-layout
rule preserved, actions render identically for the same history, and
`renderActionList()` is deleted from `actions-list.ts` while `actionList()` and
`revealCurrentAction()` stay verbatim.

## Preconditions

- S09 landed: Toolbar + ToolsPanel are JSX; the remaining el() code in
  `src/views/editor.ts` is the right panel + text controls + save flows.
- S07's controller exposes `session`, `emoji` (`SessionEmoji`), `emojiLeafHidden`,
  `commitEmoji()`, and the layer/action selection state via `session.subscribe`.

## Files touched

| Path | Status |
|---|---|
| `src/views/editor/LayersPanel.tsx` | new |
| `src/views/editor/ActionsPanel.tsx` | new |
| `src/views/editor/EmojiPanel.tsx` | new |
| `src/views/editor/EditorApp.tsx` (from S08) | modified — right-panel `ImperativeNode` embeds become the three components |
| `src/views/editor.ts` | modified — right-panel el() build sections deleted |
| `src/editor/view/actions-list.ts` (159 LOC) | modified — `renderActionList()` (:114) removed (ported to JSX); `actionList()` (:60), `SESSION_START`, `ACTION_LIST_ROWS` (= 20, :57) and `revealCurrentAction()` (:152) stay verbatim |
| `src/editor/view/reveal.ts` (24 LOC) | **untouched** — `revealRow()` (:17) used verbatim |

## Work plan

1. **`LayersPanel.tsx`:** the layers list + `layerHint`, ported line-by-line
   from the el() build in git history. Layer labels come from `layerLabel`
   (the "name (base image)" rule at :2581+) — same logic, same strings.
   Reveal: `revealRow(scroller, row)` (reveal.ts:17) used verbatim; its 0.5px
   rule means an in-view row is never nudged — do not replace it with
   `scrollIntoView`.
2. **Tab-show reveals as effects:** today `rightTabs.afterShow.layers`
   (:954, `revealSelectedLayer(layersList, session?.selection.at(-1) ?? null)`)
   and `rightTabs.afterShow.actions` (:969, `revealCurrentAction(actionsList)`)
   run when a tab becomes visible — because a hidden tab must not be measured
   (the hidden-tab no-layout rule; the comment at :2274 explains the same
   mechanism for the actions list). Port these as effects keyed on tab
   visibility, not on data change: a re-render while the tab is hidden must
   not scroll anything.
3. **`ActionsPanel.tsx`:** the JSX port of `renderActionList()` (actions-list.ts
   :114–152) — the current badge on the current row, nested Select steps, the
   blank striped fill down to `ACTION_LIST_ROWS` (20 rows), and the
   terminal-tail reveal via `revealCurrentAction(list)`. The model still comes
   from `actionList(trail, selection)` (:60) verbatim; the JSX must produce the
   same DOM (same classes, same striping) as `renderActionList` did — diff the
   two builds on a scripted history before deleting the old function. Rows
   stay **read-only** — this session does not make them interactive.
4. **`EmojiPanel.tsx`:** the Emoji String box. Port with exact semantics:
   - Enter and blur commit through `controller.commitEmoji()` (:1057) —
     writes through `SessionEmoji` exactly as before (staged for a fresh
     image, `setEmojiString` for an origin sticker, SPM-15).
   - Warn-only validation: >20 characters warns without blocking.
   - Blocked box shows its reason tooltip (`emojiInput.disabled = busy ||
     emojiBox === null || emojiBlock !== null` :2388 pattern — same
     conditions, same reason string).
   - Thumbnail-mode leaf hiding: `emojiLeafHidden` (:912) hides the Emoji
     leaf, with the reset-to-Layers rule (switching to a Thumbnail session
     lands the panel on Layers).
   - The emoji input keeps its `document.activeElement` sync guard — a
     background reload must not clobber half-typed input (focus-preservation
     contract).
5. **Delete** the right-panel el() sections from `src/views/editor.ts`; what
   remains is text controls + save flows (S11) and the S12 sweep.

## Deliberately out of scope

- Making the Actions rows interactive (still read-only).
- Changing focus-preservation semantics (the emoji input's activeElement
   guard).
- `reveal.ts`, `actionList()`, `revealCurrentAction()` internals.
- The text tool controls and save flows (S11), EffectControls/FontPicker
   (S09 embeds), CSS files (byte-identical), icons.
- No `<StrictMode>` anywhere (binding contract #3 — double-invoked effects
  would churn the Konva stage and double-run the tab-show reveals).
- No new aria/role attributes; existing ones stay as-is (UI-audience rule).

## Exit criteria

- Build + tests pass; all five CSS files byte-identical.
- The Actions list renders identically for the scripted sequence
  open → rect cut → wand Shift → wand Alt → undo ×3, compared against the
  pre-S10 build (same classes, badge position, striping, reveal).
- Layers reveal never nudges an in-view row (`revealRow`'s 0.5px rule intact).
- Emoji commit writes through `SessionEmoji` exactly as before; a
  half-typed emoji survives a background Library reload.
- A hidden right-panel tab is never measured: switching tools while the
  Layers tab is hidden causes no scroll/reveal until it is shown.
- Review-cycle converged; PR lands via `gh pr merge --merge`.

## Review-cycle coverage

- DOM identity of the actions list: the reviewer compares the JSX output
  against `renderActionList` (still in git history) for the scripted
  sequence — striping math and badge placement are the likely drift points.
- `actionList`/`revealCurrentAction`/`revealRow` byte-identical (only
  `renderActionList` deleted from actions-list.ts).
- The afterShow ports: effects keyed on tab visibility, not data; no reveal
  runs for a hidden tab.
- Emoji: the disable conditions (:2388 pattern) and the reason string
  unchanged; commit path still `commitEmoji()` → `SessionEmoji`; the input
  remains uncontrolled with its activeElement guard.

## Owner / Windows checklist

1. Layers: select a layer far down the stack (scrolled out of view) — the
   list reveals it without nudging already-visible rows.
2. Actions: the current badge follows undo/redo (undo ×3, redo) and sits on
   the right row; the lined-paper striped fill looks identical.
3. Actions reveal: make the list long, switch tabs away and back — the tail
   reveals on show, not while hidden.
4. Emoji box: Enter commits and hands focus back as before; >20 characters
   warns without blocking; a blocked box shows its reason tooltip.
5. Open a Thumbnail session — the Emoji leaf is hidden and the panel lands
   on Layers; switch back to a sticker session — the leaf returns.
6. Type in the emoji box, background-reload the Library (Settings re-point) —
   the half-typed text survives.

## Risks and fallbacks

- **Focus-clobbering by re-render** (risk #4): the emoji input is
  uncontrolled with the same guard; the reviewer greps for any `value={…}`
  that would make it controlled.
- **Hidden-tab measurement** (the reason `afterShow` exists): a naive
  data-keyed reveal effect would scroll a hidden tab and blow up on
  remeasure; the exit test covers it explicitly.
- Fallback if the session overruns: EmojiPanel can slip to S11 (its commit
  flow is adjacent to S11's SessionEmoji/save work) — Layers + Actions must
  land, since S11's libraryGeneration symptoms assume the emoji box exists
  only as a consumer, not as a port. If EmojiPanel slips, it slips to
  **S11's step 0 by explicit hand-off** (S11's Preconditions name the
  contingency; it lands before S11's own text-controls work) — never a
  silent absorption.
