import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex, sha256HexJs } from "../sha256.js";

const node = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("sha256 (synchronous, for Cache Components)", () => {
  it("the portable path matches node:crypto at every padding edge and on a large file", () => {
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 4096 + 7]) {
      const b = new Uint8Array(randomBytes(n));
      expect(sha256HexJs(b)).toBe(node(b));
    }
    expect(sha256HexJs(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const big = new Uint8Array(randomBytes(650_000)); // a Landing language file is about this size
    expect(sha256HexJs(big)).toBe(node(big));
  });

  it("returns a string, not a promise: nothing waits for a later task", () => {
    const b = new TextEncoder().encode("Hallo von Lefine");
    expect(typeof sha256Hex(b)).toBe("string");
    expect(sha256Hex(b)).toBe(node(b));
  });
});
