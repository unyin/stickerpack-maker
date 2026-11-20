// The text-editing overlay (ADR-0005: Konva's documented pattern): a
// <textarea> laid over the canvas where the text layer is, styled with the
// layer's font, size and colour. Focus stays in the textarea while typing,
// so the Editor's shortcuts (Delete, undo/redo, Esc) act on the text, never
// on the layers: the Editor's keydown handler skips TEXTAREA targets, and
// the textarea's own Ctrl+Z is the browser's text undo.
//
// Enter commits, Shift+Enter starts a new line, Esc cancels; clicking
// elsewhere (blur) commits. The text is rendered in Rust once committed.
import type { OverlayPlacement } from "./geometry";

export interface TextEditRequest {
  readonly text: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly color: string;
  /** Line spacing in px at scale 1 (the Rust layout's), or null for CSS `normal`. */
  readonly lineHeight: number | null;
  readonly placement: OverlayPlacement;
}

export interface TextEditHandlers {
  /** The edited text (may be blank: the caller decides what that means). */
  commit(text: string): void;
  cancel(): void;
}

export class TextEditOverlay {
  private textarea: HTMLTextAreaElement | null = null;
  /** Marks the open overlay as decided, so removing it (blur) does not commit. */
  private settle: (() => void) | null = null;

  constructor(private readonly host: HTMLElement) {}

  get isOpen(): boolean {
    return this.textarea !== null;
  }

  /** Open the overlay (closing any open one without a decision) and focus it. */
  open(request: TextEditRequest, handlers: TextEditHandlers): void {
    this.close();
    const area = document.createElement("textarea");
    area.className = "editor-text-edit";
    area.value = request.text;
    area.spellcheck = false;
    area.setAttribute("aria-label", "Text");
    area.wrap = "off";
    const p = request.placement;
    const centre = p.centred ? " translate(-50%, -50%)" : "";
    Object.assign(area.style, {
      left: `${p.left}px`,
      top: `${p.top}px`,
      transform: `rotate(${p.rotation}deg) scale(${p.scale})${centre}`,
      fontFamily: `"${request.fontFamily.replace(/"/g, '\\"')}"`,
      fontSize: `${request.fontSize}px`,
      lineHeight: request.lineHeight === null ? "normal" : `${request.lineHeight}px`,
      color: request.color,
    });
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const text = area.value;
      if (this.textarea === area) this.close();
      if (commit) handlers.commit(text);
      else handlers.cancel();
    };
    this.settle = () => (done = true);
    area.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        finish(true);
      }
    });
    area.addEventListener("blur", () => finish(true));
    area.addEventListener("input", () => this.fit(area));
    this.host.appendChild(area);
    this.textarea = area;
    this.fit(area);
    area.focus();
    area.select();
  }

  /** Remove the overlay without committing or cancelling. */
  close(): void {
    const area = this.textarea;
    this.settle?.();
    this.settle = null;
    this.textarea = null;
    area?.remove();
  }

  /** Grow the textarea to its content (in unscaled px; the CSS transform scales it). */
  private fit(area: HTMLTextAreaElement): void {
    area.style.width = "0px";
    area.style.height = "0px";
    const em = parseFloat(area.style.fontSize) || 16;
    area.style.width = `${area.scrollWidth + em / 2}px`;
    area.style.height = `${area.scrollHeight}px`;
  }
}
