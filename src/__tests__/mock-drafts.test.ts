import { beforeEach, describe, expect, it } from "vitest";
import { client } from "../client";

beforeEach(async () => {
  await client.resetApp();
  await client.setSetting("transaction_time_enabled", "0");
});

async function configureAi() {
  await client.setAiSettings({ baseUrl: "http://localhost:11434/v1", model: "llava", apiKey: null });
}

describe("mock photo import", () => {
  it("reads text from raw image bytes", async () => {
    const text = await client.ocrImage(new Uint8Array([1, 2, 3]));
    expect(text).toContain("Total RM 12.50");
  });

  it("rejects empty image bytes", async () => {
    await expect(client.ocrImage(new Uint8Array())).rejects.toMatchObject({ code: "ocr_empty" });
  });

  it("refuses to extract until AI is configured", async () => {
    await expect(client.extractDrafts("a.png", "text")).rejects.toMatchObject({ code: "ai_not_configured" });
  });

  it("creates drafts, edits them, and confirms them into transactions", async () => {
    await client.createAccount("Maybank Savings", "savings", 0, null);
    await configureAi();
    const created = await client.extractDrafts("receipt.png", "text");
    expect(created).toHaveLength(1);
    expect(created[0].fields.kind).toBe("expense");
    expect(created[0].problems).toEqual([]);

    const edited = await client.updateImportDraft(created[0].id, { ...created[0].fields, note: "Edited note" });
    expect(edited.fields.hints).toEqual([]);

    const result = await client.confirmImportDrafts([created[0].id]);
    expect(result.confirmed).toBe(1);
    expect(await client.listImportDrafts()).toHaveLength(0);
    const txns = await client.listTransactions({});
    expect(txns.some((t) => t.description === "Edited note" && t.amountCents === 1250)).toBe(true);
  });

  it("keeps a draft with problems and reports it as failed", async () => {
    await configureAi();
    const created = await client.extractDrafts("receipt.png", "text"); // no accounts yet
    expect(created[0].problems).toContain("account");
    const result = await client.confirmImportDrafts([created[0].id]);
    expect(result.confirmed).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(await client.listImportDrafts()).toHaveLength(1);
  });

  it("adds a transfer draft when there are two accounts", async () => {
    await client.createAccount("A", "savings", 0, null);
    await client.createAccount("B", "savings", 0, null);
    await configureAi();
    const created = await client.extractDrafts("s.png", "text");
    expect(created.map((d) => d.fields.kind)).toEqual(["expense", "transfer"]);
    expect(created[1].fields.toAccountId).not.toBe(created[1].fields.accountId);
  });

  it("discards drafts", async () => {
    await configureAi();
    const created = await client.extractDrafts("s.png", "text");
    await client.discardImportDrafts([created[0].id]);
    expect(await client.listImportDrafts()).toHaveLength(0);
  });

  it("flags a transfer to the same account", async () => {
    await client.createAccount("A", "savings", 0, null);
    await client.createAccount("B", "savings", 0, null);
    await configureAi();
    const created = await client.extractDrafts("s.png", "text");
    const t = created[1];
    const same = await client.updateImportDraft(t.id, { ...t.fields, toAccountId: t.fields.accountId });
    expect(same.problems).toContain("to_account");
  });

  it("keeps the API key write-only", async () => {
    const saved = await client.setAiSettings({ baseUrl: "http://x.test/v1/", model: "m", apiKey: "secret" });
    expect(saved).toEqual({ baseUrl: "http://x.test/v1", model: "m", hasKey: true });
    await expect(client.getSetting("ai_api_key")).rejects.toMatchObject({ code: "ValidationError" });
    const kept = await client.setAiSettings({ baseUrl: "http://x.test/v1", model: "m", apiKey: null });
    expect(kept.hasKey).toBe(true);
    const cleared = await client.setAiSettings({ baseUrl: "http://x.test/v1", model: "m", apiKey: "" });
    expect(cleared.hasKey).toBe(false);
  });

  it("rejects a base URL without http(s)", async () => {
    await expect(client.setAiSettings({ baseUrl: "ftp://x", model: "m", apiKey: null })).rejects.toMatchObject({ code: "ValidationError" });
  });

  it("clears drafts on factory reset", async () => {
    await configureAi();
    await client.extractDrafts("s.png", "text");
    await client.resetApp();
    expect(await client.listImportDrafts()).toHaveLength(0);
  });
});
