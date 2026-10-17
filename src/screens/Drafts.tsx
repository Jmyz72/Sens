// Drafts: upload or paste a photo, let the AI propose transactions, review and edit
// them, then confirm. Nothing is saved as a transaction until a draft is confirmed.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Account, AiSettings, Category, DraftFields, ImportDraft } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Btn, Card, Empty, SectionTitle, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { client } from "../client";
import { useAppData } from "../store";
import { categoryPickerItems } from "../lib/categories";
import { fmtMoney, parseAmountToCents } from "../lib/format";
import { useTimeSetting } from "../lib/useTimeSetting";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const PROBLEM_TEXT: Record<string, string> = {
  amount: "Enter an amount",
  date: "Enter a date",
  time: "Enter a time",
  account: "Choose an account",
  to_account: "Choose a different destination account",
  category: "Choose a category",
  kind: "Choose a kind",
};

const HINT_TEXT: Record<string, string> = {
  low_confidence: "The AI was unsure about this one",
  date_assumed: "No date found, so today was used",
  time_assumed: "No time found, so 00:00 was used",
  kind_assumed: "Kind was a guess",
  future_date: "This date is in the future",
  non_myr: "The amount may not be in MYR",
  unmatched_account: "Could not match an account",
  unmatched_category: "Could not match a category",
};

function messageOf(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : (error as { message?: string } | null)?.message) ?? fallback;
}

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

type Busy = "idle" | "reading" | "extracting";

