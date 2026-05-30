// Bundled provider logos, keyed by template key. Brand marks live in
// src/assets/logos/<key>.svg and are rendered on a white plate by ProviderLogo.
// Coverage is best-effort: providers with a bundled logo show it; the rest fall
// back to ProviderLogo's brand-tinted monogram tile. No completeness requirement.

const modules = import.meta.glob("../assets/logos/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const byKey: Record<string, string> = {};
for (const [path, url] of Object.entries(modules)) {
  const key = path.split("/").pop()!.replace(/\.svg$/, "");
  byKey[key] = url;
}

export function logoFor(key: string | null | undefined): string | null {
  return key ? byKey[key] ?? null : null;
}
