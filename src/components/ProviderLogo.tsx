import { useTheme } from "../theme/ThemeProvider";
import { GlyphTile } from "./ui";
import { accountTone } from "../lib/brand";
import { logoFor } from "../lib/logos";

// A white plate is the required substrate for brand logos (most assume a light
// background), so it stays white in both themes — treated as brand data, not a
// theme color.
const LOGO_PLATE = "#ffffff";

export function ProviderLogo({
  templateKey, name, size = 38, radius = 10, seed,
}: {
  templateKey: string | null | undefined;
  name?: string;
  size?: number;
  radius?: number;
  seed?: string;
}) {
  const t = useTheme();
  const url = logoFor(templateKey);
  if (url) {
    return (
      <div style={{
        width: size, height: size, borderRadius: radius, background: LOGO_PLATE,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0, overflow: "hidden", boxShadow: "0 1px 2px rgba(0,0,0,0.18)",
      }}>
        <img src={url} alt={name ?? ""} style={{ width: "72%", height: "72%", objectFit: "contain" }} />
      </div>
    );
  }
  // No provider (custom account) → brand-tinted monogram tile.
  return (
    <GlyphTile
      tone={accountTone({ templateKey, fallbackSeed: seed }, t.accent)}
      size={size}
      emoji={(name ?? "?")[0]}
      radius={radius}
    />
  );
}
