import { describe, expect, it } from "vitest";
import { compileMessages } from "../../strings/compile.js";
import { flightRender } from "./flight.js";

describe("what crosses the Server/Client boundary survives React Flight (audit #2)", () => {
  it("the renderer rejects a null-prototype object (so this test can see the bug)", async () => {
    const bad = Object.create(null) as Record<string, string>;
    bad.a = "x";
    expect((await flightRender({ messages: bad })).errors.join()).toContain("null prototypes are not supported");
  });

  it("a tree compiled on the server (no messages.ir.json) serializes, branches included", async () => {
    const tree = compileMessages({ nav: { a: "Hi {n, plural, one {# x} other {# y}} {g, select, a {A} other {B}}" }, b: { "c.d": "x" } });
    expect((await flightRender({ locale: "en", messages: tree })).errors).toEqual([]);
  });

  it("a key named __proto__ stays a key and does not change the object's prototype", () => {
    const tree = compileMessages(JSON.parse('{"ns": {"__proto__": "Text", "ok": "Fine"}}'));
    expect(Object.getPrototypeOf(tree.ns)).toBe(Object.prototype);
    expect(Object.keys(tree.ns as object).sort()).toEqual(["__proto__", "ok"]);
  });
});
