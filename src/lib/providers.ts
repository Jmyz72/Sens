// Mock-only provider catalog, DERIVED from src/generated/seed-catalog.json
// (which is generated from the Rust seed in src-tauri/src/db/seed.rs and is the
// single source of truth). The packaged app gets providers from the
// `list_templates` Rust command, not from this file. Do not hand-edit the
// provider list here — edit the Rust seed and run `npm run gen:seed-catalog`.
import catalog from "../generated/seed-catalog.json";

export type ProviderGroup = {
  group: string;
  defaultSubtype: string;
  providers: [key: string, name: string][];
};

// Group the catalog templates by groupName, preserving catalog order (sort_order).
export const PROVIDER_GROUPS: ProviderGroup[] = (() => {
  const groups: ProviderGroup[] = [];
  const byName = new Map<string, ProviderGroup>();
  for (const t of catalog.templates) {
    let g = byName.get(t.groupName);
    if (!g) {
      g = { group: t.groupName, defaultSubtype: t.defaultSubtype, providers: [] };
      byName.set(t.groupName, g);
      groups.push(g);
    }
    g.providers.push([t.key, t.name]);
  }
  return groups;
})();

export const PROVIDER_KEYS: string[] = catalog.templates.map((t) => t.key);
