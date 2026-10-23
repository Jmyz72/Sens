// Subscribes to the backend's `data-changed` event (emitted after every agent
// write). No-op in the browser mock, which never emits.

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function onDataChanged(cb: () => void): () => void {
  if (!isTauri()) return () => {};
  let cancelled = false;
  let unlisten: (() => void) | null = null;
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen("data-changed", () => cb()))
    .then((fn) => {
      // Unsubscribed before the listener registered: clean up immediately.
      if (cancelled) fn();
      else unlisten = fn;
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}

/** Window event the Settings card fires after changing MCP state so the sidebar refreshes. */
export const MCP_STATUS_CHANGED = "sens:mcp-status-changed";

export function notifyMcpStatusChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(MCP_STATUS_CHANGED));
}
