// Settings screen: appearance, dashboard preferences, and about.
// All colors via theme tokens; segmented control matches AddTransaction kind selector style.

import { useEffect, useState } from "react";
import { useTheme, useThemeMode } from "../theme/ThemeProvider";
import { hexA, ThemeMode } from "../theme/tokens";
import { Btn, Card, SectionTitle, Modal, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { useAppData } from "../store";
import { useToast } from "../components/Toast";
import type { AiProvider, McpAuditEntry, McpStatus } from "../types";
import { notifyMcpStatusChanged, onDataChanged } from "../lib/dataChanged";
import { formatLastChecked, updatePanelCopy, type useUpdater } from "../lib/updater";

// ─── Segmented control (reusable 2-option) ───────────────────────────────────

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; icon?: React.ReactNode }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const t = useTheme();
  return (
    <div style={{ display: "inline-flex", gap: 4, background: t.panel2, borderRadius: 9, padding: 3 }}>
      {options.map((opt) => {
        const on = opt.value === value;
        return (
          <button
            key={opt.value}
            className="sens-btn"
            onClick={() => onChange(opt.value)}
            style={{
              height: 32,
              padding: "0 14px",
              justifyContent: "center",
              borderRadius: 7,
              fontSize: 12.5,
              fontWeight: 600,
              color: on ? t.onAccent : t.dim,
              background: on ? t.accent : "transparent",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              boxShadow: on ? `0 1px 6px ${hexA(t.accent, 0.3)}` : "none",
              transition: "background .12s, color .12s, box-shadow .12s",
            }}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Toggle ──────────────────────────────────────────────────────────────────

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  const t = useTheme();
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      style={{
        width: 42,
        height: 24,
        borderRadius: 12,
        border: "none",
        background: on ? t.accent : t.panel3,
        position: "relative",
        cursor: "pointer",
        flexShrink: 0,
        transition: "background .15s",
        boxShadow: on ? `0 1px 6px ${hexA(t.accent, 0.3)}` : "none",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: on ? 21 : 3,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: on ? t.onAccent : t.dim,
          transition: "left .15s",
          display: "block",
        }}
      />
    </button>
  );
}

// ─── Row atom ────────────────────────────────────────────────────────────────

function SettingRow({ label, hint, right }: { label: string; hint?: string; right: React.ReactNode }) {
  const t = useTheme();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 0",
        gap: 16,
      }}
    >
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: t.text }}>{label}</div>
        {hint && <div style={{ fontSize: 12, color: t.faint, marginTop: 2 }}>{hint}</div>}
      </div>
      {right}
    </div>
  );
}

// ─── Divider ─────────────────────────────────────────────────────────────────

function Divider() {
  const t = useTheme();
  return <div style={{ height: 0.5, background: t.divider }} />;
}

// ─── Reset modal ─────────────────────────────────────────────────────────────

