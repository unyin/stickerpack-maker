// Generates src-tauri/src/emoji_property.rs — the Emoji code point ranges
// (the UTS #51 Emoji property, not Emoji_Presentation) — from the Unicode
// Consortium's emoji-data.txt
// (https://www.unicode.org/Public/<version>/ucd/emoji/emoji-data.txt).
//
// Usage: bun scripts/generate-emoji.mjs <emoji-data.txt>
//
// The generated file is checked in, so no network and no Unicode data
// file ships with the repo; the header records the source version and
// date for provenance. Unicode data files are governed by the Unicode
// License (https://www.unicode.org/license.txt).
import { readFileSync, writeFileSync } from "node:fs";

const input = process.argv[2];
if (!input) {
  console.error("usage: bun scripts/generate-emoji.mjs <emoji-data.txt>");
  process.exit(1);
}

const text = readFileSync(input, "utf8");
const date = text.match(/^# Date: (.+)$/m)?.[1] ?? "unknown";
const version = text.match(/Emoji Version (\S+)/)?.[1] ?? "unknown";
// The file names the version in two parts (16.0); Unicode's public
// directory for it uses three (16.0.0).
const dir = version.replace(/^(\d+\.\d+)$/, "$1.0");
const ranges = [];
for (const line of text.split("\n")) {
  // The property column, matched exactly: "Emoji " but not the longer
  // Emoji_Presentation / Emoji_Modifier / Emoji_Modifier_Base /
  // Emoji_Component lines that share the prefix.
  const m = line.match(/^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s*;\s*Emoji\s*#/);
  if (!m) continue;
  const start = Number.parseInt(m[1], 16);
  const end = m[2] ? Number.parseInt(m[2], 16) : start;
  ranges.push([start, end]);
}
if (ranges.length === 0) {
  console.error("no Emoji ranges found — is this really emoji-data.txt?");
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
const header = `//! Emoji code point ranges (the UTS #51 Emoji property: characters that
//! count as emoji, presentation either way) — GENERATED, do not edit by hand.
//!
//! Source: Unicode emoji-data.txt, Emoji Version ${version} (${date}),
//! https://www.unicode.org/Public/${dir}/ucd/emoji/emoji-data.txt
//! (Unicode License). Regenerate with:
//!   bun scripts/generate-emoji.mjs <emoji-data.txt>
//! ${ranges.length} ranges, ${codepoints} code points.
`;
const body = `

/// Inclusive Emoji ranges, ascending without overlap.
const EMOJI: [(u32, u32); ${ranges.length}] = [
${ranges.map(([a, b]) => `    (0x${a.toString(16).toUpperCase()}, 0x${b.toString(16).toUpperCase()}),`).join("\n")}
];

/// Whether \`c\` is an emoji (UTS #51 Emoji property). Emoji_Presentation is
/// the narrower question (which characters default to emoji drawing) and
/// lives in editor::emoji_data; this one decides what an Emoji String keeps
/// (SPM-39). It is not "looks like an emoji": digits and # * carry it, while
/// a sequence's VS16 and keycap mark do not — their base character does.
pub fn is_emoji(c: char) -> bool {
    let c = c as u32;
    EMOJI
        .binary_search_by(|&(lo, hi)| {
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
        // Emoji either presentation: a presented face, a text-default heart
        // with no VS16, a tag flag's base, and a bare digit (the edge that
        // SPM-39 accepts: the Emoji property does not mean "looks like an
        // emoji").
        assert!(is_emoji('\\u{1F600}'));
        assert!(is_emoji('\\u{2764}'));
        assert!(is_emoji('\\u{1F3F4}'));
        assert!(is_emoji('3'));
        // Emoji_Component without Emoji: the ZWJ and the keycap mark, which
        // live inside a sequence whose base carries the property instead.
        assert!(!is_emoji('\\u{200D}'));
        assert!(!is_emoji('\\u{20E3}'));
        assert!(!is_emoji('\\u{FE0F}'));
        // Not emoji at all: letters, whitespace, a combining accent.
        assert!(!is_emoji('A'));
        assert!(!is_emoji(' '));
        assert!(!is_emoji('\\u{0301}'));
    }
}
`;
writeFileSync(new URL("../src-tauri/src/emoji_property.rs", import.meta.url), header + body);
console.log(`emoji_property.rs: ${ranges.length} ranges, ${codepoints} code points (Emoji ${version})`);
