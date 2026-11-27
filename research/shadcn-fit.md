# shadcn/ui in the Stickerpack maker webview: what adopting it would take

Research note for SPM-37's "shadcn/ui rework" idea (2026-11-27). Recommendation-neutral
comparison of three routes, then one read of the cheapest path to the shadcn *look*.
Not a decision. Owner decisions, ADRs and SPEC §9 still govern.

## 1. What shadcn/ui is (and isn't)

- It is not a package. It calls itself "a set of beautifully-designed, accessible components
  and a code distribution platform" and says "This is not a component library. It is how you
  build your component library." The CLI copies component source into your repo, and you
  edit that source directly ([shadcn docs intro](https://ui.shadcn.com/docs)).
- The official components are **React + Tailwind CSS v4** only. The Vite install adds
  `tailwindcss` + `@tailwindcss/vite`, `@vitejs/plugin-react`, an `@/*` path alias in
  `tsconfig.json` and `vite.config.ts`, then runs `shadcn init` and `shadcn add <component>`
  ([Vite install](https://ui.shadcn.com/docs/installation/vite)). The docs name no
  non-React framework ([JavaScript page](https://ui.shadcn.com/docs/javascript)).
- Behaviour comes from a headless primitive library, picked at init. **Base UI has been the
  default since 2026-07-02.** Radix is "not being deprecated" and stays available with
  `npx shadcn init -b radix`
  ([changelog: Base UI as the Default](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/content/docs/changelog/2026-07-base-ui-default.mdx)).
  The registry also has a React Aria base (`apps/v4/registry/bases/{base,radix,aria}/ui/` in
  [shadcn-ui/ui](https://github.com/shadcn-ui/ui)).
- Styling is Tailwind utility strings in the component source, with variants built by
  `class-variance-authority` (`cva`) and merged by `cn()` (clsx + tailwind-merge). See
  `apps/v4/registry/new-york-v4/ui/button.tsx` in the repo. The `style` field of
  `components.json` "cannot be changed after initialization"
  ([components.json](https://ui.shadcn.com/docs/components-json)). There are eight style
  packs: Vega, Nova, Maia, Lyra, Mira, Luma, Sera, Rhea (`apps/v4/registry/styles/`).
- **Tokens** are CSS variables (`--background`/`--foreground`, `--card`, `--popover`,
  `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`,
  `--ring`, `--chart-1..5`, `--sidebar-*`), each surface paired with a `-foreground`. Values
  are in `oklch()`. `--radius` is `0.625rem` (10px), with derived `sm` 0.6×, `md` 0.8×,
  `lg` 1×, `xl` 1.4× and up. Dark mode redefines the same tokens under `.dark`
  ([theming](https://ui.shadcn.com/docs/theming)). The palette has **no success or warning
  tone**. `destructive` is the only semantic colour.
- Licence: MIT, "Copyright (c) 2023 shadcn" (`LICENSE.md` in shadcn-ui/ui). Copied
  component code carries that notice.

## 2. The current webview, measured

| Fact | Value | Source |
|---|---|---|
| TS + CSS under `src/` | 17,519 lines | `wc -l` |
| Views | 4 top-level (`src/views/`: editor 2,951 lines, pack-manager 184 + `src/pack-manager/view/` ~2.3k, settings 306, first-run 100) | tree |
| CSS | 2,759 lines in 5 files (`styles.css` 449, `pack-manager.css` 1,285, `editor.css` 908, `dialog.css` 45, `combobox.css` 72); ~245 `var(--…)` uses | `wc`, `grep` |
| DOM construction | No framework (`src/ui.ts`: "The UI uses no framework; the one exception is the Editor's canvas, which uses Konva"). One `el(tag, attrs, …children)` helper, **375 `el(` calls**, 110 `addEventListener`, 42 `clear`/`replaceChildren` re-renders, 0 `innerHTML` | `grep` |
| Shared widgets | `openDialog`/`confirmChoice` on native `<dialog>` (`src/dialog.ts`), a `Combobox<T>` class (`src/combobox.ts`, used by font picker and pack dialogs), inline 24×24 outline SVG icons (`src/icons.ts`) | files |
| Theme | Token sets on `:root` and `:root[data-theme="dark"]`, set by `src/theme.ts` (also themes the native title bar) | files |
| Radii in use | 8px ×20, 6px ×12, 12px ×6, 10px ×3, others | `grep border-radius` |
| Konva | One `Konva.Stage` on a container `<div>` (`src/editor/view/stage.ts:350`). Konva owns everything inside it | file |
| Production bundle today | JS 404 kB / **127 kB gzip**, CSS 31 kB / **6.7 kB gzip** (`vite build`) | measured |

Konva alone is ~200 kB / 60 kB gzip of that JS (measured below). The rest of the UI is
~200 kB / ~67 kB gzip of hand-written TS.

## 3. Bundle and licence deltas (measured)

`bun build --minify --target=browser`, production `NODE_ENV`, gzip -9. Each entry is the
smallest realistic mount, built in a throwaway scratch project on the versions shown.

| Payload | min | gzip |
|---|---|---|
| react 19.3 + react-dom client (render one button) | 212 kB | 65 kB |
| …+ `@base-ui/react` 1.9 Dialog, Select, Tooltip, Tabs, Slider, Popover + clsx/tailwind-merge/cva | 394 kB | 125 kB |
| vue 3.5 runtime (one component) | 68 kB | 26 kB |
| svelte 5.59 runtime (one compiled component) | 57 kB | 21 kB |
| konva 10.11 (for scale) | 200 kB | 60 kB |
| Basecoat 1.3 prebuilt CSS, all components (`basecoat.cdn.min.css`) | 295 kB | 30 kB |
| Basecoat 1.3 all JS (`all.min.js`) | 56 kB | 14 kB |

The app loads from local disk inside Tauri, so these numbers affect parse time and installer
size, not download time. Option (a) roughly doubles the shipped JS (127 → ~250 kB gzip).
Tailwind's own output covers only the classes used, so its CSS cost depends on usage.

Licences: React, react-dom, Base UI, Radix, Tailwind CSS, tailwind-merge, clsx, Vue, Svelte,
bits-ui, Basecoat are MIT. Lucide (shadcn's default icons) is ISC. **class-variance-authority
is Apache-2.0**, which carries a NOTICE-file obligation if it ships a NOTICE. Every one of
these goes through `scripts/licenses.mjs` into `src-tauri/licenses/THIRD-PARTY-NOTICES.txt`
(SPM-29), which already reads npm texts from `node_modules`. None is copyleft, so the
licence impact is notices only.

## 4. The three options

### (a) React + Tailwind v4 with real shadcn components

**Build.** Add `react`, `react-dom`, `@vitejs/plugin-react`, `tailwindcss` +
`@tailwindcss/vite` (v4, ≥4.3 in the current registry), `@types/node`, plus the chosen base
(`@base-ui/react` by default), `class-variance-authority`, `clsx`, `tailwind-merge`,
`lucide-react` and `tw-animate-css`. The last one replaced `tailwindcss-animate`
([Tailwind v4 page](https://ui.shadcn.com/docs/tailwind-v4)). `tsconfig.json` gains `jsx`
and the `@/*` alias. `vite.config.ts` gains two plugins and `resolve.alias`
([Vite install](https://ui.shadcn.com/docs/installation/vite)). Tailwind v4 needs Chrome 111
/ Safari 16.4 / Firefox 128 ([compatibility](https://tailwindcss.com/docs/compatibility)).
WebView2 is evergreen Chromium, so that is fine for v1. A later macOS or Linux build
(ADR-0001) would need a WebKit at or above Safari 16.4.

**Theme glue.** shadcn darkens under `.dark`, but the app uses `data-theme="dark"`. Tailwind
supports that with
`@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));`
([dark mode](https://tailwindcss.com/docs/dark-mode)). The `@custom-variant dark` line that
`shadcn init` writes must be edited, and `theme.ts` stays as is.

**Preflight collision.** `@import "tailwindcss"` brings Preflight. Preflight zeroes all
margins and padding, sets `border: 0 solid`, unstyles headings and lists, and makes
`img`/`svg`/`canvas` `display:block` ([preflight](https://tailwindcss.com/docs/preflight)).
The existing 2.7k lines of CSS assume browser defaults in places. For example, the `h1`
rule in `styles.css` sets size and margin but relies on the browser's default bold, which
Preflight resets to `inherit`. During a mixed migration, either import only
`tailwindcss/theme.css` + `utilities.css` and leave Preflight out (the documented opt-out),
or re-audit every unconverted view. Tailwind also advises against per-component CSS files
next to it, because each file is processed separately
([compatibility](https://tailwindcss.com/docs/compatibility)). The three big `.css` files
would either become utilities or stay as plain CSS that reads the variables.

**Konva coexistence.** React renders the Editor shell. The stage container is a `<div>` with
a `ref`, which the existing `EditorStage` class receives once in an effect and destroys on
unmount. React must never reconcile inside it, so it stays childless in JSX. ADR-0005
already isolates Konva to `src/editor/view/` ("Swapping Konva later only means rewriting the
view layer"), and the model never imports Konva, so nothing in the model changes. Preflight's
`canvas {display:block}` is harmless to Konva's canvases. The temporary text `<textarea>`
overlay and the loupe are DOM elements Konva-side code creates. They stay imperative. The
risk is subtle: Editor toolbar state now lives in an imperative session object
(`src/editor/model/session.ts`), and wiring that into React means a subscription
(`useSyncExternalStore`) per view. That is the bulk of the Editor work.

**Migration path.** Incremental is possible. `createRoot` can mount React "islands" into
containers that the existing `el()` views own, so Settings → First-run → Pack Manager →
Editor could convert one view per stage. The shell (`src/shell.ts`) and `openDialog` callers
cross the boundary until the last view converts. A big bang is not required, but the mixed
period carries two DOM models and the Preflight question.

**Behaviour deltas.** Base UI's Tooltip, Dialog, Select and Combobox replace native `title`
tooltips (~147 `.title =`/`title:` sites), `src/dialog.ts` and `src/combobox.ts`. Each replacement must
keep SPEC §2's contracts: "Name (Shortcut) — description" tooltips with the blocker reason
when disabled, safe-choice-default confirmations, Esc picks the safe option. These are
re-implementations to review, not drop-ins.

**Size (focused agent sessions, build + review-cycle, excluding owner test time).** Setup,
tokens and theme glue: 1. Shared primitives (Button, Dialog/confirm, Combobox, Tooltip
contract, Tabs, Slider, Input): 2. Settings + First-run: 1. Pack Manager (~2.3k TS, 1.3k CSS,
drag-reorder code in `reorder-drag.ts` / `pack-list-drag.ts`): 3–4. Editor (2,951-line view
plus ~2.7k of `src/editor/view/`, 908 CSS, the session subscription): 5–7. Licences and
cleanup: ≤1. **≈13–16 sessions**, plus a Windows check per converted view.

### (b) A community port

| Port | Framework / base | State (2026-11-27) | Notes |
|---|---|---|---|
| [shadcn-svelte](https://github.com/huntabyte/shadcn-svelte) | Svelte 5 + bits-ui 2.x, Tailwind ^4.3 | MIT, 9.3k★, pushed 2026-11-25 | README: "an unofficial community-led Svelte port … not affiliated with shadcn, but we did get his blessing". Install: `sv add tailwindcss`, `$lib` alias, `npx shadcn-svelte@latest init` ([docs](https://www.shadcn-svelte.com/docs/installation/vite)) |
| [shadcn-vue](https://github.com/unovue/shadcn-vue) | Vue 3 + Reka UI, Tailwind v4 | MIT, 10.9k★, pushed 2026-11-25 | Install mirrors React: `@vitejs/plugin-vue`, `@tailwindcss/vite`, `@` alias, `pnpm dlx shadcn-vue@latest init` ([docs](https://www.shadcn-vue.com/docs/installation/vite)) |
| [Basecoat](https://github.com/hunvreus/basecoat) | **No framework**: semantic HTML + classes (`.btn`, `data-size`/`data-variant`), small vanilla JS, Tailwind v4.3 source *or* prebuilt CSS | MIT, 4.5k★, v1.3.0 2026-11-23, ~46k npm downloads/week | "a Tailwind CSS, vanilla HTML/CSS/JavaScript implementation of the shadcn/ui design system … without React, Radix, or framework runtime dependencies". Ships all eight shadcn style packs and "Compatible with shadcn/ui themes". Its JS auto-inits through a document-wide `MutationObserver` (`dist/js/basecoat.js`), so `el()`-built DOM gets picked up |
| `@billy_mcdowell/shadcn-web-components` (Lit) | Lit custom elements | MIT, v0.2.1, last publish 2026-06-24, **27 downloads/week** | Pre-1.0 and dormant. Too thin to depend on |

**Svelte / Vue ports.** The cost is the same shape as (a): a framework, a Vite plugin
(`@sveltejs/vite-plugin-svelte` / `@vitejs/plugin-vue`), Tailwind v4 + Preflight, the same
Konva-in-a-ref pattern (Svelte `bind:this` + `onMount`/`onDestroy`, Vue template `ref`), the
same per-view islands (`mount()` / `createApp().mount()` into a container), the same
re-implementation of the §2 contracts. Runtimes are smaller (21 / 26 kB gzip against React's
65). The ports trail upstream, the owner is "unofficial" and docs are thinner. The app's
code style is plain TS, which Svelte's `.svelte` and Vue's SFC files both change. Size
≈ (a), **≈13–16 sessions**, perhaps +1 for agents being less fluent in Svelte 5 runes or
Reka than in React.

**Basecoat** is the one port that fits the existing architecture. Views keep `el()` and
swap class names (`el("button", {class: "btn", "data-variant": "outline"})`), so there is
no framework, no state rewiring, and Konva is untouched. The costs:

- It needs Tailwind v4 in the build, either `@import "tailwindcss"; @import "basecoat-css";`
  through `@tailwindcss/vite`, or the prebuilt CDN CSS (30 kB gzip for everything) copied in
  without a Tailwind build.
- The Preflight and dark-variant issues of (a) apply. Basecoat's base uses
  `@custom-variant dark (&:is(html.dark *))` and a `.dark` token block
  (`dist/base/base.css`), so it needs `theme.ts` to also toggle a `dark` class on `<html>`,
  or a local override.
- Its JS widgets duplicate what `dialog.ts`/`combobox.ts` already do. Using only its CSS
  sidesteps that.
- Its global `MutationObserver` also watches the Konva subtree. That is cheap at Konva's DOM
  churn but not free during brush strokes, so measure it or scope it.

Size: setup and token mapping 1, then a class-swap pass per view (Settings/First-run 1, Pack
Manager 2, Editor 2–3), deleting the CSS it replaces as it goes. **≈6–8 sessions.**

### (c) shadcn's look in the existing plain CSS, no framework

**Build.** No change: no dependency, no Vite plugin, no Preflight. The bundle is unchanged
or smaller as rules are consolidated.

**What "the look" is, concretely** (all from the sources above):

- The semantic token pairs (`--primary`/`--primary-foreground` and so on).
- A 10px `--radius` with 0.6/0.8/1.0/1.4× steps (6/8/10/14px). The app already uses 6, 8,
  10 and 12, so this is mostly renaming to scale tokens.
- shadcn's control sizing: buttons `h-9 px-4` (36px, 16px padding), `sm` 32px, `lg` 40px,
  `icon` 36px square, 14px medium text, 16px icons with 8px gap.
- A 3px `ring/50` focus ring.
- `shadow-xs` on outline buttons.
- Faded disabled at 50% opacity.
- Variants: default / destructive / outline / secondary / ghost / link (all from
  `new-york-v4/ui/button.tsx`).

Reproducing them means mapping `--bg`/`--panel`/`--border`/`--text`/`--muted`/`--accent`
onto shadcn-named tokens (or aliasing them), adding radius and size scale tokens, and
re-expressing `button`, inputs, the dialog, tabs and the combobox popover with the variant
names. All of this goes into `styles.css`, `dialog.css` and `combobox.css` first, then the
per-view CSS.

**Konva.** Untouched.

**Migration.** Fully incremental. Shared tokens and base controls first (one edit restyles
every view), then a per-view pass.

**Licence.** Copying values and CSS shapes from MIT code: add shadcn's MIT notice to the
third-party notices to be safe. No runtime dependency.

**Size.** Tokens + base controls: 1–2. Pack Manager CSS pass: 1. Editor CSS pass: 1.
Dialog / combobox / tabs polish: ≤1. **≈3–5 sessions.**

## 5. A contrast caveat that applies to every option

Taken verbatim, shadcn's default **neutral** light tokens fall below rules this repo already
measures and documents in `src/styles.css` (3:1 for UI boundaries, SPM-15; text ≥4.5:1).
Computed from the published oklch values with the OKLab→sRGB matrices, against
`--background` white:

| Token on white | Contrast | Repo rule |
|---|---|---|
| `--border` / `--input` oklch(0.922 0 0) | **1.26:1** | ≥3:1 boundary: fails (the repo raised `--danger-border` from 1.95:1 for this reason) |
| `--ring` oklch(0.708 0 0) | **2.59:1** | ≥3:1: fails |
| `--muted-foreground` oklch(0.556 0 0) | 4.73:1 (4.34:1 on `--muted`) | 4.5:1 text: borderline, fails on `--muted` |
| `--destructive` oklch(0.577 0.245 27.3) | 4.91:1 | passes |

AGENTS.md's UI-audience rule says visual contrast "counts and is measured". So any route
that brings in shadcn's palette needs its own values for border, input and ring at least.
shadcn supports that: it is just editing the variables. In practice the app keeps its
own colour values and adopts shadcn's **structure**: token names, radius scale, sizes,
variants. shadcn's palette also lacks success, warning, live and reorder tones, which the app
already has (`--success-*`, `--warn-*`, `--live-bg`, `--reorder-*`), so those stay app-local
whichever option is chosen.

## 6. Overlaps with SPEC §9's v2 parking lot

- **Unified tone styles** (`docs/SPEC.md` §9). Every tinted control moves onto shared tone
  classes, starting from `.tone-success`/`.tone-danger`, so "one edit propagates app-wide".
  This is the same job as shadcn's variant set. Under (c) and Basecoat the tone-class pass
  *is* the variant pass: `.tone-danger` ≈ `destructive`, plus app-only `success`/`warn`.
  Doing both separately would restyle the same selectors twice. Under (a)/(b) the tone
  classes become `cva` variants in `button.tsx` and friends, and the existing CSS tone work
  is thrown away when each view converts.
- **Editor icon pass** (`docs/SPEC.md` §9). Undo/Redo/Save…/Close become icons. The ~21
  left-panel tools and four tab leaves go icon-only. New icons join `src/icons.ts` (24×24
  outline, `currentColor`). shadcn components assume **Lucide**. Lucide's grid is also
  24×24, 2px stroke, `currentColor`, so its paths are stylistically compatible with the
  inline set, and Lucide is a plausible ISC-licensed source of proposals under every option.
  But AGENTS.md's Icons rule (render at real toolbar size, pixel math, owner sees a sheet)
  applies to each icon whatever the framework. shadcn's `icon` button size (36px) and 16px
  glyphs would set the toolbar metrics the icon pass renders against, so the order matters:
  settle control sizing (any option) before rendering icon sheets, or the sheets get redone.
  Under (a) the icon pass would land on React components, and the 1.05em inline-SVG
  convention would need re-stating.

## 7. Side-by-side

| | (a) React + shadcn | (b1) Svelte / Vue port | (b2) Basecoat | (c) Plain-CSS look |
|---|---|---|---|---|
| New runtime deps | React, react-dom, Base UI/Radix, cva, clsx, tailwind-merge, lucide | Svelte/Vue, bits-ui/Reka, same helpers | basecoat-css (CSS ± small JS) | none |
| Build change | 2 Vite plugins, alias, Tailwind v4, JSX | 2 Vite plugins, alias, Tailwind v4, SFCs | Tailwind v4 plugin (or prebuilt CSS) | none |
| Preflight conflict | yes (opt-out available) | yes | yes | no |
| Dark-mode glue | edit `@custom-variant` for `data-theme` | same | add `.dark` class or override | none |
| Konva | ref'd container, no change inside | same | untouched | untouched |
| Rewrites §2 tooltip/dialog contracts | yes | yes | optional (CSS-only use avoids it) | no |
| Incremental per view | yes (islands, mixed period) | yes (islands) | yes | yes |
| JS gzip delta (measured) | +~125 kB (≈2×) | +~21–26 kB runtime + primitives | +0–14 kB | 0 |
| Licences added | MIT + Apache-2.0 (cva) + ISC | MIT | MIT | MIT notice (copied values) |
| Fidelity to shadcn | exact (it *is* shadcn) | near-exact (port lag) | high (same style packs) | as close as hand-copied |
| Rough size | ≈13–16 sessions | ≈13–17 | ≈6–8 | ≈3–5 |

## 8. Read: the cheapest path to the shadcn look

Option (c), combined with the "Unified tone styles" pass. In order:

1. Alias the app's tokens to shadcn's semantic names, keeping the app's own measured colour
   values (§5) and adding the radius and size scales.
2. Restyle the base `button`/`input`/`dialog`/`combobox`/tabs in `styles.css` with shadcn's
   variant vocabulary, folded together with the tone classes.
3. Do a per-view CSS pass.

That is ≈3–5 sessions, with no framework, build or Konva risk, and it sets the control
metrics the Editor icon pass then renders against. Basecoat is the fallback if hand-copying
drifts from upstream: it keeps `el()` and Konva untouched but brings Tailwind and Preflight.
(a)/(b1) only pay off if a framework is wanted for its own sake (state management, a
component model). Choose them as a framework decision with its own ADR, not as a styling
choice.
