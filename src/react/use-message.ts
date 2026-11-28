import { useCallback, useState } from "react";
import { errorMessage } from "../ui";

/**
 * React twin of `withMessage` (ui.ts): the message text lives in state, the
 * caller renders it in a `<p className="message" role="alert">` that is always
 * present. `run` clears the text, awaits the action and routes a thrown error
 * into the text; it never throws. `set` writes a non-error message.
 */
export function useMessage(): {
  text: string;
  set(text: string): void;
  run(action: () => Promise<void>): Promise<void>;
} {
  const [text, set] = useState("");
  const run = useCallback(async (action: () => Promise<void>) => {
    set("");
    try {
      await action();
    } catch (err) {
      set(errorMessage(err));
    }
  }, []);
  return { text, set, run };
}
