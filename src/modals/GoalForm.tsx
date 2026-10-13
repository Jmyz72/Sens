// Create or edit one savings goal. Delete removes it immediately, with no
// confirm dialog. Eligible accounts are active cash, e-wallet, savings, and
// current accounts that do not already have a goal.

import { useState } from "react";
import type { Account, GoalWrite, PlanGoal } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Field, Modal, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { useAppData } from "../store";

const GOAL_SUBTYPES = new Set(["cash", "ewallet", "savings", "current"]);

/** Parse a typed amount into non-negative cents (allows 0). Null if blank/invalid. */
function parseMagnitude(input: string): number | null {
  const cleaned = input.replace(/[^0-9.]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function centsToField(cents: number): string {
  return (cents / 100).toFixed(2);
}

function thrownMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error && "message" in error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return fallback;
}

function eligibleAccounts(accounts: Account[], goals: PlanGoal[], keepId: string | null): Account[] {
  const taken = new Set(goals.map((g) => g.accountId));
  const list = accounts.filter((a) => !a.isArchived && GOAL_SUBTYPES.has(a.subtype) && !taken.has(a.id));
  if (keepId && !list.some((a) => a.id === keepId)) {
    const current = accounts.find((a) => a.id === keepId);
    if (current) list.push(current);
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

export function GoalForm({
  goals, editing, onClose,
}: {
  goals: PlanGoal[];
  editing: PlanGoal | null;
  onClose: () => void;
}) {
  const t = useTheme();
  const { accounts, reload } = useAppData();
  const options = eligibleAccounts(accounts, goals, editing?.accountId ?? null);
  const [name, setName] = useState(editing?.name ?? "");
  const [accountId, setAccountId] = useState(editing?.accountId ?? options[0]?.id ?? "");
  const [target, setTarget] = useState(editing ? centsToField(editing.targetCents) : "");
  const [date, setDate] = useState(editing?.targetDate ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetCents = parseMagnitude(target);
  const canSave = name.trim().length > 0 && accountId !== "" && targetCents != null && targetCents > 0 && !busy;

  async function save() {
    if (!canSave || targetCents == null) return;
    setBusy(true);
    setError(null);
    const input: GoalWrite = {
      name: name.trim(),
      accountId,
      targetCents,
      targetDate: date.trim() === "" ? null : date,
    };
    try {
      if (editing) await client.updateGoal({ ...input, id: editing.id });
      else await client.createGoal(input);
      await reload();
      onClose();
    } catch (e) {
      setError(thrownMessage(e, "Could not save the goal"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      await client.deleteGoal(editing.id);
      await reload();
      onClose();
    } catch (e) {
      setError(thrownMessage(e, "Could not delete the goal"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} width={420}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{editing ? "Edit goal" : "Add a goal"}</span>
        <button type="button" className="sens-icon-btn" onClick={onClose} style={{ width: 28, height: 28, color: t.dim }}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <form
        onSubmit={(e) => { e.preventDefault(); void save(); }}
        style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}
      >
        <Field label="Name">
          <input
            className="sens-input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            style={inputStyle(t)}
          />
        </Field>

        {options.length === 0 ? (
          <div style={{ fontSize: 12.5, color: t.dim }}>No cash, e-wallet, savings, or current account is free for a goal.</div>
        ) : (
          <Field label="Account">
            <select
              className="sens-input"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              style={{ ...inputStyle(t), appearance: "none", cursor: "pointer" }}
            >
              {options.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Target (RM)">
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 12, top: 10, fontSize: 13, color: t.faint, fontFamily: t.mono }}>RM</span>
            <input
              className="sens-input"
              value={target}
              inputMode="decimal"
              onChange={(e) => setTarget(e.target.value.replace(/[^0-9.]/g, ""))}
              style={{ ...inputStyle(t), fontFamily: t.mono, paddingLeft: 36 }}
            />
          </div>
        </Field>

        <Field label="Target date (optional)">
          <input
            className="sens-input"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{ ...inputStyle(t), colorScheme: t.mode }}
          />
        </Field>

        {error && (
          <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>{error}</div>
        )}

        <div style={{ display: "flex", gap: 10 }}>
          {editing && (
            <Btn variant="danger" onClick={() => void remove()} disabled={busy}>Delete</Btn>
          )}
          <div style={{ flex: 1 }} />
          <Btn variant="outline" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn type="submit" disabled={!canSave}>Save</Btn>
        </div>
      </form>
    </Modal>
  );
}
