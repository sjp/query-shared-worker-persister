import { describe, expect, it } from "vite-plus/test";
import { CacheStore } from "./store";

describe("CacheStore", () => {
  it("returns null for a missing key", () => {
    const store = new CacheStore();
    expect(store.getItem("nope")).toBeNull();
  });

  it("round-trips set -> get", () => {
    const store = new CacheStore();
    store.setItem("k", "v");
    expect(store.getItem("k")).toBe("v");
  });

  it("overwrites an existing key", () => {
    const store = new CacheStore();
    store.setItem("k", "first");
    store.setItem("k", "second");
    expect(store.getItem("k")).toBe("second");
  });

  it("removes a key", () => {
    const store = new CacheStore();
    store.setItem("k", "v");
    store.removeItem("k");
    expect(store.getItem("k")).toBeNull();
  });

  it("preserves arbitrary serialized (JSON) strings verbatim", () => {
    const store = new CacheStore();
    const blob = JSON.stringify({ queries: [{ queryKey: ["demo"], state: { data: 42 } }] });
    store.setItem("REACT_QUERY_OFFLINE_CACHE", blob);
    expect(store.getItem("REACT_QUERY_OFFLINE_CACHE")).toBe(blob);
  });

  describe("handle()", () => {
    it("maps a getItem request to the stored value", () => {
      const store = new CacheStore();
      store.setItem("k", "v");
      expect(store.handle({ kind: "request", id: 1, op: "getItem", key: "k" })).toBe("v");
    });

    it("applies setItem and resolves to null", () => {
      const store = new CacheStore();
      const result = store.handle({ kind: "request", id: 1, op: "setItem", key: "k", value: "v" });
      expect(result).toBeNull();
      expect(store.getItem("k")).toBe("v");
    });

    it("applies removeItem and resolves to null", () => {
      const store = new CacheStore();
      store.setItem("k", "v");
      const result = store.handle({ kind: "request", id: 1, op: "removeItem", key: "k" });
      expect(result).toBeNull();
      expect(store.getItem("k")).toBeNull();
    });
  });
});
