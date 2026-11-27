# Research: what adopting shadcn/ui would take

Type: research

## Question

What would adopting shadcn/ui (https://ui.shadcn.com/) take in this webview: plain TypeScript + Konva, no UI framework, Vite, ~17.5k lines TS/CSS, its own token-based CSS (src/styles.css, theme.ts) and inline icon set (src/icons.ts)? Compare the options: React + Tailwind with real shadcn components; a community port (shadcn-svelte, shadcn-vue, any vanilla/web-component port); adopting shadcn's look (tokens, Radix-style patterns) in plain CSS without a framework. For each: build changes, how it coexists with Konva-owned canvas DOM, migration path (incremental vs big bang), bundle and licence impact, and a rough size in sessions. Note overlaps with the unified tone styles and Editor icon pass entries.
