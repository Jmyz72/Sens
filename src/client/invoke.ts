// Dispatches a command to the Tauri backend when available, otherwise to the
// in-memory mock. This is the single seam between "real app" and "browser dev".

import { mockInvoke } from "./mock";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function dispatch<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }
  return mockInvoke<T>(command, args ?? {});
}