export function Drafts({ onCountChange }: { onCountChange: (n: number) => void }) {
  const t = useTheme();
  const { accounts, categories, reload } = useAppData();
  const { notify } = useToast();
  const [timeEnabled] = useTimeSetting();
  const [drafts, setDrafts] = useState<ImportDraft[] | null>(null);
  const [ai, setAi] = useState<AiSettings | null>(null);
  const [busy, setBusy] = useState<Busy>("idle");
  const [lostText, setLostText] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const update = useCallback((next: ImportDraft[]) => {
    setDrafts(next);
    onCountChange(next.length);
  }, [onCountChange]);

  useEffect(() => {
    client.listImportDrafts().then(update).catch((e) => notify(messageOf(e, "Could not load drafts"), "error"));
    client.getAiSettings().then(setAi).catch(() => {});
  }, [update, notify]);

  const handleFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      notify("That file is not an image.", "error");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      notify("That image is larger than 20 MB.", "error");
      return;
    }
    if (ai && (ai.baseUrl.trim() === "" || ai.model.trim() === "")) {
      notify("Set an AI base URL and model in Settings → AI import first.", "error");
      return;
    }
    setLostText(null);
    let text = "";
    try {
      setBusy("reading");
      text = await client.ocrImage(new Uint8Array(await file.arrayBuffer()));
      setBusy("extracting");
      const created = await client.extractDrafts(file.name || "Pasted image", text);
      setDrafts((prev) => {
        const next = [...(prev ?? []), ...created];
        onCountChange(next.length);
        return next;
      });
      notify(created.length === 0 ? "No transactions found in that image." : `${created.length} draft${created.length === 1 ? "" : "s"} ready to review.`, "info");
    } catch (error) {
      if (text) setLostText(text);
      notify(messageOf(error, "Could not read that image"), "error");
    } finally {
      setBusy("idle");
    }
  }, [ai, notify, onCountChange]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = Array.from(event.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (file) {
        event.preventDefault();
        void handleFile(file);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [handleFile]);

  const replace = (draft: ImportDraft) => update((drafts ?? []).map((d) => (d.id === draft.id ? draft : d)));

  const confirm = async (ids: string[]) => {
    try {
      const result = await client.confirmImportDrafts(ids);
      update(await client.listImportDrafts());
      if (result.confirmed > 0) {
        reload();
        notify(`${result.confirmed} transaction${result.confirmed === 1 ? "" : "s"} added.`, "info");
      }
      for (const failure of result.failed) notify(failure.message, "error");
    } catch (error) {
      notify(messageOf(error, "Could not confirm"), "error");
    }
  };

  const discard = async (ids: string[]) => {
    try {
      await client.discardImportDrafts(ids);
      update(await client.listImportDrafts());
    } catch (error) {
      notify(messageOf(error, "Could not discard"), "error");
    }
  };

  const ready = (drafts ?? []).filter((d) => d.problems.length === 0);
  const configured = !!ai && ai.baseUrl !== "" && ai.model !== "";
  const cloud = !!ai && ai.baseUrl !== "" && !isLocalUrl(ai.baseUrl);

  return (
    <div className="sens-screen" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card>
        <SectionTitle sub="The text in the photo is read on this computer. Only that text, your account names and category names go to the AI provider you set in Settings.">
          Add from a photo
        </SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Btn icon="plus" disabled={busy !== "idle" || !configured} onClick={() => fileInput.current?.click()}>
            Choose photo
          </Btn>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void handleFile(file);
            }}
          />
          <span style={{ fontSize: 12.5, color: t.dim }}>
            {busy === "reading" && "Reading the text in your photo…"}
            {busy === "extracting" && "Asking the AI to find transactions…"}
            {busy === "idle" && "or paste a screenshot with Cmd/Ctrl+V"}
          </span>
        </div>
        {ai && !configured && (
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim }}>
            <Icon name="info" size={15} color={t.dim} />
            Set an AI base URL and model in Settings → AI import to use this.
          </div>
        )}
        {cloud && (
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim }}>
            <Icon name="info" size={15} color={t.dim} />
            Text from your photos is sent to {ai?.baseUrl}.
          </div>
        )}
      </Card>

      {lostText && (
        <Card>
          <SectionTitle sub="The AI step failed. You can copy this and add the transactions by hand.">Text read from the photo</SectionTitle>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12.5, color: t.dim, fontFamily: t.mono, userSelect: "text" }}>{lostText}</pre>
        </Card>
      )}

      {drafts === null ? (
        <Card>
          <Skeleton height={44} radius={8} />
        </Card>
      ) : drafts.length === 0 ? (
        <Card>
          <Empty icon="sparkle" title="No drafts" hint="Upload a receipt or a bank screenshot and the transactions it finds will appear here." />
        </Card>
      ) : (
        <Card>
          <SectionTitle
            sub={`${drafts.length} pending · ${ready.length} ready`}
            right={
              <div style={{ display: "flex", gap: 8 }}>
                <Btn variant="outline" size="sm" disabled={ready.length === 0} onClick={() => void confirm(ready.map((d) => d.id))}>
                  Confirm all ready
                </Btn>
                <Btn variant="danger" size="sm" onClick={() => void discard(drafts.map((d) => d.id))}>
                  Discard all
                </Btn>
              </div>
            }
          >
            Review drafts
          </SectionTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {drafts.map((d) => (
              <DraftRow
                key={d.id}
                draft={d}
                accounts={accounts}
                categories={categories}
                timeEnabled={timeEnabled}
                onSaved={replace}
                onConfirm={() => void confirm([d.id])}
                onDiscard={() => void discard([d.id])}
              />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function DraftRow({
  draft, accounts, categories, timeEnabled, onSaved, onConfirm, onDiscard,
}: {
  draft: ImportDraft;
  accounts: Account[];
  categories: Category[];
  timeEnabled: boolean;
  onSaved: (d: ImportDraft) => void;
  onConfirm: () => void;
  onDiscard: () => void;
}) {
  const t = useTheme();
  const { notify } = useToast();
  const [fields, setFields] = useState<DraftFields>(draft.fields);
  const [amountText, setAmountText] = useState(draft.fields.amountCents != null ? (draft.fields.amountCents / 100).toFixed(2) : "");
  const input = inputStyle(t);
  const activeAccounts = accounts.filter((a) => !a.isArchived);
  const kind = fields.kind;

  useEffect(() => {
    setFields(draft.fields);
    setAmountText(draft.fields.amountCents != null ? (draft.fields.amountCents / 100).toFixed(2) : "");
  }, [draft]);

  const save = async (next: DraftFields) => {
    try {
      onSaved(await client.updateImportDraft(draft.id, next));
    } catch (error) {
      notify(messageOf(error, "Could not save"), "error");
    }
  };

  // Edits are kept locally while typing and saved when a field loses focus or a select changes.
  const change = (patch: Partial<DraftFields>, saveNow = false) => {
    const next = { ...fields, ...patch };
    setFields(next);
    if (saveNow) void save(next);
  };

  const flagged = (problem: string) => draft.problems.includes(problem);
  const fieldStyle = (problem: string) => ({ ...input, ...(flagged(problem) ? { border: `1px solid ${t.negative}` } : {}) });

  return (
    <div style={{ border: `0.5px solid ${t.border}`, borderRadius: 12, padding: 14, background: t.panel2 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8 }}>
        <div style={{ fontSize: 12, color: t.faint }}>From {draft.sourceName}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn size="sm" icon="check" disabled={draft.problems.length > 0} onClick={onConfirm}>Confirm</Btn>
          <Btn size="sm" variant="ghost" icon="trash" onClick={onDiscard}>Discard</Btn>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <label>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Kind</div>
          <select style={fieldStyle("kind")} value={kind} onChange={(e) => change({ kind: e.target.value as DraftFields["kind"] }, true)}>
            <option value="expense">Expense</option>
            <option value="income">Income</option>
            <option value="transfer">Transfer</option>
          </select>
        </label>
        <label>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Date</div>
          <input style={fieldStyle("date")} type="date" value={fields.date ?? ""} onChange={(e) => change({ date: e.target.value || null })} onBlur={() => void save(fields)} />
        </label>
        {timeEnabled && (
          <label>
            <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Time</div>
            <input style={fieldStyle("time")} type="time" value={fields.time ?? ""} onChange={(e) => change({ time: e.target.value || null })} onBlur={() => void save(fields)} />
          </label>
        )}
        <label>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Amount (RM)</div>
          <input
            style={fieldStyle("amount")}
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            onBlur={() => {
              const cents = parseAmountToCents(amountText);
              const next = { ...fields, amountCents: cents };
              setFields(next);
              if (cents != null) setAmountText((cents / 100).toFixed(2));
              void save(next);
            }}
          />
        </label>
        <label>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>{kind === "transfer" ? "From account" : "Account"}</div>
          <select style={fieldStyle("account")} value={fields.accountId ?? ""} onChange={(e) => change({ accountId: e.target.value || null }, true)}>
            <option value="">Choose…</option>
            {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        {kind === "transfer" ? (
          <label>
            <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>To account</div>
            <select style={fieldStyle("to_account")} value={fields.toAccountId ?? ""} onChange={(e) => change({ toAccountId: e.target.value || null }, true)}>
              <option value="">Choose…</option>
              {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        ) : (
          <label>
            <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Category</div>
            <select style={fieldStyle("category")} value={fields.categoryId ?? ""} onChange={(e) => change({ categoryId: e.target.value || null }, true)}>
              <option value="">Choose…</option>
              {categoryPickerItems(categories, kind).map((c) => (
                <option key={c.id} value={c.id}>{c.depth === 1 ? "   " : ""}{c.emoji} {c.label}</option>
              ))}
            </select>
          </label>
        )}
        <label style={{ gridColumn: "1 / -1" }}>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Note</div>
          <input style={input} value={fields.note ?? ""} onChange={(e) => change({ note: e.target.value || null })} onBlur={() => void save(fields)} />
        </label>
      </div>

      {(draft.problems.length > 0 || draft.fields.hints.length > 0) && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
          {draft.problems.map((p) => (
            <div key={p} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: t.negative }}>
              <Icon name="alertCircle" size={14} color={t.negative} />
              Needs attention: {PROBLEM_TEXT[p] ?? p}
            </div>
          ))}
          {draft.fields.hints.map((h) => (
            <div key={h} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: t.dim }}>
              <Icon name="info" size={14} color={t.dim} />
              Check: {HINT_TEXT[h] ?? h}
            </div>
          ))}
        </div>
      )}

      {draft.problems.length === 0 && draft.fields.amountCents != null && (
        <div style={{ marginTop: 10, fontSize: 12, color: t.faint }}>
          Will add {kind === "transfer" ? "a transfer of" : kind === "income" ? "income of" : "an expense of"} {fmtMoney(draft.fields.amountCents, { cents: true })}.
        </div>
      )}
    </div>
  );
}
