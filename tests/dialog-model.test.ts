import { describe, expect, test } from "bun:test";
import { confirmButtons, SAFE_CHOICE } from "../src/shared/dialog-model";

describe("two-option dialog rules", () => {
  test("keep is primary, last, and the safe choice Esc resolves to", () => {
    const [action, keep] = confirmButtons({ actionLabel: "Go Live", keepLabel: "Keep Draft" });
    expect(action).toEqual({ label: "Go Live", value: "action", variant: "secondary" });
    expect(keep).toEqual({ label: "Keep Draft", value: "keep", variant: "primary" });
    expect(SAFE_CHOICE).toBe("keep");
  });
  test("danger styles the action", () => {
    const [action, keep] = confirmButtons({ actionLabel: "Delete", keepLabel: "Cancel", danger: true });
    expect(action.variant).toBe("danger");
    expect(keep.variant).toBe("primary");
  });
  test("keepFirst puts the safe choice first, still primary (the even-WEBP question only)", () => {
    const buttons = confirmButtons({ actionLabel: "Nah fuck it", keepLabel: "Maybe I can fix it", danger: true, keepFirst: true });
    expect(buttons.map((b) => [b.label, b.value, b.variant])).toEqual([
      ["Maybe I can fix it", "keep", "primary"],
      ["Nah fuck it", "action", "danger"],
    ]);
  });
});
