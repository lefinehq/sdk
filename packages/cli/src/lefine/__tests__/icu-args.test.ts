import { describe, expect, it } from "bun:test";
import { icuArgs } from "../icu-args.js";

describe("icuArgs", () => {
  it("names each argument with the type it needs", () => {
    expect(icuArgs("Hello {name}, you have {n, plural, one {# message} other {# messages from {sender}}}")).toEqual({
      name: "string | number",
      n: "number",
      sender: "string | number",
    });
    expect(icuArgs("{g, select, female {She} other {They}} paid {p, number, ::currency/EUR} on {d, date, short} at {t, time}")).toEqual({
      g: "string",
      p: "number",
      d: "Date | number",
      t: "Date | number",
    });
    expect(icuArgs("{n, plural, offset:1 =0 {nobody} other {# others}}")).toEqual({ n: "number" });
  });

  it("branch selectors, quoted braces and tags are not arguments", () => {
    expect(icuArgs("{n, plural, =0 {none} one {one} other {many}}")).toEqual({ n: "number" });
    expect(icuArgs("It''s '{not}' an <b>argument</b>")).toEqual({});
  });

  it("a name used plain and as a number keeps number", () => {
    expect(icuArgs("{n} {n, number}")).toEqual({ n: "number" });
  });

  it("a text it cannot read gives no types, not wrong ones", () => {
    expect(icuArgs("{unclosed")).toBeNull();
    expect(icuArgs("{a, foo}")).toBeNull();
  });
});
