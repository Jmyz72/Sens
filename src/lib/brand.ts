// Brand color map for MYR account templates.
// Each key maps to a tasteful brand-evoking hex that reads legibly in both
// dark and light themes — GlyphTile renders the glyph at full tone on a
// hexA(tone, 0.16) background, so near-black and near-white are avoided.
// Values are intentionally plausible, not pixel-accurate, brand hues.

export const BRAND_COLORS: Record<string, string> = {
  // ── Banks ──────────────────────────────────────────────────────────────
  "maybank":            "#E8A020", // gold/amber — Maybank's distinctive yellow
  "cimb":               "#C0272D", // deep red — CIMB red
  "public-bank":        "#B71C27", // rich crimson — Public Bank red
  "rhb":                "#1A3A8F", // navy blue — RHB corporate blue
  "hong-leong-bank":    "#C62828", // strong red — HLB red
  "ambank":             "#D4421A", // burnt orange-red — AmBank
  "bank-islam":         "#2E7D46", // forest green — Islamic bank green
  "bank-rakyat":        "#1B5E9E", // royal blue — Bank Rakyat blue
  "bank-muamalat":      "#1A6B3C", // deep green — Muamalat green
  "affin-bank":         "#8B2FC9", // purple — Affin's distinctive violet
  "alliance-bank":      "#0066A1", // corporate blue — Alliance
  "bsn":                "#006847", // deep green — BSN green
  "agrobank":           "#2E8B45", // verdant green — Agrobank
  "mbsb-bank":          "#004A7F", // deep navy — MBSB
  "al-rajhi-bank":      "#2D6A3F", // deep green — Al Rajhi Islamic
  "ocbc":               "#D4272E", // OCBC red
  "uob":                "#0033A0", // UOB deep blue
  "hsbc":               "#C41230", // HSBC signature red
  "standard-chartered": "#0C7BB3", // StanChart teal-blue

  // ── Digital banks ──────────────────────────────────────────────────────
  "gxbank":             "#00A8A8", // teal — GXBank
  "boost-bank":         "#E8450A", // Boost orange-red
  "aeon-bank":          "#C8222A", // AEON red
  "kaf-digital-bank":   "#3A5BC7", // medium blue — KAF
  "ryt-bank":           "#6C3FC7", // indigo-violet — Ryt

  // ── E-wallets ──────────────────────────────────────────────────────────
  "tng-ewallet":        "#1A52A8", // Touch 'n Go deep blue
  "grabpay":            "#00B14F", // Grab signature green
  "boost":              "#E8450A", // Boost orange-red
  "shopeepay":          "#EE4D2D", // Shopee orange-red
  "mae":                "#E8A020", // MAE uses Maybank gold
  "setel":              "#E84B1A", // Setel (Petronas) — warm red
  "bigpay":             "#E02B5A", // BigPay vibrant red-pink
  "lazada-wallet":      "#F55A23", // Lazada orange

  // ── Buy now, pay later ────────────────────────────────────────────────
  "atome":              "#B4DC2E", // Atome lime-green — their brand color;
                                   // mid-tone enough to tile well
  "shopee-paylater":    "#EE4D2D", // matches ShopeePay
  "grab-paylater":      "#00B14F", // matches GrabPay
  "boost-payflex":      "#E8450A", // matches Boost
  "riipay":             "#7C3AED", // purple — Riipay

  // ── Investment ────────────────────────────────────────────────────────
  "asnb":               "#005B9A", // ASNB corporate blue
  "stashaway":          "#2BBCCA", // StashAway teal
  "versa":              "#19A879", // Versa green
  "wahed":              "#1E6B45", // Wahed Islamic green
  "rakuten-trade":      "#BF0000", // Rakuten crimson
  "moomoo":             "#FF6B00", // Moomoo orange
  "kdi":                "#0063CF", // KDI (Kenanga) blue

  // ── Global fintech ────────────────────────────────────────────────────
  "paypal":             "#003087", // PayPal deep blue
  "wise":               "#48E084", // Wise bright green — mid-tone readable
  "revolut":            "#5B5EA6", // Revolut indigo (their gradient start)
  "n26":                "#1ABCAC", // N26 teal
  "payoneer":           "#FF4800", // Payoneer orange
};

// A small fixed palette of pleasant, distinct mid-tones used for custom
// (template-less) accounts. Picked to complement the app's dark/light palette
// and avoid conflict with the semantic colors (income green, expense red, etc.).
const FALLBACK_PALETTE = [
  "#5B8DEF", // soft blue
  "#A78BFA", // lavender
  "#34C4A4", // seafoam
  "#E0A13C", // amber
  "#E87BAC", // rose
  "#64B5F6", // sky
  "#81C784", // sage
  "#FFB74D", // peach
];

/** Simple djb2-style hash → palette index. */
function hashToPaletteIndex(seed: string): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h) ^ seed.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h % FALLBACK_PALETTE.length;
}

/**
 * Returns the brand tone for an account tile:
 * 1. `BRAND_COLORS[templateKey]` if the account has a known template key.
 * 2. A deterministic hue from FALLBACK_PALETTE seeded by `fallbackSeed`
 *    (stable across renders — good for custom accounts keyed by account id).
 * 3. `accentFallback` if neither is available.
 */
export function accountTone(
  opts: { templateKey?: string | null; fallbackSeed?: string },
  accentFallback: string,
): string {
  if (opts.templateKey && BRAND_COLORS[opts.templateKey]) {
    return BRAND_COLORS[opts.templateKey];
  }
  if (opts.fallbackSeed) {
    return FALLBACK_PALETTE[hashToPaletteIndex(opts.fallbackSeed)];
  }
  return accentFallback;
}

/** Convenience alias for the provider picker (key is always known). */
export function templateTone(key: string, accentFallback: string): string {
  return BRAND_COLORS[key] ?? accentFallback;
}
