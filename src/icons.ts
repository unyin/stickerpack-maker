// Inline SVG icons for buttons (24×24 outline style, drawn in currentColor so
// they follow the button's text colour in both themes). Decorative: the
// button's label or aria-label carries the meaning.

const SVG_NS = "http://www.w3.org/2000/svg";

const PATHS = {
  /** Opens in another program: a box with an arrow leaving it. */
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
  /** Refresh: a circular arrow. */
  refresh: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 4v7h-7"],
  /** Copy to clipboard: two overlapping sheets. */
  copy: ["M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"],
  /** Done: a check mark. */
  check: ["M5 12l5 5L20 7"],
  /** Close: an X. */
  close: ["M6 6l12 12", "M18 6L6 18"],
  /** Eyedropper: a pipette - pointed nib, crossbar, fat bulb (owner, CMT-296). */
  eyedropper: ["M2 22l1-4L16 5l3 3L6 21l-4 1z", "M13 7l3 3", "M16.5 4.5l2-2a3.2 3.2 0 0 1 4.5 4.5l-2 2z"],
} as const;

/** "Open in explorer" with the opens-another-program icon at the end (owner, 2026-11-21); used by every Open in explorer button. */
export function explorerLabel(): Array<Node | string> {
  return ["Open in explorer", icon("external")];
}

export type IconName = keyof typeof PATHS;

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `icon icon-${name}`);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of PATHS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
