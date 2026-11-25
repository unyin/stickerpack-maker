// The effect tools' settings (SPEC §6, SPM-8; the panel since SPM-15 D2):
// Outline and Glow show their settings with Apply and Cancel; Warp shows its
// brush. The blocks are mounted in the left tools panel under their tool's
// category — Outline and Glow under Effects, Warp under Paint — so the old
// horizontal bar, whose appearing and disappearing shifted the canvas, is
// gone. Settings are not undo steps (CMT-183) and stay as set for the next
// time the tool is used. Only the DOM lives here; the Editor decides what
// the settings do.
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
  typedSliderValue,
} from "../model/effects";
import { WARP_DEFAULTS, WARP_RADIUS, WARP_STRENGTH, type WarpSettings } from "../model/warp";
import { isHexColor } from "../model/text";
import type { CanvasTool } from "../model/tools";
import { eyedropperButton } from "./eyedropper";
import { el } from "../../ui";

export interface EffectControlHandlers {
  /** A setting changed (live, while a slider moves). */
  change(): void;
  /**
   * Start a canvas colour pick (CMT-296); the completed sample lands in
   * `apply`, which fires `change` as typing the colour would.
   */
  pick(apply: (hex: string) => void): void;
  apply(): void;
  cancel(): void;
}

/** What the blocks show besides the settings. */
export interface EffectControlsState {
  readonly tool: CanvasTool;
  readonly busy: boolean;
  /** The layer the tool works on, as the user knows it. */
  readonly targetName: string | null;
  /** Why the tool cannot work now (several layers selected, text for warp), or null. */
  readonly blocker: string | null;
  /** True when the target is a text layer: Outline restyles it in place, Glow converts it (SPM-18). */
  readonly textTarget: boolean;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class EffectControls {
  /** Outline's settings block (mounted under the Effects category). */
  readonly outlineBlock: HTMLElement;
  /** Glow's settings block (mounted under the Effects category). */
  readonly glowBlock: HTMLElement;
  /** Warp's brush block (mounted under the Paint category). */
  readonly warpBlock: HTMLElement;
  /** Apply and Cancel, centred in the panel (Outline and Glow only). */
  readonly actions: HTMLElement;
  private readonly outline: Mutable<OutlineSettings> = { ...OUTLINE_DEFAULTS };
  private readonly glow: Mutable<GlowSettings> = { ...GLOW_DEFAULTS };
  private readonly brush: Mutable<WarpSettings> = { ...WARP_DEFAULTS };
  private readonly blocks: Record<EffectKind | "warp", HTMLElement>;
  private readonly target = el("span", { class: "editor-effect-target muted" });
  private readonly applyButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  /** The blocks' inputs, disabled together while a render runs (busy). */
  private readonly inputs: (HTMLInputElement | HTMLButtonElement)[] = [];
  /** Put each slider and its readout back in line with its setting. */
  private readonly syncs: (() => void)[] = [];

  constructor(private readonly handlers: EffectControlHandlers) {
    this.applyButton = el("button", { class: "primary", onclick: () => handlers.apply() }, "Apply") as HTMLButtonElement;
    this.cancelButton = el("button", { class: "secondary", onclick: () => handlers.cancel() }, "Cancel") as HTMLButtonElement;
    this.cancelButton.title = "Discard the preview and go back to the Move tool";
    this.outlineBlock = this.block(
      "Outline settings",
      this.color("Outline colour", () => this.outline.color, (c) => (this.outline.color = c)),
      this.slider("Width", OUTLINE_WIDTH, "px", () => this.outline.width, (v) => (this.outline.width = v)),
    );
    this.glowBlock = this.block(
      "Glow settings",
      this.color("Glow colour", () => this.glow.color, (c) => (this.glow.color = c)),
      this.slider("Radius", GLOW_RADIUS, "px", () => this.glow.radius, (v) => (this.glow.radius = v)),
      this.slider("Softness", GLOW_SOFTNESS, "%", () => this.glow.softness, (v) => (this.glow.softness = v)),
      this.slider("Opacity", GLOW_OPACITY, "%", () => this.glow.opacity, (v) => (this.glow.opacity = v)),
    );
    this.warpBlock = this.block(
      "Warp settings",
      this.slider("Strength", WARP_STRENGTH, "%", () => this.brush.strength, (v) => (this.brush.strength = v)),
      this.slider("Radius", WARP_RADIUS, "px", () => this.brush.radius, (v) => (this.brush.radius = v)),
      el("span", { class: "muted" }, "Click to bulge; drag to size it (Shift: strength, up = more). Choose the layer in Layers."),
    );
    this.blocks = { outline: this.outlineBlock, glow: this.glowBlock, warp: this.warpBlock };
    this.target.hidden = true;
    this.actions = el(
      "div",
      { class: "editor-effect-actions", role: "group", "aria-label": "Apply the effect" },
      this.applyButton,
      this.cancelButton,
    );
    this.actions.hidden = true;
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

  update(state: EffectControlsState): void {
    const { tool, busy, blocker } = state;
    const kind = tool === "warp" ? tool : effectKindOf(tool);
    for (const [name, block] of Object.entries(this.blocks)) block.hidden = name !== kind;
    this.target.hidden = kind === null;
    if (!kind) {
      // No effect tool: the blocks stay ready (settings are kept), nothing shows.
      this.actions.hidden = true;
      return;
    }
    this.actions.hidden = kind === "warp"; // Warp has no Apply: a press commits it
    // The line naming the target (or its blocker) sits at the end of the
    // active tool's own block, so it stays beside that tool's settings — for
    // Outline and Glow directly above the Apply/Cancel pair.
    this.blocks[kind].append(this.target);
    this.applyButton.disabled = busy || blocker !== null;
    this.applyButton.title =
      blocker ??
      (state.textTarget && kind === "outline"
        ? "Set the outline style on the text layer (one undo step); it stays editable text"
        : `Bake the ${kind} into the layer's pixels (one undo step)`);
    this.cancelButton.disabled = busy;
    for (const input of this.inputs) input.disabled = busy;
    this.target.textContent = blocker ?? (state.targetName ? `On: ${state.targetName}` : "");
    this.target.classList.toggle("is-blocked", blocker !== null);
  }

  /**
   * Hide every block although an effect tool is (nominally) still the tool:
   * with no session the panel is hidden too, so closing a session leaves no
   * state on show if the panel ever returns before the next update.
   */
  hide(): void {
    for (const block of Object.values(this.blocks)) block.hidden = true;
    this.actions.hidden = true;
    this.target.hidden = true;
  }

  private block(title: string, ...controls: HTMLElement[]): HTMLElement {
    return el(
      "div",
      { class: "editor-effect-settings", role: "group", "aria-label": title, hidden: true },
      el("p", { class: "editor-tool-subtitle" }, title),
      ...controls,
    );
  }

  /**
   * A colour picker with its eyedropper beside it (owner decision
   * 2026-11-23); the preview follows while the picker is open.
   */
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
    // The eyedropper starts a canvas pick; the sample lands exactly as
    // typing the hex into the picker would (a settings change is not a
    // discard, CMT-256, so the tool and its preview stay, recoloured).
    const dropper = eyedropperButton(
      () =>
        this.handlers.pick((hex) => {
          set(hex);
          input.value = hex;
          this.handlers.change();
        }),
      this.inputs,
    );
    this.inputs.push(input); // busy disables the picker with the rest of the block
    return el("span", { class: "editor-effect-color" }, input, dropper);
  }

  /**
   * A whole-number slider with its value in an editable field beside it
   * (owner decision 2026-11-23): dragging, the mousewheel over it (hover
   * suffices, one step per wheel event, up increases) and typing all set
   * the same value. A typed number commits on Enter or blur, clamped into
   * the range; invalid or empty reverts; Esc reverts and blurs. After a
   * commit the field gives up focus, so the Editor's shortcuts work at
   * once (as the text controls do). The panel's width puts the name above
   * the slider row; the controls and their behaviour are the bar's own.
   */
  private slider(label: string, range: Range, unit: string, get: () => number, set: (v: number) => void): HTMLElement {
    const input = el("input", {
      type: "range",
      min: String(range.min),
      max: String(range.max),
      step: "1",
      "aria-label": label,
    }) as HTMLInputElement;
    const field = el("input", {
      class: "editor-effect-value editor-effect-entry",
      type: "text",
      inputmode: "numeric",
      "aria-label": `${label} value`,
    }) as HTMLInputElement;
    const sync = (): void => {
      const value = get();
      input.value = String(value);
      // Never clobber what is being typed (as the font size field does).
      if (document.activeElement !== field) field.value = String(value);
    };
    // Back to the setting's value, even while the field holds focus: the
    // blur that follows must find nothing left to commit.
    const revert = (): void => {
      field.value = String(get());
    };
    const commit = (): void => {
      const value = typedSliderValue(field.value, range);
      if (value === null || value === get()) {
        revert(); // invalid, empty or unchanged: back to the setting's value
        return;
      }
      set(value);
      input.value = String(value); // the slider follows its field
      field.value = String(value);
      this.handlers.change();
    };
    sync();
    this.syncs.push(sync);
    input.addEventListener("input", () => {
      const value = Number(input.value);
      set(value);
      field.value = String(value);
      this.handlers.change();
    });
    input.addEventListener("change", () => input.blur());
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
        field.blur(); // the field gives up focus, so shortcuts work at once
      } else if (e.key === "Escape") {
        e.preventDefault();
        revert(); // no commit: the blur below finds the setting's own value
        field.blur();
      }
    });
    field.addEventListener("change", () => commit());
    this.inputs.push(input, field);
    // The wheel rides on the whole row: a disabled slider (busy) shows the
    // same hover, but does nothing (SPEC section 2).
    const row = el("label", { class: "editor-slider" }, el("span", { class: "editor-slider-name" }, label), input, field, ` ${unit}`);
    row.addEventListener("wheel", (e) => {
      if (input.disabled) return;
      e.preventDefault(); // the value steps instead of anything scrolling
      const next = Math.max(range.min, Math.min(range.max, get() + (e.deltaY < 0 ? 1 : -1)));
      if (next === get()) return;
      set(next);
      sync();
      this.handlers.change();
    });
    return row;
  }
}
