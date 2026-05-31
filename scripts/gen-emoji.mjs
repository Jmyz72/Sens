// One-shot generator: builds src/assets/emoji-data.json from emojibase-data.
// Run with `node scripts/gen-emoji.mjs`. Not part of the normal build — the
// JSON output is committed. Re-run only to refresh the emoji catalog.
//
// emojibase-data ships rich search tags per emoji (e.g. ☕️ -> coffee, cafe,
// tea, drink), which power keyword search. We keep only real, grouped emoji
// (skip the "components" group and ungrouped regional indicators), sort by
// emojibase's `order`, and store { c, n, g, k }.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const emojis = require("emojibase-data/en/data.json");
const { groups } = require("emojibase-data/en/messages.json");

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = join(__dirname, "..", "src", "assets", "emoji-data.json");

// group order (0..9) -> Title-Cased label, e.g. 4 -> "Food & Drink".
const GROUP_NAME = new Map(
  groups.map((g) => [
    g.order,
    g.message.replace(/\b\w/g, (ch) => ch.toUpperCase()),
  ]),
);
const COMPONENTS_GROUP = groups.find((g) => g.key === "component")?.order;

const usable = emojis
  .filter((e) => e.group !== undefined && e.group !== COMPONENTS_GROUP)
  .sort((a, b) => a.order - b.order);

const data = usable.map((e) => {
  // Merge curated tags with words from the label so both "money bag" and a
  // tag like "dollar" match. Dedupe, lowercase.
  const words = (e.label ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const keywords = [...new Set([...(e.tags ?? []), ...words])];
  return {
    c: e.emoji,
    n: e.label,
    g: GROUP_NAME.get(e.group),
    k: keywords,
  };
});

writeFileSync(out, JSON.stringify(data));
console.log(`Wrote ${data.length} emojis to ${out}`);
