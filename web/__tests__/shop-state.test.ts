import { describe, it, expect, beforeEach } from "vitest";
import {
  loadChecked,
  saveChecked,
  storageKey,
  normalizeItemKey,
} from "../lib/shop-state";

// Minimal in-memory localStorage shim for Node test runner.
class MemStore {
  store = new Map<string, string>();
  getItem(k: string) {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, v);
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  clear() {
    this.store.clear();
  }
}

describe("shop-state", () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { localStorage: MemStore } }).window = {
      localStorage: new MemStore(),
    };
  });

  it("stores under shop_${id}_checked", () => {
    expect(storageKey("run_42")).toBe("shop_run_42_checked");
  });

  it("normalizes item keys to lowercase trim", () => {
    expect(normalizeItemKey("  Asparagus  ")).toBe("asparagus");
  });

  it("round-trips a set of checked items", () => {
    const set = new Set<string>(["asparagus", "feta"]);
    saveChecked("run_a", set);
    const loaded = loadChecked("run_a");
    expect(loaded.has("asparagus")).toBe(true);
    expect(loaded.has("feta")).toBe(true);
    expect(loaded.has("rice")).toBe(false);
  });

  it("returns empty set when nothing saved", () => {
    expect(loadChecked("nonexistent_run").size).toBe(0);
  });

  it("survives malformed JSON gracefully", () => {
    const w = (globalThis as unknown as {
      window: { localStorage: MemStore };
    }).window;
    w.localStorage.setItem("shop_run_x_checked", "{not json");
    expect(loadChecked("run_x").size).toBe(0);
  });
});
