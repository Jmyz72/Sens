import { beforeEach, describe, expect, it } from "vitest";
import { client } from "../client";

beforeEach(async () => {
  await client.resetApp();
});

const input = (name: string, apiKey: string | null = null) => ({ name, baseUrl: " https://x.test/v1/ ", model: " m ", apiKey });

describe("mock AI providers", () => {
  it("creates in order, trims, and never returns the key", async () => {
    const a = await client.createAiProvider(input(" Gemini ", "k1"));
    const b = await client.createAiProvider(input("Ollama", ""));
    expect(a).toMatchObject({ name: "Gemini", baseUrl: "https://x.test/v1", model: "m", hasKey: true, enabled: true, position: 0 });
    expect(b).toMatchObject({ hasKey: false, position: 1 });
    expect(JSON.stringify(await client.listAiProviders())).not.toContain("k1");
  });

  it("keeps the key on null and clears it on empty", async () => {
    const a = await client.createAiProvider(input("Gemini", "k1"));
    expect((await client.updateAiProvider(a.id, input("Gemini 2", null))).hasKey).toBe(true);
    expect((await client.updateAiProvider(a.id, input("Gemini 2", ""))).hasKey).toBe(false);
  });

  it("rejects duplicate names ignoring case and spaces, but allows renaming itself", async () => {
    const a = await client.createAiProvider(input("Gemini"));
    const dup = { code: "ValidationError", message: "An AI provider with that name already exists." };
    await expect(client.createAiProvider(input(" gemini "))).rejects.toMatchObject(dup);
    const b = await client.createAiProvider(input("OpenAI"));
    await expect(client.updateAiProvider(b.id, input("GEMINI"))).rejects.toMatchObject(dup);
    await expect(client.updateAiProvider(a.id, input("gemini"))).resolves.toMatchObject({ name: "gemini" });
  });

  it("validates name, base URL and model", async () => {
    const bad = (name: string, baseUrl: string, model: string) => client.createAiProvider({ name, baseUrl, model, apiKey: null });
    await expect(bad(" ", "https://x", "m")).rejects.toMatchObject({ code: "ValidationError", message: "Name cannot be empty" });
    await expect(bad("A", "ftp://x", "m")).rejects.toMatchObject({ code: "ValidationError", message: "The base URL must start with http:// or https://" });
    await expect(bad("A", "https://x", " ")).rejects.toMatchObject({ code: "ValidationError", message: "Model cannot be empty" });
  });

  it("returns NotFound for unknown ids", async () => {
    const nf = { code: "NotFound", message: "AI provider not found" };
    await expect(client.updateAiProvider("nope", input("A"))).rejects.toMatchObject(nf);
    await expect(client.setAiProviderEnabled("nope", false)).rejects.toMatchObject(nf);
    await expect(client.deleteAiProvider("nope")).rejects.toMatchObject(nf);
    await expect(client.testAiProvider("nope")).rejects.toMatchObject(nf);
  });

  it("closes the gap on delete and requires every id once to reorder", async () => {
    const ids: string[] = [];
    for (const n of ["A", "B", "C"]) ids.push((await client.createAiProvider(input(n))).id);
    await client.deleteAiProvider(ids[1]);
    expect((await client.listAiProviders()).map((p) => p.position)).toEqual([0, 1]);
    await client.reorderAiProviders([ids[2], ids[0]]);
    expect((await client.listAiProviders()).map((p) => p.name)).toEqual(["C", "A"]);
    const msg = { code: "ValidationError", message: "The order must list every AI provider exactly once." };
    for (const bad of [[ids[2]], [ids[2], ids[2]], [ids[2], ids[0], "x"], [ids[2], "x"]]) {
      await expect(client.reorderAiProviders(bad)).rejects.toMatchObject(msg);
    }
  });

  it("disabling keeps the position", async () => {
    const a = await client.createAiProvider(input("A"));
    await client.createAiProvider(input("B"));
    expect(await client.setAiProviderEnabled(a.id, false)).toMatchObject({ enabled: false, position: 0 });
  });

  it("factory reset removes every provider", async () => {
    await client.createAiProvider(input("A"));
    await client.resetApp();
    expect(await client.listAiProviders()).toEqual([]);
  });
});
