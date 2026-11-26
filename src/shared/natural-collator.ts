// One natural-order collator for the app's name sorting: case and accents
// ignored, numbers by value ("sticker2" before "sticker10").
export const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
