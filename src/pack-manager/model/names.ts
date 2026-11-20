// Title and Short Name length rules (SPEC §3: the Title and Short Name limits
// from limits.json). Counted like the Rust core: Unicode scalar values (chars), not
// UTF-16 code units, so 64 emoji are valid. Hence no HTML `maxlength`.
import limits from "../../shared/limits.json";

/** Length in Unicode scalar values (what Rust's `chars().count()` gives). */
export function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * Trim exactly like Rust's `str::trim` (Unicode White_Space: strips U+0085,
 * does not strip U+FEFF), unlike JS `trim()`.
 */
export function rustTrim(s: string): string {
  return s.replace(/^\p{White_Space}+/u, "").replace(/\p{White_Space}+$/u, "");
}

/** Why `title` cannot be saved, or null. The core trims before counting. */
export function titleProblem(title: string): string | null {
  const n = charCount(rustTrim(title));
  if (n === 0) return "Enter a Title.";
  if (n > limits.pack.titleMaxChars) return `The Title is ${n} characters; the limit is ${limits.pack.titleMaxChars}.`;
  return null;
}

/**
 * Why `shortName` cannot be used, or null. In the create flow an empty one
 * means auto-derive (`allowEmpty: true`); in the pack header it is invalid
 * (the core rejects it).
 */
export function shortNameProblem(shortName: string, { allowEmpty = true }: { allowEmpty?: boolean } = {}): string | null {
  const n = charCount(rustTrim(shortName));
  if (n === 0) return allowEmpty ? null : "Enter a Short Name.";
  if (n > limits.pack.shortNameMaxChars) return `The Short Name is ${n} characters; the limit is ${limits.pack.shortNameMaxChars}.`;
  return null;
}
