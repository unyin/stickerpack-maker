// The live outline/glow preview (SPM-8, ADR-0008): Rust draws it with the
// same code as Apply, so the preview IS the result Apply bakes in. While a
// slider is dragged the settings change faster than Rust can answer, so
// renders run one at a time and only the latest settings are drawn next
// (the ones in between are skipped). No Konva, no DOM: the view shows what
// `show` hands it.
import type { Doc } from "../model/document";
import type { Effect } from "../model/effects";

/** What to preview: an effect on one layer of one document state. */
export interface PreviewRequest {
  readonly doc: Doc;
  readonly layerId: string;
  readonly effect: Effect;
}

function sameEffect(a: Effect, b: Effect): boolean {
  const keys = Object.keys(a) as (keyof Effect)[];
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

function sameRequest(a: PreviewRequest, b: PreviewRequest): boolean {
  return a.doc === b.doc && a.layerId === b.layerId && sameEffect(a.effect, b.effect);
}

/**
 * Keeps the preview in line with what is wanted (CMT-183, CMT-185, CMT-186):
 * - a change of settings keeps showing the last preview until the new one
 *   is drawn, so dragging a slider never flickers;
 * - a change of layer or document (another layer selected, undo/redo, any
 *   edit) or no request at all (tool switched, Editor closed) discards it at
 *   once; a render that finishes for a discarded request is never shown.
 * The preview lives only here and in the view: never in the document.
 */
export class EffectPreview<R> {
  private wanted: PreviewRequest | null = null;
  private shown: PreviewRequest | null = null;
  /** The last finished render. */
  private done: { readonly req: PreviewRequest; readonly result: R } | null = null;
  private running: { readonly req: PreviewRequest; readonly promise: Promise<R> } | null = null;
  /** A request whose render failed: not retried until the request changes. */
  private failed: PreviewRequest | null = null;

  constructor(
    private readonly compute: (req: PreviewRequest) => Promise<R>,
    /** Show a preview, or (null) show the layer as it is. */
    private readonly show: (req: PreviewRequest | null, result: R | null) => void,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  /** Ask for the preview of `req`, or for none. Asking for what is already wanted changes nothing. */
  request(req: PreviewRequest | null): void {
    const previous = this.wanted;
    if (req === null ? previous === null : previous !== null && sameRequest(req, previous)) return;
    this.wanted = req;
    const shown = this.shown;
    if (shown && (!req || req.doc !== shown.doc || req.layerId !== shown.layerId)) this.hide();
    this.pump();
  }

  /**
   * The result for `req` (Apply): the finished render when it is the one
   * shown, the one being drawn when it matches, else a new render after
   * the current one. Rejects when Rust refuses it.
   */
  async result(req: PreviewRequest): Promise<R> {
    for (;;) {
      if (this.done && sameRequest(this.done.req, req)) return this.done.result;
      const running = this.running;
      if (!running) return this.start(req);
      if (sameRequest(running.req, req)) return running.promise;
      await running.promise.then(
        () => undefined,
        () => undefined,
      );
    }
  }

  private hide(): void {
    this.shown = null;
    this.show(null, null);
  }

  /** Start drawing what is wanted, unless a render is running or it is drawn (or failed) already. */
  private pump(): void {
    const want = this.wanted;
    if (!want || this.running) return;
    const done = this.done;
    if (done && sameRequest(done.req, want)) {
      if (this.shown !== done.req) {
        this.shown = done.req;
        this.show(done.req, done.result);
      }
      return;
    }
    if (this.failed && sameRequest(this.failed, want)) return;
    void this.start(want).catch(() => undefined); // reported through onError
  }

  private start(req: PreviewRequest): Promise<R> {
    const promise = this.compute(req);
    this.running = { req, promise };
    const settle = (): void => {
      if (this.running?.promise === promise) this.running = null;
      this.pump();
    };
    promise.then(
      (result) => {
        this.done = { req, result };
        if (this.failed && sameRequest(this.failed, req)) this.failed = null;
        settle();
      },
      (err: unknown) => {
        if (this.wanted && sameRequest(this.wanted, req)) {
          this.failed = req;
          this.hide();
          this.onError(err);
        }
        settle();
      },
    );
    return promise;
  }
}
