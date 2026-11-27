# Triage: Look and feel

Type: grilling
Status: claimed
Blocked by: 05

## Question

Verdict (v2 / v3 / rejected) for the three overlapping look-and-feel items, decided together: unified tone styles; UI rework on shadcn/ui; the Editor icon pass (settled scope and Icons-rule process in its SPEC entry, CMT-404/407/414/415). If more than one survives, how they relate (e.g. does a shadcn rework subsume the tone styles?).

## Context note (2026-11-27, added for whoever picks this up)
The React prerequisite has since been measured: read ticket 05's
[Addendum](05-shadcn-fit.md) and
[react-adoption-analysis.md](../research/react-adoption-analysis.md) before giving costs
here. Headline: React adoption alone ~8-10 sessions (shadcn/Tailwind on top ~5-6, matching
05's 13-16 total); ~4,500 lines of model code and all 2,759 CSS lines survive it
untouched; Konva stays vanilla. The analysis also flags one decision this ticket should
make explicitly: **sequencing** - tickets 01/02's greenlit UX work builds on `el()` today
and would be re-ported after a conversion, so a React/shadcn verdict interacts with when
those land.
