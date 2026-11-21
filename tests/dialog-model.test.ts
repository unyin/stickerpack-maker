import { describe, expect, test } from "bun:test";
import { CANCEL_CHOICE, confirmButtons } from "../src/dialog-model";

describe("two-option dialog rules", () => {
  test("keep is the default and primary; Esc resolves to keep", () => {
    const [action, keep] = confirmButtons({ actionLabel: "Go Live", keepLabel: "Keep Draft" });
    expect(action).toEqual({ label: "Go Live", value: "action", variant: "secondary" });
    expect(keep).toEqual({ label: "Keep Draft", value: "keep", variant: "primary" });
    expect(CANCEL_CHOICE).toBe("keep");
  });
  test("danger styles the action when keep is the default", () => {
    const [action, keep] = confirmButtons({ actionLabel: "Delete", keepLabel: "Cancel", danger: true });
    expect(action.variant).toBe("danger");
    expect(keep.variant).toBe("primary");
  });
  test("an action default is primary and keep turns secondary", () => {
    const [action, keep] = confirmButtons({ actionLabel: "A", keepLabel: "B", defaultChoice: "action", danger: true });
    expect(action.variant).toBe("primary");
    expect(keep.variant).toBe("secondary");
  });
});