function ResetModal({ onClose }: { onClose: () => void }) {
  const t = useTheme();
  const { mode, toggle } = useThemeMode();
  const { reload } = useAppData();
  const { notify } = useToast();
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const armed = confirm.trim().toUpperCase() === "RESET";

  async function run() {
    if (!armed || busy) return;
    setBusy(true);
    try {
      await client.resetApp();
      // Reset client-only preferences to defaults.
      localStorage.removeItem("sens.sidebar");
      if (mode === "light") toggle(); // back to dark default
      await reload();
      notify("App reset to defaults", "info");
      onClose();
    } catch (e) {
      notify((e as { message?: string })?.message ?? "Reset failed", "error");
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} width={400}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, fontSize: 15, fontWeight: 700 }}>
        Reset app to defaults?
      </div>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 12.5, color: t.dim, lineHeight: 1.5 }}>
          This permanently deletes all accounts, transactions, and categories, then
          restores the default categories. Appearance and dashboard preferences are
          reset too. This cannot be undone.
        </div>
        <div>
          <div style={{ fontSize: 12, color: t.faint, marginBottom: 6 }}>
            Type <strong style={{ color: t.text, fontFamily: t.mono }}>RESET</strong> to confirm
          </div>
          <input className="sens-input" value={confirm} onChange={(e) => setConfirm(e.target.value)}
            placeholder="RESET" style={inputStyle(t)} autoFocus />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="outline" size="md" onClick={onClose}>Cancel</Btn>
          <Btn variant="danger" size="md" icon="trash" disabled={!armed || busy} onClick={run}>
            {busy ? "Resetting…" : "Reset everything"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

// ─── Settings screen ─────────────────────────────────────────────────────────

const AI_PRESETS: { label: string; name: string; baseUrl: string; model: string }[] = [
  { label: "Google AI Studio (Gemini)", name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash" },
  { label: "Ollama (local)", name: "Ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.1" },
  { label: "OpenAI", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
];

const errorMessage = (error: unknown, fallback: string) =>
  (error instanceof Error ? error.message : (error as { message?: string } | null)?.message) ?? fallback;

function AiProviderForm({ editing, onSaved, onCancel }: {
  editing: AiProvider | null;
  onSaved: (saved: AiProvider) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTheme();
  const { notify } = useToast();
  const [name, setName] = useState(editing?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
  const [model, setModel] = useState(editing?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const input = inputStyle(t);

  // A blank key keeps the saved one when editing; on create it means no key.
  const save = async (key: string | null = apiKey === "" ? null : apiKey): Promise<AiProvider | null> => {
    try {
      const fields = { name, baseUrl, model, apiKey: key };
      const saved = editing ? await client.updateAiProvider(editing.id, fields) : await client.createAiProvider(fields);
      await onSaved(saved);
      return saved;
    } catch (error) {
      notify(errorMessage(error, "Could not save"), "error");
      return null;
    }
  };

  const run = async (body: () => Promise<void>) => {
    setBusy(true);
    try {
      await body();
    } finally {
      setBusy(false);
    }
  };

  const saveAndTest = () => run(async () => {
    const saved = await save();
    if (!saved) return;
    try {
      await client.testAiProvider(saved.id);
      notify(`${saved.name} answered.`, "info");
      onCancel();
    } catch (error) {
      notify(errorMessage(error, "Connection failed"), "error");
    }
  });

  return (
    <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: t.panel2 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: t.text, marginBottom: 10 }}>
        {editing ? `Edit ${editing.name}` : "Add provider"}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {AI_PRESETS.map((p) => (
          <Btn key={p.label} variant="outline" size="sm" onClick={() => { setName(p.name); setBaseUrl(p.baseUrl); setModel(p.model); }}>
            {p.label}
          </Btn>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <label>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Name</div>
          <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Gemini free" />
        </label>
        <label>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Base URL</div>
          <input style={input} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" />
        </label>
        <label>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Model</div>
          <input style={input} value={model} onChange={(e) => setModel(e.target.value)} placeholder="model name" />
        </label>
        <label>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>API key {editing?.hasKey ? "(saved)" : "(optional for local)"}</div>
          <input
            style={input}
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={editing?.hasKey ? "Leave blank to keep the saved key" : "Paste a key"}
          />
        </label>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <Btn disabled={busy} onClick={() => void saveAndTest()}>{busy ? "Testing…" : "Save & test"}</Btn>
        <Btn variant="outline" disabled={busy} onClick={() => void run(async () => { if (await save()) onCancel(); })}>Save</Btn>
        {editing?.hasKey && (
          <Btn variant="danger" disabled={busy} onClick={() => void run(async () => { if (await save("")) notify("Key removed.", "info"); })}>
            Remove key
          </Btn>
        )}
        <Btn variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Btn>
      </div>
    </div>
  );
}

function CopyBox({ text, label }: { text: string; label: string }) {
  const t = useTheme();
  const { notify } = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      notify("Copied.", "info");
    } catch {
      notify("Could not copy. Select the text and copy it manually.", "error");
    }
  };
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
      <input
        readOnly
        aria-label={label}
        value={text}
        onFocus={(e) => e.currentTarget.select()}
        style={{ ...inputStyle(t), flex: 1, fontFamily: t.mono, fontSize: 12 }}
      />
      <Btn variant="outline" icon="copy" onClick={() => void copy()}>Copy</Btn>
    </div>
  );
}

function AssistantCard() {
  const t = useTheme();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [portText, setPortText] = useState("8765");
  const [audit, setAudit] = useState<McpAuditEntry[]>([]);
  // The plaintext token lives only in this state; it is never persisted.
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const [s, a] = await Promise.all([client.getMcpStatus(), client.listMcpAudit(50)]);
    setStatus(s);
    setAudit(a);
  };

  useEffect(() => {
    let alive = true;
    client.getMcpStatus().then((s) => {
      if (alive) { setStatus(s); setPortText(String(s.port)); }
    }).catch(() => {});
    client.listMcpAudit(50).then((a) => { if (alive) setAudit(a); }).catch(() => {});
    const off = onDataChanged(() => {
      client.listMcpAudit(50).then((a) => { if (alive) setAudit(a); }).catch(() => {});
    });
    return () => { alive = false; off(); };
  }, []);

  const act = async (body: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await body();
    } catch (e) {
      setError(errorMessage(e, fallback));
    } finally {
      await refresh().catch(() => {});
      notifyMcpStatusChanged();
      setBusy(false);
    }
  };

  const parsedPort = Number(portText);
  const portValid = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535;
  const enabled = status?.enabled ?? false;
  const savedPort = status?.port ?? 8765;
  const portDirty = status !== null && portText.trim() !== String(savedPort);

  const applyPort = (nextEnabled: boolean) => {
    if (!portValid) { setError("Port must be a whole number between 1 and 65535."); return; }
    void act(async () => { await client.setMcpEnabled(nextEnabled, parsedPort); }, "Could not update the assistant");
  };

  const rotate = () => {
    if (status?.hasToken && !window.confirm("Rotate the token? The connected agent will be signed out until you give it the new one.")) return;
    void act(async () => { setToken(await client.rotateMcpToken()); }, "Could not generate a token");
  };

  const running = status?.running ?? false;
  const statusIcon = running ? "check" : status?.error ? "alertCircle" : "info";
  const statusColor = running ? t.income : status?.error ? t.negative : t.dim;
  const statusText = running
    ? `Running on 127.0.0.1:${status?.port}`
    : status?.error
      ? `Not running: ${status.error}`
      : "Stopped";

  return (
    <Card>
      <SectionTitle sub="Let an AI agent you trust read and edit your finances over MCP, through your own Tailscale tailnet. Nothing is exposed to the public internet.">
        Assistant (MCP)
      </SectionTitle>
      <SettingRow
        label="Enable assistant server"
        hint="Runs a local server on 127.0.0.1 that your agent reaches through Tailscale."
        right={<Toggle on={enabled} label="Enable assistant server" onChange={(v) => { if (!busy) applyPort(v); }} />}
      />
      <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: statusColor, paddingBottom: 10 }}>
        <Icon name={statusIcon} size={15} color={statusColor} />
        <span>{statusText}</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0 12px" }}>
        <label htmlFor="mcp-port" style={{ fontSize: 13.5, fontWeight: 500, color: t.text }}>Port</label>
        <input
          id="mcp-port"
          type="number"
          min={1}
          max={65535}
          value={portText}
          onChange={(e) => setPortText(e.target.value)}
          style={{ ...inputStyle(t), width: 110 }}
        />
        {portDirty && (
          <Btn variant="outline" size="sm" disabled={busy} onClick={() => applyPort(enabled)}>Apply port</Btn>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: 12 }}>
        <div>
          <Btn variant="outline" icon="restore" disabled={busy} onClick={rotate}>Generate / rotate token</Btn>
        </div>
        {token && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 10, borderRadius: 9, border: `0.5px solid ${t.border}`, background: t.panel2 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 600, color: t.text }}>
              <Icon name="alertCircle" size={15} color={t.dim} />
              Copy this token now. It will not be shown again.
            </div>
            <CopyBox text={token} label="Assistant token" />
            <div style={{ fontSize: 12, color: t.faint }}>
              Rotating the token signs out the connected agent. Give it the new token as <span style={{ fontFamily: t.mono }}>Authorization: Bearer &lt;token&gt;</span>.
            </div>
            <div>
              <Btn variant="ghost" size="sm" onClick={() => setToken(null)}>I have copied it</Btn>
            </div>
          </div>
        )}
        {!token && status && !status.hasToken && (
          <div style={{ fontSize: 12, color: t.faint }}>No token yet. Generate one before enabling the server.</div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 12 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: t.text }}>Expose it on your tailnet</div>
        <CopyBox text={`tailscale serve --bg --https=443 http://127.0.0.1:${savedPort}`} label="Tailscale serve command" />
        <div style={{ fontSize: 12, color: t.faint }}>
          Your agent connects to <span style={{ fontFamily: t.mono }}>https://&lt;your-machine&gt;.&lt;your-tailnet&gt;.ts.net/mcp</span> and must send <span style={{ fontFamily: t.mono }}>Authorization: Bearer &lt;token&gt;</span>.
        </div>
      </div>

      {error && (
        <div role="alert" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.negative, paddingBottom: 10 }}>
          <Icon name="alertCircle" size={15} color={t.negative} />
          <span>{error}</span>
        </div>
      )}

      <div style={{ fontSize: 13.5, fontWeight: 500, color: t.text, marginBottom: 6 }}>Recent agent activity</div>
      {audit.length === 0 ? (
        <div style={{ fontSize: 12.5, color: t.dim }}>No agent activity yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 260, overflowY: "auto" }}>
          {audit.map((r) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, padding: "5px 8px", borderRadius: 7, background: t.panel2 }}>
              <span style={{ color: t.faint, width: 150, flexShrink: 0 }}>{new Date(r.at).toLocaleString()}</span>
              <span style={{ fontFamily: t.mono, color: t.text, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.tool}</span>
              <span style={{ color: t.dim, flexShrink: 0 }}>{r.tailscaleUser ?? "tagged device"}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, width: 70, color: r.ok ? t.income : t.negative }}>
                <Icon name={r.ok ? "check" : "close"} size={13} color={r.ok ? t.income : t.negative} />
                {r.ok ? "OK" : "Failed"}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function AiImportCard() {
  const t = useTheme();
  const { notify } = useToast();
  const [providers, setProviders] = useState<AiProvider[] | null>(null);
  const [editing, setEditing] = useState<AiProvider | "new" | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const refresh = async () => {
    setProviders(await client.listAiProviders());
  };

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  const act = async (body: () => Promise<unknown>, fallback: string) => {
    try {
      await body();
    } catch (error) {
      notify(errorMessage(error, fallback), "error");
    }
    await refresh().catch(() => {});
  };

  const list = providers ?? [];

  const move = (from: number, to: number) => {
    if (to < 0 || to >= list.length || from === to) return;
    const ids = list.map((p) => p.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    void act(() => client.reorderAiProviders(ids), "Could not reorder");
  };

  const test = async (p: AiProvider) => {
    setTestingId(p.id);
    try {
      await client.testAiProvider(p.id);
      notify(`${p.name} answered.`, "info");
    } catch (error) {
      notify(errorMessage(error, "Connection failed"), "error");
    } finally {
      setTestingId(null);
    }
  };

  const remove = (p: AiProvider) => {
    if (!window.confirm(`Delete ${p.name}? Its key is removed too.`)) return;
    if (editing !== null && editing !== "new" && editing.id === p.id) setEditing(null);
    void act(() => client.deleteAiProvider(p.id), "Could not delete");
  };

  return (
    <Card>
      <SectionTitle sub="Used by Drafts to turn the text in a photo into transactions. Any OpenAI-compatible chat endpoint works.">
        AI import
      </SectionTitle>
      <div style={{ fontSize: 12.5, color: t.dim, marginBottom: 10 }}>
        Drafts tries these in order and falls back to the next one if a call fails.
      </div>
      {providers && list.length === 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim, padding: "8px 0" }}>
          <Icon name="info" size={15} color={t.dim} />
          No AI providers yet. Add one to use photo import.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {list.map((p, i) => (
          <div
            key={p.id}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const from = list.findIndex((x) => x.id === e.dataTransfer.getData("text/plain"));
              if (from >= 0) move(from, i);
            }}
            style={{
              display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 9,
              border: `0.5px solid ${t.border}`, background: t.panel2,
            }}
          >
            <span
              draggable
              onDragStart={(e) => e.dataTransfer.setData("text/plain", p.id)}
              title="Drag to reorder"
              style={{ cursor: "grab", color: t.faint, userSelect: "none", fontSize: 14, lineHeight: 1 }}
            >
              ⋮⋮
            </span>
            <span style={{ width: 18, fontFamily: t.mono, fontSize: 12, color: t.faint }}>{i + 1}</span>
            <div style={{ flex: 1, minWidth: 0, opacity: p.enabled ? 1 : 0.55 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500, color: t.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
              <div style={{ fontSize: 12, color: t.faint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.model} · {p.hasKey ? "key saved" : "no key"}
              </div>
            </div>
            <span style={{ fontSize: 11.5, color: t.dim, width: 22 }}>{p.enabled ? "On" : "Off"}</span>
            <Toggle
              on={p.enabled}
              label={`Use ${p.name}`}
              onChange={(v) => void act(() => client.setAiProviderEnabled(p.id, v), "Could not update")}
            />
            <div style={{ display: "flex", gap: 4 }}>
              <button className="sens-icon-btn" aria-label={`Move ${p.name} up`} disabled={i === 0} onClick={() => move(i, i - 1)}
                style={{ width: 26, height: 26, color: t.dim, opacity: i === 0 ? 0.35 : 1 }}>↑</button>
              <button className="sens-icon-btn" aria-label={`Move ${p.name} down`} disabled={i === list.length - 1} onClick={() => move(i, i + 1)}
                style={{ width: 26, height: 26, color: t.dim, opacity: i === list.length - 1 ? 0.35 : 1 }}>↓</button>
            </div>
            <Btn variant="outline" size="sm" disabled={testingId !== null} onClick={() => void test(p)}>
              {testingId === p.id ? "Testing…" : "Test"}
            </Btn>
            <Btn variant="ghost" size="sm" onClick={() => setEditing(p)}>Edit</Btn>
            <button className="sens-icon-btn" aria-label={`Delete ${p.name}`} title="Delete" onClick={() => remove(p)}
              style={{ width: 28, height: 28, color: t.dim }}>
              <Icon name="trash" size={15} color="currentColor" />
            </button>
          </div>
        ))}
      </div>
      {editing === null ? (
        <div style={{ marginTop: 12 }}>
          <Btn variant="outline" icon="plus" onClick={() => setEditing("new")}>Add provider</Btn>
        </div>
      ) : (
        <AiProviderForm
          key={editing === "new" ? "new" : editing.id}
          editing={editing === "new" ? null : editing}
          // Always continue on the saved row, so a retry after a failed test updates it instead of creating a duplicate.
          onSaved={async (saved) => { setEditing(saved); await refresh(); }}
          onCancel={() => setEditing(null)}
        />
      )}
      <div style={{ fontSize: 12, color: t.faint, marginTop: 10 }}>
        The key is stored unencrypted in Sens's local database and is never shown again. Anything you send to a cloud provider leaves this computer.
      </div>
    </Card>
  );
}

export function Settings({ updater }: { updater: ReturnType<typeof useUpdater> }) {
  const t = useTheme();
  const { mode, toggle } = useThemeMode();

  // remember_month preference — tri-state: null = loading, then boolean
  const [rememberMonth, setRememberMonth] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  useEffect(() => {
    client
      .getSetting("remember_month")
      .then((v) => {
        setRememberMonth(v === "1");
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  function handleRememberToggle(val: boolean) {
    setRememberMonth(val);
    client.setSetting("remember_month", val ? "1" : "0").catch(() => {});
  }

  // bulk_action_preview preference — default on (unset = on)
  const [bulkPreview, setBulkPreview] = useState(true);
  const [bulkPreviewLoaded, setBulkPreviewLoaded] = useState(false);

  useEffect(() => {
    client
      .getSetting("bulk_action_preview")
      .then((v) => {
        setBulkPreview(v !== "0");
        setBulkPreviewLoaded(true);
      })
      .catch(() => setBulkPreviewLoaded(true));
  }, []);

  function handleBulkPreviewToggle(val: boolean) {
    setBulkPreview(val);
    client.setSetting("bulk_action_preview", val ? "1" : "0").catch(() => {});
  }

  // transaction_time_enabled preference — default on (unset = on)
  const [timeEnabled, setTimeEnabled] = useState(true);
  const [timeLoaded, setTimeLoaded] = useState(false);

  useEffect(() => {
    client
      .getSetting("transaction_time_enabled")
      .then((v) => {
        setTimeEnabled(v !== "0");
        setTimeLoaded(true);
      })
      .catch(() => setTimeLoaded(true));
  }, []);

  function handleTimeToggle(val: boolean) {
    setTimeEnabled(val);
    client.setSetting("transaction_time_enabled", val ? "1" : "0").catch(() => {});
  }

  const themeOptions: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
    {
      value: "dark",
      label: "Dark",
      icon: <Icon name="moon" size={14} color="currentColor" stroke={1.9} />,
    },
    {
      value: "light",
      label: "Light",
      icon: <Icon name="sun" size={14} color="currentColor" stroke={1.9} />,
    },
  ];

  function handleThemeChange(val: ThemeMode) {
    if (val !== mode) toggle();
  }

  const updateCopy = updatePanelCopy({
    isDesktop: updater.desktop,
    ...updater.state,
  });
  const updateBusy = updater.state.status === "checking" || updater.state.status === "downloading";
  const canInstall = updater.desktop && updater.state.status === "available";
  const updateTone =
    updateCopy.tone === "error"
      ? t.expense
      : updateCopy.tone === "success"
        ? t.income
        : updateCopy.tone === "accent"
          ? t.accent
          : t.dim;

  return (
    <div className="sens-screen" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Appearance */}
      <Card>
        <SectionTitle>Appearance</SectionTitle>
        <SettingRow
          label="Theme"
          hint="Choose between dark and light mode"
          right={
            <SegmentedControl
              options={themeOptions}
              value={mode}
              onChange={handleThemeChange}
            />
          }
        />
      </Card>

      {/* Dashboard */}
      <Card>
        <SectionTitle>Dashboard</SectionTitle>
        <SettingRow
          label="Remember last viewed month"
          hint="When on, the dashboard opens on the last month you viewed"
          right={
            loaded ? (
              <Toggle on={rememberMonth} onChange={handleRememberToggle} />
            ) : (
              <div style={{ width: 42, height: 24, borderRadius: 12, background: t.panel3 }} />
            )
          }
        />
      </Card>

      {/* Transactions */}
      <Card>
        <SectionTitle>Transactions</SectionTitle>
        <SettingRow
          label="Preview bulk actions"
          hint="Show a confirmation sheet listing which transactions will change before re-categorizing, moving, excluding, or deleting in bulk."
          right={
            bulkPreviewLoaded ? (
              <Toggle on={bulkPreview} onChange={handleBulkPreviewToggle} />
            ) : (
              <div style={{ width: 42, height: 24, borderRadius: 12, background: t.panel3 }} />
            )
          }
        />
        <SettingRow
          label="Record transaction times"
          hint="Show a required time-of-day field when adding or editing transactions, and sort same-day transactions chronologically."
          right={
            timeLoaded ? (
              <Toggle on={timeEnabled} onChange={handleTimeToggle} />
            ) : (
              <div style={{ width: 42, height: 24, borderRadius: 12, background: t.panel3 }} />
            )
          }
        />
      </Card>

      <AiImportCard />

      <AssistantCard />

      {/* About */}
      <Card>
        <SectionTitle>About</SectionTitle>
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          <SettingRow label="App" right={<span style={{ fontSize: 13, color: t.dim, fontWeight: 500 }}>Sens</span>} />
          <Divider />
          <SettingRow
            label="Description"
            right={<span style={{ fontSize: 13, color: t.dim, fontWeight: 500 }}>Local-first personal finance</span>}
          />
          <Divider />
          <SettingRow
            label="Currency"
            right={<span style={{ fontSize: 13, color: t.dim, fontWeight: 500, fontFamily: t.mono }}>MYR</span>}
          />
          <Divider />
          <SettingRow
            label="Version"
            right={<span style={{ fontSize: 13, color: t.faint, fontFamily: t.mono }}>{__APP_VERSION__}</span>}
          />
          <Divider />
          <div style={{ paddingTop: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                <div style={{ width: 26, height: 26, borderRadius: 8, background: hexA(updateTone, 0.14), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Icon name={updateCopy.tone === "error" ? "alertCircle" : "arrowDown"} size={15} color={updateTone} stroke={2} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 650, color: t.text }}>{updateCopy.title}</div>
                  <div style={{ fontSize: 12, color: t.faint, marginTop: 2 }}>{updateCopy.detail}</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                {canInstall ? (
                  <Btn size="sm" icon="arrowDown" onClick={updater.installUpdate}>
                    {updateCopy.primaryAction}
                  </Btn>
                ) : (
                  <Btn
                    size="sm"
                    variant="outline"
                    icon="restore"
                    onClick={updater.checkForUpdates}
                    disabled={!updater.desktop || updateBusy}
                  >
                    {updateCopy.primaryAction}
                  </Btn>
                )}
              </div>
            </div>
            {updater.state.status === "downloading" && updater.state.downloadProgress !== null && (
              <div style={{ height: 5, borderRadius: 999, background: t.panel2, overflow: "hidden", marginBottom: 9 }}>
                <div style={{ height: "100%", width: `${updater.state.downloadProgress}%`, background: t.accent }} />
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: t.faint, fontSize: 11.5 }}>
              <span>Last checked</span>
              <span style={{ fontFamily: t.mono }}>{formatLastChecked(updater.state.lastCheckedAt)}</span>
            </div>
          </div>
        </div>
      </Card>

      {/* Danger zone */}
      <Card>
        <SectionTitle>Danger zone</SectionTitle>
        <SettingRow
          label="Reset app to defaults"
          hint="Erase all data and restore the default categories"
          right={
            <Btn variant="danger" size="md" icon="trash" onClick={() => setResetOpen(true)}>
              Reset
            </Btn>
          }
        />
      </Card>

      {resetOpen && <ResetModal onClose={() => setResetOpen(false)} />}
    </div>
  );
}
