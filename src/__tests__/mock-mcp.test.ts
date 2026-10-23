import { beforeEach, describe, expect, it } from "vitest";
import { client } from "../client";
import { onDataChanged } from "../lib/dataChanged";

beforeEach(async () => {
  await client.resetApp();
});

describe("mock MCP", () => {
  it("status_defaults_off_without_token", async () => {
    expect(await client.getMcpStatus()).toEqual({ enabled: false, port: 8765, running: false, hasToken: false, error: null });
  });

  it("rotate_returns_token_and_sets_hasToken", async () => {
    const token = await client.rotateMcpToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await client.getMcpStatus()).hasToken).toBe(true);
    expect(await client.rotateMcpToken()).not.toBe(token);
  });

  it("enable_without_token_throws_ValidationError", async () => {
    await expect(client.setMcpEnabled(true)).rejects.toMatchObject({ code: "ValidationError", message: "Generate a token first." });
  });

  it("enable_and_disable_toggle_running", async () => {
    await client.rotateMcpToken();
    expect(await client.setMcpEnabled(true, 9000)).toMatchObject({ enabled: true, running: true, port: 9000 });
    expect(await client.setMcpEnabled(false)).toMatchObject({ enabled: false, running: false, port: 9000 });
  });

  it("invalid_port_throws_ValidationError", async () => {
    await client.rotateMcpToken();
    for (const port of [0, 65536, 1.5, -1]) {
      await expect(client.setMcpEnabled(true, port)).rejects.toMatchObject({ code: "ValidationError" });
    }
  });

  it("list_audit_is_empty_array", async () => {
    expect(await client.listMcpAudit()).toEqual([]);
    expect(await client.listMcpAudit(50)).toEqual([]);
  });

  it("resetApp_clears_mcp_state", async () => {
    await client.rotateMcpToken();
    await client.setMcpEnabled(true, 9000);
    await client.resetApp();
    expect(await client.getMcpStatus()).toEqual({ enabled: false, port: 8765, running: false, hasToken: false, error: null });
  });

  it("onDataChanged is a safe no-op in the browser", () => {
    const off = onDataChanged(() => {});
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
  });
});
