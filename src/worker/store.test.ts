import { describe, expect, it } from "vite-plus/test";
import type { StorageRequest } from "./protocol";
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

  describe("entries()", () => {
    it("is empty for a fresh store", () => {
      expect(new CacheStore().entries()).toEqual([]);
    });

    it("returns every stored pair", () => {
      const store = new CacheStore();
      store.setItem("a", "1");
      store.setItem("b", "2");
      expect(store.entries()).toEqual([
        ["a", "1"],
        ["b", "2"],
      ]);
    });

    it("reflects removals and overwrites", () => {
      const store = new CacheStore();
      store.setItem("a", "1");
      store.setItem("b", "2");
      store.setItem("a", "updated");
      store.removeItem("b");
      expect(store.entries()).toEqual([["a", "updated"]]);
    });

    it("hands back a snapshot that later writes do not mutate", () => {
      const store = new CacheStore();
      store.setItem("a", "1");
      const snapshot = store.entries();
      store.setItem("b", "2");
      expect(snapshot).toEqual([["a", "1"]]);
    });

    it("returns only the pairs under a prefix when one is given", () => {
      const store = new CacheStore();
      store.setItem("APP-a", "1");
      store.setItem("OTHER-b", "2");
      store.setItem("APP-c", "3");
      expect(store.entries("APP-")).toEqual([
        ["APP-a", "1"],
        ["APP-c", "3"],
      ]);
    });

    it("matches on the whole prefix rather than anywhere in the key", () => {
      const store = new CacheStore();
      store.setItem("prefixed", "1");
      store.setItem("un-prefixed", "2");
      expect(store.entries("prefix")).toEqual([["prefixed", "1"]]);
    });

    it("is empty when nothing matches the prefix", () => {
      const store = new CacheStore();
      store.setItem("a", "1");
      expect(store.entries("APP-")).toEqual([]);
    });

    it("returns everything for an empty prefix, as every key starts with one", () => {
      const store = new CacheStore();
      store.setItem("a", "1");
      store.setItem("b", "2");
      expect(store.entries("")).toEqual([
        ["a", "1"],
        ["b", "2"],
      ]);
    });
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

    it("maps an entries request to every stored pair", () => {
      const store = new CacheStore();
      store.setItem("a", "1");
      store.setItem("b", "2");
      expect(store.handle({ kind: "request", id: 1, op: "entries" })).toEqual([
        ["a", "1"],
        ["b", "2"],
      ]);
    });

    it("maps an entries request carrying a prefix to the pairs under it", () => {
      const store = new CacheStore();
      store.setItem("APP-a", "1");
      store.setItem("OTHER-b", "2");
      expect(store.handle({ kind: "request", id: 1, op: "entries", prefix: "APP-" })).toEqual([
        ["APP-a", "1"],
      ]);
    });

    it("throws for an unknown operation instead of returning undefined", () => {
      const store = new CacheStore();
      const request = {
        kind: "request",
        id: 1,
        op: "clear",
        key: "k",
      } as unknown as StorageRequest;
      expect(() => store.handle(request)).toThrow(/clear/);
    });

    it("names an operation that cannot be serialized rather than failing to describe it", () => {
      const store = new CacheStore();
      const request = { kind: "request", id: 1, op: 10n } as unknown as StorageRequest;
      expect(() => store.handle(request)).toThrow("Unknown storage operation: 10n");
    });
  });
});
