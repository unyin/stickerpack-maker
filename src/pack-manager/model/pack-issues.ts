// The one issue rule for a pack (SPEC §5, SPM-25; owner decision 2026-11-25):
// plain facts in, the ORDERED list of issues out, most severe first. The Pack
// list's status badge and the Pack view's green Upload… button both read it
// (`readyToGoLive`), so they can never disagree. Pure, so it is testable
// without a webview. The Emoji String rule is the existing `emojiCountWarning`,
// not a second copy of it in Rust.
import type { PackStatus, PackView } from "../api";
import { EMOJI_MAX, EMOJI_MIN, emojiCountWarning } from "./emoji";
import { PACK_MAX_STICKERS } from "./messages";

/** What the rule needs to know about a pack. */
export interface PackFacts {
  status: PackStatus;
  stickerCount: number;
  /** How many stickers are Missing. */
  missingCount: number;
  /** The pack has a thumbnail and its file is Missing. */
  thumbnailMissing: boolean;
  /** Every sticker's Emoji String. */
  emojiStrings: readonly string[];
}

export type PackIssueKind = "missing" | "thumbnailMissing" | "overLimit" | "emoji" | "empty";

/** One issue: its badge label and its tooltip line. */
export interface PackIssue {
  kind: PackIssueKind;
  label: string;
  detail: string;
}

/** The facts of an opened pack: a small adapter, so the Pack view shares the rule with the list. */
export function packFactsOfView(view: PackView): PackFacts {
  const { pack, stickers } = view;
  return {
    status: pack.status,
    stickerCount: stickers.length,
    missingCount: stickers.filter((s) => s.missing).length,
    thumbnailMissing: pack.thumbnail !== null && (view.thumbnailMissing || view.thumbnailFile === null),
    emojiStrings: stickers.map((s) => s.emojiString),
  };
}

/**
 * The pack's issues, most severe first: Missing stickers, Thumbnail Missing,
 * over the sticker limit, Emoji Strings outside EMOJI_MIN-EMOJI_MAX, Empty.
 * Issues apply to Live packs too. No thumbnail is not an issue.
 */
export function packIssues(facts: PackFacts): PackIssue[] {
  const issues: PackIssue[] = [];
  if (facts.missingCount > 0) {
    const n = facts.missingCount;
    issues.push({
      kind: "missing",
      label: `${n} Missing`,
      detail: n === 1 ? "1 sticker is Missing" : `${n} stickers are Missing`,
    });
  }
  if (facts.thumbnailMissing) {
    issues.push({ kind: "thumbnailMissing", label: "Thumbnail Missing", detail: "The thumbnail file is Missing" });
  }
  if (facts.stickerCount > PACK_MAX_STICKERS) {
    issues.push({
      kind: "overLimit",
      label: `${facts.stickerCount} / ${PACK_MAX_STICKERS}`,
      detail: `${facts.stickerCount} stickers: Telegram allows at most ${PACK_MAX_STICKERS}`,
    });
  }
  const emoji = facts.emojiStrings.filter((s) => emojiCountWarning(s) !== null).length;
  if (emoji > 0) {
    issues.push({
      kind: "emoji",
      label: emoji === 1 ? "1 emoji issue" : `${emoji} emoji issues`,
      detail:
        emoji === 1
          ? `1 sticker's Emoji String is outside ${EMOJI_MIN}–${EMOJI_MAX}`
          : `${emoji} stickers' Emoji Strings are outside ${EMOJI_MIN}–${EMOJI_MAX}`,
    });
  }
  if (facts.stickerCount === 0) issues.push({ kind: "empty", label: "Empty", detail: "No stickers yet" });
  return issues;
}

/** Ready to go live: a Draft with no issues. A Live pack is never ready. */
export function isReady(facts: PackFacts): boolean {
  return facts.status === "draft" && packIssues(facts).length === 0;
}

export const READY_LABEL = "Ready to upload";
export const READY_DETAIL = "Every check passes: ready for @Stickers";

/** The Pack list's status badge for a pack, or null when it needs none. */
export interface StatusBadge {
  tone: "issue" | "ready";
  label: string;
  /** Every line of the tooltip, joined by newlines. */
  title: string;
}

/**
 * One badge per pack: the most severe issue's label plus ` +N` for the N
 * others, with every issue as a tooltip line. A Draft with no issues reads
 * "Ready to upload"; a Live pack with no issues shows nothing.
 */
export function statusBadgeOf(facts: PackFacts): StatusBadge | null {
  const issues = packIssues(facts);
  if (issues.length > 0) {
    const others = issues.length - 1;
    return {
      tone: "issue",
      label: others > 0 ? `${issues[0].label} +${others}` : issues[0].label,
      title: issues.map((i) => i.detail).join("\n"),
    };
  }
  return facts.status === "draft" ? { tone: "ready", label: READY_LABEL, title: READY_DETAIL } : null;
}
