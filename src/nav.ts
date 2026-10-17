// Shared navigation config for the shell (sidebar + top bar).

import type { IconName } from "./components/Icon";

export type ScreenId = "dashboard" | "plan" | "accounts" | "transactions" | "drafts" | "categories" | "settings";

export const NAV: { id: ScreenId; label: string; icon: IconName; sub: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "home", sub: "Your money at a glance" },
  { id: "plan", label: "Plan", icon: "plan", sub: "Budgets and savings goals" },
  { id: "accounts", label: "Accounts", icon: "wallet", sub: "All balances in one place" },
  { id: "transactions", label: "Transactions", icon: "list", sub: "Every ringgit in and out" },
  { id: "drafts", label: "Drafts", icon: "sparkle", sub: "Review photo imports before they post" },
  { id: "categories", label: "Categories", icon: "filter", sub: "Income, expense & transfer labels" },
  { id: "settings", label: "Settings", icon: "sliders", sub: "Preferences and about" },
];

export const NAV_SECTIONS: { label: string; items: ScreenId[] }[] = [
  { label: "Overview", items: ["dashboard", "plan"] },
  { label: "Money", items: ["accounts", "transactions", "drafts", "categories"] },
  { label: "System", items: ["settings"] },
];
