// Create an account in two steps: (1) pick a provider (branding only) or Custom,
// (2) choose type + subtype (independent of the provider), name, and balance.
// Only `subtype` is persisted — the type cards are UI that filters subtype chips.
// For owe-group subtypes the balance field is "Amount owed" and is stored negative.

import { useEffect, useMemo, useState } from "react";
import type { AccountSubtype, AccountTemplate } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, Modal, inputStyle } from "../components/ui";
import { ProviderLogo } from "../components/ProviderLogo";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { parseAmountToCents } from "../lib/format";
import { TYPE_LABEL, TYPE_ORDER } from "../lib/accounts";

const TYPE_EMOJI: Record<string, string> = {
  fund: "💵", financial: "📈", receivable: "🤝", payable: "📄", credit: "💳",
};

export function AddAccount({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTheme();
  const [templates, setTemplates] = useState<AccountTemplate[]>([]);
  const [subtypes, setSubtypes] = useState<AccountSubtype[]>([]);
  const [step, setStep] = useState<1 | 2>(1);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<AccountTemplate | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("fund");
  const [subtype, setSubtype] = useState<string>("savings");
  const [opening, setOpening] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { client.listAccountTemplates().then(setTemplates).catch(() => {}); }, []);
  useEffect(() => { client.listAccountSubtypes().then(setSubtypes).catch(() => {}); }, []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, AccountTemplate[]>();
    templates.filter((x) => !q || x.name.toLowerCase().includes(q)).forEach((x) => {
      if (!map.has(x.groupName)) map.set(x.groupName, []);
      map.get(x.groupName)!.push(x);
    });
    return [...map.entries()];
  }, [templates, query]);

  const subtypesForType = useMemo(
    () => subtypes.filter((s) => s.type === type).sort((a, b) => a.sortOrder - b.sortOrder),
    [subtypes, type],
  );
  const currentSubtype = subtypes.find((s) => s.key === subtype);
  const isOwe = currentSubtype?.group === "owe";

  // Keep subtype valid when the chosen type changes.
  useEffect(() => {
    if (subtypesForType.length && !subtypesForType.some((s) => s.key === subtype)) {
      setSubtype(subtypesForType[0].key);
    }
  }, [subtypesForType, subtype]);

  function chooseProvider(tpl: AccountTemplate) {
    setProvider(tpl);
    if (!name) setName(tpl.name); // provider pre-fills the name; user can edit
    setStep(2);
  }
  function chooseCustom() {
    setProvider(null);
    setStep(2);
  }

  const openingCents = opening ? parseAmountToCents(opening) ?? 0 : 0;
  const signedOpening = isOwe ? -openingCents : openingCents;
  const canCreate = name.trim().length > 0 && !!currentSubtype;

  async function submit() {
    if (!canCreate) return;
    setBusy(true); setError(null);
    try {
      await client.createAccount(name.trim(), subtype, signedOpening, provider?.key ?? null);
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Could not create account");
    } finally { setBusy(false); }
  }

  const tileBtn = (on: boolean) => ({
    flexDirection: "column" as const, gap: 6, padding: "11px 4px", height: "auto",
    borderRadius: 11, fontWeight: 600, textAlign: "center" as const,
    color: on ? t.text : t.dim,
    background: on ? t.accentSoft : t.panel2,
    border: `0.5px solid ${on ? hexA(t.accent, 0.5) : t.border}`,
  });

  return (
    <Modal onClose={onClose} width={460}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>New account</span>
        <span style={{ fontSize: 11.5, color: t.faint }}>Step {step} of 2 · {step === 1 ? "Provider" : "Details"}</span>
      </div>

      {step === 1 ? (
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, height: 36, padding: "0 12px", background: t.panel2, border: `0.5px solid ${t.border}`, borderRadius: 9 }}>
            <Icon name="search" size={15} color={t.faint} />
            <input className="sens-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search banks, e-wallets, brokers…" autoFocus
              style={{ flex: 1, background: "transparent", border: "none", color: t.text, fontSize: 13, fontFamily: t.font }} />
          </div>
          <div style={{ maxHeight: 340, overflow: "auto", display: "flex", flexDirection: "column", gap: 14, margin: "0 -4px", padding: "0 4px" }}>
            {groups.map(([group, items]) => (
              <div key={group}>
                <div style={{ fontSize: 11, fontWeight: 700, color: t.faint, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{group}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  {items.map((tpl) => (
                    <button key={tpl.key} className="sens-btn" onClick={() => chooseProvider(tpl)}
                      style={{ ...tileBtn(false), fontSize: 11 }}>
                      <ProviderLogo templateKey={tpl.key} name={tpl.name} size={38} radius={10} />
                      <span style={{ width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tpl.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: t.faint, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Other</div>
              <button className="sens-btn" onClick={chooseCustom}
                style={{ width: "100%", justifyContent: "center", gap: 8, height: 44, borderRadius: 11, fontSize: 12.5, fontWeight: 600, color: t.text, background: "transparent", border: `1px dashed ${t.border}` }}>
                <Icon name="plus" size={15} color={t.faint} /> Custom account
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 12px", background: t.panel2, border: `0.5px solid ${t.border}`, borderRadius: 11 }}>
            <ProviderLogo templateKey={provider?.key ?? null} name={provider?.name ?? "?"} size={34} radius={9} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>{provider?.name ?? "No provider"}</span>
            <button className="sens-btn sens-btn-ghost" onClick={() => setStep(1)}
              style={{ marginLeft: "auto", height: 26, padding: "0 8px", borderRadius: 7, fontSize: 11.5, fontWeight: 600, color: t.accent }}>
              Change provider
            </button>
          </div>

          <Field label="What kind of account?">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {TYPE_ORDER.map((x) => (
                <button key={x} className="sens-btn" onClick={() => setType(x)} style={{ ...tileBtn(type === x), fontSize: 10.5 }}>
                  <span style={{ fontSize: 17 }}>{TYPE_EMOJI[x]}</span>
                  <span style={{ width: "100%", lineHeight: 1.2 }}>{TYPE_LABEL[x]}</span>
                </button>
              ))}
            </div>
          </Field>

          <Field label="Subtype">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {subtypesForType.map((s) => {
                const on = subtype === s.key;
                return (
                  <button key={s.key} className="sens-btn" onClick={() => setSubtype(s.key)}
                    style={{ height: 30, padding: "0 12px", borderRadius: 8, fontSize: 12, fontWeight: 600,
                      color: on ? t.text : t.dim, background: on ? t.accentSoft : t.panel2,
                      border: `0.5px solid ${on ? hexA(t.accent, 0.5) : t.border}` }}>
                    {s.label}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="Account name">
            <input className="sens-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Everyday Savings" style={inputStyle(t)} />
          </Field>

          <Field label={isOwe ? "Amount owed (RM)" : "Opening balance (RM)"}>
            <input className="sens-input" value={opening} inputMode="decimal" placeholder="0.00"
              onChange={(e) => setOpening(e.target.value.replace(/[^0-9.]/g, ""))} style={{ ...inputStyle(t), fontFamily: t.mono }} />
          </Field>

          {error && <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>{error}</div>}

          <div style={{ display: "flex", gap: 10 }}>
            <Btn variant="outline" onClick={() => setStep(1)} style={{ flex: 1, justifyContent: "center", height: 38 }}>Back</Btn>
            <Btn variant="primary" onClick={submit} disabled={!canCreate || busy} style={{ flex: 1, justifyContent: "center", height: 38 }}>Create account</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}
