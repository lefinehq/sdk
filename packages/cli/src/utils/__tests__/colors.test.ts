import { describe, expect, it } from "bun:test";
import { useColor } from "../colors.js";

describe("useColor", () => {
  it("colors a terminal, not a pipe or a CI log", () => {
    expect(useColor({}, true)).toBe(true);
    expect(useColor({}, false)).toBe(false);
    expect(useColor({}, undefined)).toBe(false);
  });

  it("NO_COLOR turns it off, FORCE_COLOR on; NO_COLOR wins", () => {
    expect(useColor({ NO_COLOR: "1" }, true)).toBe(false);
    expect(useColor({ NO_COLOR: "" }, true)).toBe(true);
    expect(useColor({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(useColor({ FORCE_COLOR: "0" }, false)).toBe(false);
    expect(useColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
  });
});
