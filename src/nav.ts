// Shared navigation config for the shell (sidebar + top bar).

import type { IconName } from "./components/Icon";

export type ScreenId = "dashboard" | "accounts" | "transactions" | "categories" | "settings";

export const NAV: { id: ScreenId; label: string; icon: IconName; sub: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "home", sub: "Your money at a glance" },
  { id: "accounts", label: "Accounts", icon: "wallet", sub: "All balances in one place" },
  { id: "transactions", label: "Transactions", icon: "list", sub: "Every ringgit in and out" },
  { id: "categories", label: "Categories", icon: "filter", sub: "Income, expense & transfer labels" },
  { id: "settings", label: "Settings", icon: "sliders", sub: "Preferences and about" },
];

export const NAV_SECTIONS: { label: string; items: ScreenId[] }[] = [
  { label: "Overview", items: ["dashboard"] },
  { label: "Money", items: ["accounts", "transactions", "categories"] },
  { label: "System", items: ["settings"] },
];
