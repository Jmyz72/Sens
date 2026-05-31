import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { filterEmojis, groupEmojis, loadRecents, pushRecent, type EmojiEntry } from "../emoji";

// The test env is "node" (vite.config.ts) — no localStorage. Provide a tiny
// in-memory shim so the recents helpers have somewhere to read/write.
beforeAll(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
});

const DATA: EmojiEntry[] = [
  { c: "😀", n: "grinning face", g: "Smileys & Emotion", k: ["face", "grin", "happy"] },
  { c: "🍕", n: "pizza", g: "Food & Drink", k: ["slice", "cheese"] },
  { c: "💰", n: "money bag", g: "Objects", k: ["dollar", "cash"] },
];

describe("filterEmojis", () => {
  it("returns all entries for an empty query", () => {
    expect(filterEmojis(DATA, "")).toHaveLength(3);
    expect(filterEmojis(DATA, "   ")).toHaveLength(3);
  });
  it("matches on name, case-insensitively", () => {
    expect(filterEmojis(DATA, "PIZZA").map((e) => e.c)).toEqual(["🍕"]);
  });
  it("matches on keywords", () => {
    expect(filterEmojis(DATA, "cash").map((e) => e.c)).toEqual(["💰"]);
  });
  it("returns empty when nothing matches", () => {
    expect(filterEmojis(DATA, "zzzzz")).toEqual([]);
  });
});

describe("groupEmojis", () => {
  it("buckets entries by group, preserving first-seen order", () => {
    const groups = groupEmojis(DATA);
    expect(groups.map((g) => g.group)).toEqual([
      "Smileys & Emotion",
      "Food & Drink",
      "Objects",
    ]);
    expect(groups[1].emojis.map((e) => e.c)).toEqual(["🍕"]);
  });
});

describe("recents", () => {
  beforeEach(() => localStorage.clear());
  it("returns [] when nothing stored", () => {
    expect(loadRecents()).toEqual([]);
  });
  it("pushes most-recent-first, dedupes, and caps at 24", () => {
    let r = pushRecent([], "😀");
    r = pushRecent(r, "🍕");
    r = pushRecent(r, "😀"); // re-select moves it to front, no dupe
    expect(r.slice(0, 2)).toEqual(["😀", "🍕"]);
    expect(r).toHaveLength(2);
    let big: string[] = [];
    for (let i = 0; i < 30; i++) big = pushRecent(big, `e${i}`);
    expect(big).toHaveLength(24);
    expect(big[0]).toBe("e29");
  });
  it("persists to localStorage and reloads", () => {
    pushRecent([], "💰");
    expect(loadRecents()).toEqual(["💰"]);
  });
});
