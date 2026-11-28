# React + shadcn/ui view layer

Up to v1 the webview is plain TypeScript: one `el(tag, attrs, ...children)` helper builds the DOM by hand (375 call sites), four views re-render whole trees, ~2.8k lines of CSS style them, and Konva fills one container in `stage.ts` (ADR-0005). The owner wants the UI reworked on [shadcn/ui](https://ui.shadcn.com/) for v2, and v2 brings a lot of new UI with it: right-click menus, hold-to-reorder, an emoji picker, Settings pages, new Editor controls (SPEC §9, v2 plan). shadcn/ui is React + Tailwind source copied into the repo, so it needs a framework (owner decisions 2026-11-27, Wayfinder map `.scratch/v2-path/`, ticket "Triage: Look and feel").

## Decision

**The webview's view layer moves to React 19, then to real shadcn/ui on Base UI primitives and Tailwind v4. Konva stays vanilla. The app keeps its own colours.**

- **React first, with today's look kept.** React 19 + `@vitejs/plugin-react`. Every view is hand-ported (no `el()`-to-JSX codemod), and all five CSS files stay byte-identical through the port. The pure model code (`*/model/*`, `save.ts`, `shell-model.ts`, the api wrappers, `geometry.ts`) is reused verbatim. The plan is `.scratch/v2-path/reactJS-implementation/plan.md` (12 sessions, Trekker EPIC-4), and its binding contracts govern the port: incremental mounting through one registry, `useSyncExternalStore` over external stores (`EditorSession`, a `PackViewStore`, an `EditorController` extracted before any React exists), and no `<StrictMode>` during the adoption.
- **Konva stays a vanilla imperative leaf behind a ref**, keyed on session identity. Not react-konva: the stage's gesture and pixel half (lasso drafts, wand drags, brush strokes painted into cached canvases, the loupe, `Konva.Transformer`) is not declarative tree diffing, so porting it would be pure regression risk. ADR-0005's split is unchanged: Konva is the view plus the live brushes, the model and history are ours, and Rust does the one-shot pixel work.
- **Then shadcn/ui** (Trekker EPIC-5): components copied in through the shadcn CLI, on **Base UI** primitives (shadcn's default). **Tailwind v4 without Preflight**: `styles.css` already resets what matters, and unlayered app CSS beats layered Tailwind. A `@custom-variant dark` follows the `data-theme` attribute. The existing CSS is retired component by component as shadcn replaces it. The style (control heights, radius) is the owner's pick from a rendered comparison sheet.
- **The app's own colour values go into shadcn's CSS variables**, plus new success and warning variables (shadcn has neither). shadcn's default light border (1.26:1) and focus ring (2.59:1) fail the repo's 3:1 contrast rule (AGENTS.md, UI audience), so every pair is measured against 3:1 before it lands. The former "unified tone styles" item folds in here: `.tone-success`/`.tone-danger` become the shared tone variants.
- **New v2 UI is built on shadcn components, never on `el()`**: ContextMenu for the right-click menus, Popover/Command for the emoji picker, Slider/Switch for the new Settings. The icon pass comes last, with `lucide-react`.
- **Shipped JS roughly doubles**, about 127 to 250 kB gzip (React ~55-60 kB, Base UI + shadcn source the rest). The owner accepts this: Tauri serves the assets locally, and the emoji fonts are 96% of `dist/`.

## Rejected alternatives

- **shadcn's look in plain CSS (option c):** ~3-5 sessions, no framework, no bundle or Konva risk. It adopts shadcn's token names, radius scale, control sizes and button variants, but none of its components. Each v2 widget (context menu, popover, command list) would still be hand-built on `el()`, and the owner wants the real components.
- **Basecoat** (MIT, shadcn's look as plain HTML/CSS/JS): ~6-8 sessions. It keeps `el()` and Konva, but still brings Tailwind with its reset and a `.dark` class. It is a port that tracks shadcn at a distance, and it would leave the hand-built DOM and its re-render idiom in place for all the new UI.
- **shadcn-svelte / shadcn-vue** (MIT, active): about the cost of React, with lighter runtimes (21/26 kB). They are community ports, and the owner chose shadcn itself. The Lit web-component port is dormant.
- **shadcn on top of the current DOM without React:** not possible, since shadcn's components are React.

## Consequences

- **Two passes, in order** (Trekker EPIC-4, then EPIC-5): the React port changes no visible pixel, and the shadcn pass then changes the look on top of it. Every v2 UX task waits for both. Only Rust/model-only work runs alongside the port (the four v1.1 tasks).
- **Dialog and Combobox stay imperative islands during the port.** The React plan's binding contract #2 keeps `dialog.ts` and `combobox.ts` untouched, and React content enters a dialog body only through the bridge pattern: a root created on the dialog's own `.app-dialog-body`, unmounted when its result settles. This ruling is **temporary**: it holds only until the shadcn pass replaces them with shadcn Dialog, Command and Tooltip. The SPEC §2 tooltip and dialog contracts (`dialogOpen()` polling by the keyboard guards, blur-revert, the guard ladders) are that replacement's exit criteria.
- **Licences:** React/react-dom/scheduler and shadcn's dependencies are MIT, Lucide is ISC and cva is Apache-2.0. These are notices only, collected by `scripts/licenses.mjs`.
- **Tests are unaffected:** they target DOM-free model code. Bun reads the tsconfig `jsx` setting, so no new setup is needed. `bun run dev` gains Fast Refresh for `.tsx`.
- **ADR-0005's last consequence holds:** swapping the view layer touches only the view, because the model and the Rust pixel code never depend on it.
