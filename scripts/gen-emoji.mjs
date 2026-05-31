// One-shot generator: builds src/assets/emoji-data.json from unicode-emoji-json.
// Run with `node scripts/gen-emoji.mjs`. Not part of the normal build — the
// JSON output is committed. Re-run only to refresh the emoji catalog.
//
// unicode-emoji-json@0.9.0 exposes name/slug/group per emoji (no keyword file),
// so search keywords are derived from the slug (e.g. "money_bag" -> ["money",
// "bag"]); filterEmojis also matches the name, so this covers both.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const byEmoji = require("unicode-emoji-json/data-by-emoji.json");

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = join(__dirname, "..", "src", "assets", "emoji-data.json");

// Keep everything with a real group, in unicode order (data-by-emoji is ordered).
const data = [];
for (const [char, info] of Object.entries(byEmoji)) {
  if (!info.group || info.group === "Component") continue;
  const keywords = (info.slug ?? "").split("_").filter(Boolean);
  data.push({
    c: char,
    n: info.name,
    g: info.group,
    k: keywords,
  });
}

writeFileSync(out, JSON.stringify(data));
console.log(`Wrote ${data.length} emojis to ${out}`);
