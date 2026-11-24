// Generates src-tauri/src/editor/emoji_data.rs — the Emoji_Presentation
// code point ranges — from the Unicode Consortium's emoji-data.txt
// (https://www.unicode.org/Public/<version>/ucd/emoji/emoji-data.txt).
//
// Usage: bun scripts/generate-emoji-presentation.mjs <emoji-data.txt>
//
// The generated file is checked in, so no network and no Unicode data
// file ships with the repo; the header records the source version and
// date for provenance. Unicode data files are governed by the Unicode
// License (https://www.unicode.org/license.txt).
import { readFileSync, writeFileSync } from "node:fs";

const input = process.argv[2];
if (!input) {
  console.error("usage: bun scripts/generate-emoji-presentation.mjs <emoji-data.txt>");
  process.exit(1);
}

const text = readFileSync(input, "utf8");
const date = text.match(/^# Date: (.+)$/m)?.[1] ?? "unknown";
const version = text.match(/Emoji Version (\S+)/)?.[1] ?? "unknown";
const ranges = [];
for (const line of text.split("\n")) {
  const m = line.match(/^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s*;\s*Emoji_Presentation\s*#/);
  if (!m) continue;
  const start = Number.parseInt(m[1], 16);
  const end = m[2] ? Number.parseInt(m[2], 16) : start;
  ranges.push([start, end]);
}
if (ranges.length === 0) {
  console.error("no Emoji_Presentation ranges found — is this really emoji-data.txt?");
  process.exit(1);
}
ranges.sort((a, b) => a[0] - b[0]);
for (let i = 1; i < ranges.length; i++) {
  if (ranges[i][0] <= ranges[i - 1][1]) {
    console.error(`overlapping ranges around U+${ranges[i][0].toString(16).toUpperCase()}`);
    process.exit(1);
  }
}

const codepoints = ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);
const header = `//! Emoji_Presentation code point ranges (which characters default to
//! emoji drawing, UTS #51) — GENERATED, do not edit by hand.
//!
//! Source: Unicode emoji-data.txt, Emoji Version ${version} (${date}),
//! https://www.unicode.org/Public/${version}/ucd/emoji/emoji-data.txt
//! (Unicode License). Regenerate with:
//!   bun scripts/generate-emoji-presentation.mjs <emoji-data.txt>
//! ${ranges.length} ranges, ${codepoints} code points.
`;
const body = `

/// Inclusive Emoji_Presentation ranges, ascending without overlap.
pub(super) const EMOJI_PRESENTATION: [(u32, u32); ${ranges.length}] = [
${ranges.map(([a, b]) => `    (0x${a.toString(16).toUpperCase()}, 0x${b.toString(16).toUpperCase()}),`).join("\n")}
];

/// Whether \`c\` defaults to emoji presentation (UTS #51): such characters
/// are routed to the emoji font chain (SPM-20). Everything else stays with
/// the text font unless a VS16 follows it.
pub(super) fn is_emoji_presentation(c: char) -> bool {
    let c = c as u32;
    EMOJI_PRESENTATION.binary_search_by(|&(lo, hi)| {
        if c < lo {
            std::cmp::Ordering::Greater
        } else if c > hi {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Equal
        }
    })
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_covers_the_canary_code_points() {
        // Presented by default: a Unicode-15 hand, an RI, a grinning face.
        assert!(is_emoji_presentation('\\u{1FAF5}'));
        assert!(is_emoji_presentation('\\u{1F1E6}'));
        assert!(is_emoji_presentation('\\u{1F600}'));
        // Text presentation by default: heart, smiley, digits, plain text.
        assert!(!is_emoji_presentation('\\u{2764}'));
        assert!(!is_emoji_presentation('\\u{263A}'));
        assert!(!is_emoji_presentation('5'));
        assert!(!is_emoji_presentation('A'));
        assert!(!is_emoji_presentation('\\u{00E9}'));
    }
}
`;
writeFileSync(new URL("../src-tauri/src/editor/emoji_data.rs", import.meta.url), header + body);
console.log(`emoji_data.rs: ${ranges.length} ranges, ${codepoints} code points (Emoji ${version})`);
