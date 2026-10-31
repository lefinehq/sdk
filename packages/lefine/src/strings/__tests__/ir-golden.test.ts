import { describe, expect, it } from "vitest";
import { compile } from "../compile.js";
import golden from "./ir-golden.json";

// audit #4: Lefine's publish (same parser) and the SDK must give the same IR.
// The publish side runs this file too. A change here is a wire-format change: regenerate with scripts/ir-golden.ts on purpose.
describe("IR golden file", () => {
  it(`${golden.cases.length} texts compile to the recorded IR, or are refused`, () => {
    for (const c of golden.cases as Array<{ text: string; ir?: unknown; error?: true }>) {
      if (c.error) expect(() => compile(c.text), c.text).toThrow();
      else expect(JSON.parse(JSON.stringify(compile(c.text))), c.text).toEqual(c.ir);
    }
  });
});
