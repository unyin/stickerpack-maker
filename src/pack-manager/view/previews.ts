// Image previews for the pack view: the file bytes come from Rust (raw IPC,
// no asset protocol or file-system permission) and become blob URLs, cached
// by sticker id. A sticker keeps its bytes through reorders (its file is only
// renamed), so the cache is cleared on open/refresh and per sticker on
// Replace.
import type { StickerFormat } from "../api";
import { stickerImage, thumbnailImage } from "../api";

const MIME: Record<StickerFormat, string> = { png: "image/png", webp: "image/webp" };

export class Previews {
  private stickers = new Map<number, Promise<string | null>>();
  private thumbnail: Promise<string | null> | null = null;

  /** A blob URL for the sticker's image, or null when it cannot be read. */
  sticker(id: number, format: StickerFormat): Promise<string | null> {
    let url = this.stickers.get(id);
    if (!url) {
      url = toUrl(stickerImage(id), MIME[format]);
      this.stickers.set(id, url);
    }
    return url;
  }

  thumbnailOf(packId: number, format: StickerFormat): Promise<string | null> {
    this.thumbnail ??= toUrl(thumbnailImage(packId), MIME[format]);
    return this.thumbnail;
  }

  forget(id: number): void {
    revoke(this.stickers.get(id));
    this.stickers.delete(id);
  }

  clear(): void {
    for (const url of this.stickers.values()) revoke(url);
    this.stickers.clear();
    revoke(this.thumbnail);
    this.thumbnail = null;
  }
}

async function toUrl(bytes: Promise<ArrayBuffer>, type: string): Promise<string | null> {
  try {
    return URL.createObjectURL(new Blob([await bytes], { type }));
  } catch {
    return null;
  }
}

function revoke(url: Promise<string | null> | null | undefined): void {
  void url?.then((u) => u && URL.revokeObjectURL(u));
}

/** An <img> that fills in once its preview resolves (empty when unreadable). */
export function previewImage(url: Promise<string | null>, alt: string, className: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = className;
  img.alt = alt;
  img.draggable = false;
  void url.then((u) => {
    if (u) img.src = u;
    else img.classList.add("unreadable");
  });
  return img;
}
