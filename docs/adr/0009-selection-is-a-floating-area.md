# Editor: the selection is a floating area

The Editor's drawn selection (SPEC §6) was target-bound for one cycle: SPM-22's wand region carried its target layer's id, and Cut and Delete read that binding. The owner rejected the cross-target refusals that model implies and ruled (2026-11-24, mid-SPM-23) that the selection be **layer-independent**: a floating area the three selection tools compose (Shift adds, Alt subtracts, whatever tool the new piece comes from), which resolves its target only when Cut or Delete is pressed — the one selected image layer it touches, the old Rectangle/Lasso rule made universal.

- A selection is a stack of contributions: a wand fill in the grid it was filled in (with that layer's transform), or a Rectangle/Lasso polygon in document pixels, each tagged add or subtract. One Rust command (`editor_compose_mask`) folds the stack into a grid's coverage mask: the document grid for the dashed-outline preview and the emptiness rule, the target layer's own grid at apply time — polygons via the same pixel-centre spans as Cut (identical pixels, no resampling), a wand mask as-is when applied back to its fill layer (bit-identical for every pre-existing flow), else one soft resample across grids.
- A plain unmodified Rectangle/Lasso stays SPM-9 geometry untouched; a plain wand click is a single-contribution floating selection. The wand's click-time refusals (transparent spot, outside the layer, text layer, several layers selected) stay: the fill still needs pixels to read.
- A composed selection inherits the wand lifetime: any document change drops it, while plain rect/lasso regions survive. That lifetime plus the edit-clears rule makes the selection's own undo trail safe (ADR-0005's SPM-23 amendment): each Ctrl+Z drains the selection's remaining steps before document undo runs, and a document edit clears the trail outright.

## Rejected alternative

Composing eagerly into the existing selection's target-layer grid (SPM-22's representation, filed as SPM-23's original design): it reuses the mask machinery most directly, but the target binding is the friction — a Rectangle drawn off the target layer, or a wand click on another layer, needs refusal rules, and Cut and Delete stay asymmetric. The floating model deletes those rules: composition never refuses on layers, because there is no target until apply.

## Consequences

- Cut and Delete resolve the target at press. Three corner flows changed against SPM-22 (owner-accepted, SPEC §6): with another layer selected they apply to that layer where the selection touches it; with no or several layers selected Delete refuses with the select-one reason; a Shift wand-click on another layer adds instead of starting fresh. Every owner-tested SPM-22 flow keeps its outcome — the same-placement fast path is bit-identical.
- The dashed outline comes from the merged preview, so holes and unions draw as one boundary; per-contribution internal edges do not draw. The apply is authoritative and the preview is cosmetic: a cross-layer apply re-rasterizes into the target's grid, never through the doc-grid preview.
