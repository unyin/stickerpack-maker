// The options bar of the effect tools (SPEC §6, SPM-8): Outline and Glow
// show their settings with Apply and Cancel; Warp shows its brush. Settings
// are not undo steps (CMT-183) and stay as set for the next time the tool
// is used. Only the bar's DOM lives here; the Editor decides what the
// settings do.
import {
  GLOW_DEFAULTS,
  GLOW_OPACITY,
  GLOW_RADIUS,
  GLOW_SOFTNESS,
  glowEffect,
  OUTLINE_DEFAULTS,
  OUTLINE_WIDTH,
  outlineEffect,
  type Effect,
  type EffectKind,
  type GlowSettings,
  type OutlineSettings,
  type Range,
  effectKindOf,
} from "../model/effects";
import { WARP_DEFAULTS, WARP_RADIUS, WARP_STRENGTH, type WarpSettings } from "../model/warp";
import { isHexColor } from "../model/text";
import { el } from "../../ui";
import type { CanvasTool } from "./stage";

export interface EffectControlHandlers {
  /** A setting changed (live, while a slider moves). */
  change(): void;
  apply(): void;
  cancel(): void;
}

/** What the bar shows besides the settings. */
export interface EffectBarState {
  readonly tool: CanvasTool;
  readonly busy: boolean;
  /** The layer the tool works on, as the user knows it. */
  readonly targetName: string | null;
  /** Why the tool cannot work now (several layers selected, text for warp), or null. */
  readonly blocker: string | null;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class EffectControls {
  /** The bar, shown under the toolbar while an effect tool is active. */
  readonly element: HTMLElement;
  private readonly outline: Mutable<OutlineSettings> = { ...OUTLINE_DEFAULTS };
  private readonly glow: Mutable<GlowSettings> = { ...GLOW_DEFAULTS };
  private readonly brush: Mutable<WarpSettings> = { ...WARP_DEFAULTS };
  private readonly groups: Record<EffectKind | "warp", HTMLElement>;
  private readonly target = el("span", { class: "editor-effect-target muted" });
  private readonly applyButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly inputs: HTMLInputElement[] = [];
  /** Put each slider and its readout back in line with its setting. */
  private readonly syncs: (() => void)[] = [];

  constructor(private readonly handlers: EffectControlHandlers) {
    this.applyButton = el("button", { class: "primary", onclick: () => handlers.apply() }, "Apply") as HTMLButtonElement;
    this.cancelButton = el("button", { class: "secondary", onclick: () => handlers.cancel() }, "Cancel") as HTMLButtonElement;
    this.cancelButton.title = "Discard the preview and go back to the Move tool";
    this.groups = {
      outline: this.group(
        "Outline",
        this.color("Outline colour", () => this.outline.color, (c) => (this.outline.color = c)),
        this.slider("Width", OUTLINE_WIDTH, "px", () => this.outline.width, (v) => (this.outline.width = v)),
      ),
      glow: this.group(
        "Glow",
        this.color("Glow colour", () => this.glow.color, (c) => (this.glow.color = c)),
        this.slider("Radius", GLOW_RADIUS, "px", () => this.glow.radius, (v) => (this.glow.radius = v)),
        this.slider("Softness", GLOW_SOFTNESS, "%", () => this.glow.softness, (v) => (this.glow.softness = v)),
        this.slider("Opacity", GLOW_OPACITY, "%", () => this.glow.opacity, (v) => (this.glow.opacity = v)),
      ),
      warp: this.group(
        "Warp",
        this.slider("Strength", WARP_STRENGTH, "%", () => this.brush.strength, (v) => (this.brush.strength = v)),
        this.slider("Radius", WARP_RADIUS, "px", () => this.brush.radius, (v) => (this.brush.radius = v)),
        el("span", { class: "muted" }, "Click to bulge; drag to size it (Shift: strength, up = more). Choose the layer in Layers."),
      ),
    };
    this.element = el(
      "div",
      { class: "editor-effect-bar", role: "group", "aria-label": "Effect settings" },
      ...Object.values(this.groups),
      this.target,
      this.applyButton,
      this.cancelButton,
    );
    this.element.hidden = true;
  }

  /** The current settings of an outline or glow, as Rust takes them. */
  effect(kind: EffectKind): Effect {
    return kind === "outline" ? outlineEffect(this.outline) : glowEffect(this.glow);
  }

  /** The warp brush's current settings. */
  get warp(): WarpSettings {
    return { ...this.brush };
  }

  /** Take the warp settings a drag ended with (sliders and readouts follow). */
  setWarp(settings: WarpSettings): void {
    Object.assign(this.brush, settings);
    for (const sync of this.syncs) sync();
  }

  update(state: EffectBarState): void {
    const { tool, busy, blocker } = state;
    const kind = tool === "warp" ? tool : effectKindOf(tool);
    this.element.hidden = kind === null;
    if (!kind) return;
    for (const [name, group] of Object.entries(this.groups)) group.hidden = name !== kind;
    const applies = kind !== "warp";
    this.applyButton.hidden = !applies;
    this.cancelButton.hidden = !applies;
    this.applyButton.disabled = busy || blocker !== null;
    this.applyButton.title = blocker ?? `Bake the ${kind} into the layer's pixels (one undo step)`;
    this.cancelButton.disabled = busy;
    for (const input of this.inputs) input.disabled = busy;
    this.target.textContent = blocker ?? (state.targetName ? `On: ${state.targetName}` : "");
    this.target.classList.toggle("is-blocked", blocker !== null);
  }

  /**
   * Hide the bar although an effect tool is (nominally) still the tool: the
   * bar is a sibling of the toolbar, so with no session nothing else hides
   * it. Its DOM is this class's own (SPM-8: closing a session).
   */
  hide(): void {
    this.element.hidden = true;
  }

  private group(label: string, ...controls: HTMLElement[]): HTMLElement {
    return el("span", { class: "editor-effect-group" }, el("strong", {}, label), ...controls);
  }

  /** A colour picker; the preview follows while the picker is open. */
  private color(label: string, get: () => string, set: (c: string) => void): HTMLElement {
    const input = el("input", { class: "editor-color-input", type: "color", "aria-label": label, title: label }) as HTMLInputElement;
    input.value = get();
    input.addEventListener("input", () => {
      if (!isHexColor(input.value)) return;
      set(input.value.toLowerCase());
      this.handlers.change();
    });
    // Give up focus once chosen, so the Editor's shortcuts work at once (as the text controls do).
    input.addEventListener("change", () => input.blur());
    this.inputs.push(input);
    return input;
  }

  /** A whole-number slider with its value shown beside it. */
  private slider(label: string, range: Range, unit: string, get: () => number, set: (v: number) => void): HTMLElement {
    const input = el("input", {
      type: "range",
      min: String(range.min),
      max: String(range.max),
      step: "1",
      "aria-label": label,
    }) as HTMLInputElement;
    const shown = el("span", { class: "editor-effect-value" });
    const sync = (): void => {
      input.value = String(get());
      shown.textContent = `${get()} ${unit}`;
    };
    sync();
    this.syncs.push(sync);
    input.addEventListener("input", () => {
      const value = Number(input.value);
      set(value);
      shown.textContent = `${value} ${unit}`;
      this.handlers.change();
    });
    input.addEventListener("change", () => input.blur());
    this.inputs.push(input);
    return el("label", { class: "editor-side" }, `${label} `, input, shown);
  }
}
