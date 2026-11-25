// The session's Emoji String (SPEC §6 Layout, Emoji tab; SPM-15): a fresh
// session's typed emoji is STAGED and assigned to the sticker the image
// becomes at save; a session that edits an origin sticker shows that
// sticker's own string and writes every commit THROUGH immediately — pack
// metadata, neither an undo step nor a dirtying change. Validation is the
// Pack Manager's own, warn-only (SPEC §3, §7): an empty or 21-emoji string
// still commits.
//
// Pure model: the box's UI (slice D3) reads `value`/`blocked`/`warning` and
// calls `load`/`commit`; the Rust calls arrive through an injected store, so
// the rules are testable without a webview.
import { emojiWarning } from "../../pack-manager/model/emoji";
import type { SaveTarget } from "../save";

/**
 * Which sticker slot the box belongs to: a fresh session's staged value, or
 * an origin sticker's own Emoji String. `otherLibrary` means the session's
 * origin belongs to the Library used before: its id must never be looked up
 * (mirroring the save dialog's gone-origin handling).
 */
export type EmojiTarget =
  | { readonly kind: "staged" }
  | {
      readonly kind: "origin";
      readonly stickerId: number;
      readonly packId: number;
      readonly otherLibrary?: boolean;
    };

/** Why the Emoji box can neither show nor write a value; null when it can. */
export interface EmojiBlock {
  readonly kind: "otherLibrary" | "gone";
  readonly message: string;
}

/** The Rust side of the box, injected: the pack view's sticker and `set_emoji_string`. */
export interface EmojiStore {
  /** The sticker's current Emoji String; rejects when it is gone. */
  read(packId: number, stickerId: number): Promise<string>;
  /** Write through; resolves the string the core stored (with whitespace stripped). */
  write(stickerId: number, emojiString: string): Promise<string>;
}

export const EMOJI_OTHER_LIBRARY: EmojiBlock = {
  kind: "otherLibrary",
  message: "This sticker belongs to the Library used before, so its Emoji String cannot be edited.",
};

export const EMOJI_GONE: EmojiBlock = {
  kind: "gone",
  message: "This sticker no longer exists (it was deleted or moved since it was opened), so its Emoji String cannot be edited.",
};

/** The Emoji String as the Library stores it: every space stripped (SPEC §5). */
export function stripEmojiSpaces(emojiString: string): string {
  return emojiString.replace(/\s+/g, "");
}

/**
 * The session's Emoji String. One instance lives per Editor session; the
 * editor retargets it after a save, because the session then edits the
 * saved sticker (SPEC §6 Save).
 */
export class SessionEmoji {
  private staged = "";
  private loaded: string | null = null;
  private block: EmojiBlock | null = null;
  private target: EmojiTarget;

  constructor(
    target: EmojiTarget,
    private readonly store: EmojiStore,
  ) {
    this.target = target;
  }

  /** The value the box shows: the staged text, or the origin sticker's last known string. */
  get value(): string {
    return this.target.kind === "staged" ? this.staged : (this.loaded ?? "");
  }

  /** Why the box is disabled, or null. */
  get blocked(): EmojiBlock | null {
    return this.block;
  }

  /** The warn-only count warning's wording for the current value, or null (SPEC §3). */
  get warning(): string | null {
    // A disabled box says why it is disabled instead; an origin not read yet has no value to judge.
    if (this.block || (this.target.kind === "origin" && this.loaded === null)) return null;
    return emojiWarning(this.value);
  }

  /**
   * Read an origin sticker's current string once. Never looks up an old
   * Library's sticker; a gone sticker leaves the box disabled with its
   * reason. A staged session has nothing to read.
   */
  async load(): Promise<void> {
    const target = this.target;
    if (target.kind === "staged" || this.loaded !== null) return;
    if (target.otherLibrary) {
      this.block = EMOJI_OTHER_LIBRARY;
      return;
    }
    try {
      this.loaded = await this.store.read(target.packId, target.stickerId);
      this.block = null;
    } catch {
      this.block = EMOJI_GONE;
    }
  }

  /**
   * Commit the typed string: staged immediately for a fresh session, or
   * written through for an origin sticker (Enter or blur, SPEC §6). Resolves
   * the value the box shows afterwards (the core's stored form for an
   * origin); rejects when the write fails, leaving the value as it was.
   */
  async commit(typed: string): Promise<string> {
    const target = this.target;
    if (this.block) return this.value;
    if (target.kind === "staged") {
      this.staged = typed;
      return this.staged;
    }
    const stored = await this.store.write(target.stickerId, typed);
    this.loaded = stored;
    return stored;
  }

  /**
   * The Emoji String a save writes: the box's value for a NEW sticker
   * (staged, or carried over from an origin), and none for a replace or a
   * thumbnail — replacing never touches the sticker's own Emoji String.
   */
  forSave(kind: SaveTarget["kind"]): string {
    return kind === "append" ? stripEmojiSpaces(this.value) : "";
  }

  /**
   * The Library changed since the session took its origin (forgetOrigin):
   * its id belongs to the old one, so the box must never look it up again.
   */
  forgetOrigin(): void {
    if (this.target.kind !== "origin") return;
    this.target = { ...this.target, otherLibrary: true };
    this.block = EMOJI_OTHER_LIBRARY;
  }

  /**
   * After a save the session edits the saved sticker (SPEC §6 Save), so the
   * box now shows that sticker's own string; a replaced sticker's string is
   * unchanged, and a new sticker's is the one the save wrote.
   */
  afterSave(saved: { readonly id: number; readonly packId: number; readonly emojiString: string }): void {
    this.target = { kind: "origin", stickerId: saved.id, packId: saved.packId };
    this.loaded = saved.emojiString;
    this.block = null;
  }
}
