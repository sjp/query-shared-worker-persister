import { describe, expect, it } from "vite-plus/test";
import { describeValue } from "./describe-value";

describe("describeValue", () => {
  it.each([
    ["a string", "getItem", '"getItem"'],
    ["an empty string", "", '""'],
    ["a string needing escapes", 'a"b', '"a\\"b"'],
    ["a number", 42, "42"],
    ["NaN", NaN, "NaN"],
    ["a boolean", false, "false"],
    ["undefined", undefined, "undefined"],
    ["null", null, "null"],
    ["a bigint", 10n, "10n"],
    ["a function", () => {}, "a function"],
    ["an array", [1, 2], "an array"],
    ["a plain object", { a: 1 }, "an object"],
  ])("describes %s", (_label, value, expected) => {
    expect(describeValue(value)).toBe(expected);
  });

  it("quotes a long string only up to its head, and says how long it was", () => {
    const description = describeValue("x".repeat(1000));
    expect(description).toBe(`"${"x".repeat(64)}"... (1000 characters)`);
  });

  it("quotes a string at the cut-off length in full", () => {
    const exact = "y".repeat(64);
    expect(describeValue(exact)).toBe(`"${exact}"`);
  });

  it("describes a symbol by its own description", () => {
    expect(describeValue(Symbol("clear"))).toBe("Symbol(clear)");
  });

  it("describes a cyclic object without walking into it", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(describeValue(cyclic)).toBe("an object");
  });

  it("describes an object with a throwing getter without invoking it", () => {
    const hostile = {
      get boom(): never {
        throw new Error("read me and see");
      },
    };
    expect(describeValue(hostile)).toBe("an object");
  });
});
