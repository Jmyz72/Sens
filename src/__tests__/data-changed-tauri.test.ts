import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ resolveListen: (_fn: () => void) => {} }));
const listen = vi.hoisted(() => vi.fn(() => new Promise<() => void>((res) => { h.resolveListen = res; })));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("onDataChanged in Tauri", () => {
  it("unlistens once listen resolves after unsubscribe", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const { onDataChanged } = await import("../lib/dataChanged");
    const off = onDataChanged(() => {});
    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    off();
    const unlisten = vi.fn();
    h.resolveListen(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("unlistens on unsubscribe after listen resolved", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const { onDataChanged } = await import("../lib/dataChanged");
    listen.mockClear();
    const off = onDataChanged(() => {});
    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    const unlisten = vi.fn();
    h.resolveListen(unlisten);
    await new Promise((r) => setTimeout(r, 0));
    off();
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
