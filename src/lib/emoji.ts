// Pure emoji helpers for the picker: search, grouping, and a recents list
// persisted to localStorage. UI lives in src/components/EmojiPicker.tsx.

export interface EmojiEntry {
  c: string;       // the emoji character
  n: string;       // human name, e.g. "money bag"
  g: string;       // Unicode group, e.g. "Food & Drink"
  k: string[];     // search keywords
}

export interface EmojiGroup {
  group: string;
  emojis: EmojiEntry[];
}

const RECENTS_KEY = "sens.emoji.recent";
const RECENTS_CAP = 24;

// Finance-relevant quick picks shown above the groups when the search is empty.
// Hardcoded data constant (allowed per CLAUDE.md).
export const SUGGESTED = [
  "💰", "🏦", "💳", "🛒", "🍽️", "🚗", "🏠", "💡", "📱", "💊",
  "🎁", "📈", "💸", "✈️", "🎬", "👕", "📚", "🐶", "☕", "💵",
];

export function filterEmojis(data: EmojiEntry[], query: string): EmojiEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return data;
  return data.filter(
    (e) => e.n.toLowerCase().includes(q) || e.k.some((kw) => kw.toLowerCase().includes(q)),
  );
}

export function groupEmojis(data: EmojiEntry[]): EmojiGroup[] {
  const groups: EmojiGroup[] = [];
  const index = new Map<string, EmojiGroup>();
  for (const e of data) {
    let g = index.get(e.g);
    if (!g) {
      g = { group: e.g, emojis: [] };
      index.set(e.g, g);
      groups.push(g);
    }
    g.emojis.push(e);
  }
  return groups;
}

export function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function pushRecent(current: string[], emoji: string): string[] {
  const next = [emoji, ...current.filter((e) => e !== emoji)].slice(0, RECENTS_CAP);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / unavailable storage */
  }
  return next;
}
