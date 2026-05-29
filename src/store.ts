// Lightweight app-data store: loads accounts + categories once, exposes a
// reload() that screens call after mutations, and a `version` counter screens
// can depend on to re-fetch their own data (dashboard, transaction lists).

import { createContext, useContext } from "react";
import type { Account, Category } from "./types";

export interface AppData {
  accounts: Account[];
  categories: Category[];
  loading: boolean;
  /** Re-fetch accounts + categories and bump `version`. */
  reload: () => Promise<void>;
  /** Increments on every reload; depend on it to refresh derived data. */
  version: number;
}

export const AppDataCtx = createContext<AppData>({
  accounts: [], categories: [], loading: true, reload: async () => {}, version: 0,
});

export const useAppData = () => useContext(AppDataCtx);

export const categoriesByKind = (cats: Category[], kind: Category["kind"]) =>
  cats.filter((c) => c.kind === kind);

export const accountName = (accounts: Account[], id: string | null) =>
  (id && accounts.find((a) => a.id === id)?.name) || "—";
