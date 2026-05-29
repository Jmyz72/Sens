// Categories screen: list all categories grouped by kind (income / expense /
// transfer), with per-row edit and archive/restore actions. Matches the
// Accounts screen structure and reuses all shared UI atoms.

import { useEffect, useState } from "react";
import type { Category, CategoryKind } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Card, Empty, Field, GlyphTile, Modal, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { useAppData } from "../store";
import { useToast } from "../components/Toast";

// ── Preset colour palette (data constant, acceptable hardcoded hex) ─────────

const PALETTE = [
  "#33c9d6", // teal  (app accent)
  "#46d39a", // green
  "#5b8def", // blue
  "#a78bfa", // violet
  "#d9728f", // rose
  "#f0708c", // pink-red
  "#e0a13c", // amber
  "#5aa66d", // sage
  "#56b3c4", // sky
  "#9aa4b2", // slate
];

const KIND_LABELS: Record<CategoryKind, string> = {
  income: "Income",
  expense: "Expense",
  transfer: "Transfer",
};

const KIND_ICONS: Record<CategoryKind, import("../components/Icon").IconName> = {
  income: "arrowDown",
  expense: "arrowUp",
  transfer: "swap",
};

const KIND_ORDER: CategoryKind[] = ["income", "expense", "transfer"];

// ── Edit/Create modal ────────────────────────────────────────────────────────

interface CategoryFormProps {
  initial?: Category;
  defaultKind?: CategoryKind;
  onClose: () => void;
  onDone: () => void;
}

function CategoryForm({ initial, defaultKind = "expense", onClose, onDone }: CategoryFormProps) {
  const t = useTheme();
  const isEdit = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<CategoryKind>(initial?.kind ?? defaultKind);
  const [emoji, setEmoji] = useState(initial?.emoji ?? "");
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && emoji.trim().length > 0;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (isEdit) {
        await client.updateCategory({
          id: initial!.id,
          name: name.trim(),
          emoji: emoji.trim(),
          color: color ?? undefined,
        });
      } else {
        await client.createCategory(name.trim(), kind, emoji.trim(), color ?? undefined);
      }
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Could not save category");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} width={380}>
      {/* header */}
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{isEdit ? "Edit category" : "New category"}</span>
        <button className="sens-icon-btn" onClick={onClose} style={{ width: 28, height: 28, color: t.dim }}>
          <Icon name="close" size={16} />
        </button>
      </div>

      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Kind selector — only on create */}
        {!isEdit && (
          <Field label="Kind">
            <div style={{ display: "flex", gap: 6 }}>
              {KIND_ORDER.map((k) => {
                const on = kind === k;
                return (
                  <button key={k} className="sens-btn"
                    onClick={() => setKind(k)}
                    style={{
                      flex: 1, height: 34, borderRadius: 8, fontSize: 12.5, fontWeight: 600,
                      color: on ? t.onAccent : t.dim,
                      background: on ? t.accent : t.panel2,
                      border: `0.5px solid ${on ? "transparent" : t.border}`,
                      boxShadow: on ? `0 1px 6px ${hexA(t.accent, 0.3)}` : "none",
                      transition: "background .12s, color .12s",
                    }}>
                    {KIND_LABELS[k]}
                  </button>
                );
              })}
            </div>
          </Field>
        )}

        {/* Emoji + Name row */}
        <div style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: 10 }}>
          <Field label="Emoji">
            <input
              className="sens-input"
              value={emoji}
              maxLength={4}
              onChange={(e) => setEmoji(e.target.value)}
              placeholder="😀"
              style={{ ...inputStyle(t), textAlign: "center", fontSize: 20 }}
            />
          </Field>
          <Field label="Name">
            <input
              className="sens-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Dining out"
              style={inputStyle(t)}
              autoFocus
            />
          </Field>
        </div>

        {/* Colour swatches */}
        <Field label="Colour (optional)">
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", paddingTop: 2 }}>
            {/* None option */}
            <button
              className="sens-btn"
              onClick={() => setColor(null)}
              title="None"
              style={{
                width: 26, height: 26, borderRadius: 6,
                background: t.panel2,
                border: `1.5px solid ${color === null ? t.text : t.border}`,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
              {color === null && <Icon name="close" size={11} color={t.dim} />}
            </button>
            {PALETTE.map((hex) => (
              <button
                key={hex}
                className="sens-btn"
                onClick={() => setColor(hex)}
                title={hex}
                style={{
                  width: 26, height: 26, borderRadius: 6,
                  background: hex,
                  border: `1.5px solid ${color === hex ? t.text : "transparent"}`,
                  boxShadow: color === hex ? `0 0 0 2px ${hexA(hex, 0.4)}` : "none",
                  transition: "box-shadow .1s, border-color .1s",
                }}
              />
            ))}
          </div>
        </Field>

        {error && (
          <div style={{ fontSize: 12.5, color: t.expense, background: hexA(t.expense, 0.1), padding: "8px 12px", borderRadius: 8 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="outline" onClick={onClose} style={{ flex: 1, justifyContent: "center", height: 38 }}>Cancel</Btn>
          <Btn variant="primary" onClick={submit} disabled={!canSubmit || busy} style={{ flex: 1, justifyContent: "center", height: 38 }}>
            {isEdit ? "Save changes" : "Create category"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

// ── Main screen ──────────────────────────────────────────────────────────────

export function Categories() {
  const t = useTheme();
  const { reload, version } = useAppData();
  const { notify } = useToast();
  const [all, setAll] = useState<Category[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState<CategoryKind | null>(null);
  const [editing, setEditing] = useState<Category | null>(null);

  useEffect(() => {
    client.listCategories(undefined, true).then(setAll).catch(() => {});
  }, [version]);

  const visible = all.filter((c) => showArchived || !c.isArchived);

  async function archive(c: Category) {
    try {
      await client.archiveCategory(c.id);
      await reload();
    } catch (e) {
      notify((e as { message?: string })?.message ?? "Failed to archive category", "error");
    }
  }

  async function restore(c: Category) {
    try {
      await client.restoreCategory(c.id);
      await reload();
    } catch (e) {
      notify((e as { message?: string })?.message ?? "Failed to restore category", "error");
    }
  }

  async function afterMutation() {
    await reload();
    setCreating(null);
    setEditing(null);
  }

  const hasArchived = all.some((c) => c.isArchived);

  return (
    <div className="sens-screen" style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 720 }}>
      {/* Toolbar card */}
      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 500, color: t.text }}>
              {all.filter((c) => !c.isArchived).length} active categories
            </div>
            <div style={{ fontSize: 12, color: t.faint, marginTop: 2 }}>
              Income, expense and transfer labels
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {hasArchived && (
              <Btn variant="outline" size="md" onClick={() => setShowArchived((s) => !s)}>
                {showArchived ? "Hide archived" : "Show archived"}
              </Btn>
            )}
            <Btn variant="primary" icon="plus" size="md" onClick={() => setCreating("expense")}>
              New category
            </Btn>
          </div>
        </div>
      </Card>

      {/* Groups */}
      {KIND_ORDER.map((kind) => {
        const rows = visible.filter((c) => c.kind === kind);
        return (
          <div key={kind}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 4px 10px" }}>
              <Icon name={KIND_ICONS[kind]} size={13} color={t.dim} stroke={2} />
              <span style={{ fontSize: 12.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.5 }}>
                {KIND_LABELS[kind]}
              </span>
            </div>

            <Card pad={0} style={{ overflow: "hidden" }}>
              {rows.length === 0 ? (
                <Empty icon="filter" title={`No ${KIND_LABELS[kind].toLowerCase()} categories`} hint="Create one with the button above." />
              ) : (
                rows.map((c, i) => (
                  <CategoryRow
                    key={c.id}
                    category={c}
                    isFirst={i === 0}
                    onEdit={() => setEditing(c)}
                    onArchive={() => archive(c)}
                    onRestore={() => restore(c)}
                  />
                ))
              )}
            </Card>
          </div>
        );
      })}

      {/* Modals */}
      {creating !== null && (
        <CategoryForm defaultKind={creating} onClose={() => setCreating(null)} onDone={afterMutation} />
      )}
      {editing && (
        <CategoryForm initial={editing} onClose={() => setEditing(null)} onDone={afterMutation} />
      )}
    </div>
  );
}

// ── Category row ─────────────────────────────────────────────────────────────

function CategoryRow({
  category: c,
  isFirst,
  onEdit,
  onArchive,
  onRestore,
}: {
  category: Category;
  isFirst: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const t = useTheme();
  const tone = c.color ?? t.accent;

  return (
    <div
      style={{
        borderTop: isFirst ? "none" : `0.5px solid ${t.divider}`,
        opacity: c.isArchived ? 0.55 : 1,
        display: "flex",
        alignItems: "center",
        gap: 13,
        padding: "0 18px",
        height: 56,
      }}
      className="sens-row"
    >
      <GlyphTile tone={tone} size={34} emoji={c.emoji} radius={9} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
          {c.name}
          {c.isSystem && (
            <span style={{
              fontSize: 10, fontWeight: 700, color: t.accent,
              border: `0.5px solid ${hexA(t.accent, 0.4)}`,
              borderRadius: 4, padding: "1px 5px", textTransform: "uppercase",
            }}>
              System
            </span>
          )}
          {c.isArchived && (
            <span style={{
              fontSize: 10, fontWeight: 700, color: t.faint,
              border: `0.5px solid ${t.border}`,
              borderRadius: 4, padding: "1px 5px", textTransform: "uppercase",
            }}>
              Archived
            </span>
          )}
        </div>
        {c.color && (
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 2 }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: c.color, display: "inline-block", flexShrink: 0 }} />
            <span style={{ fontSize: 11.5, color: t.faint, fontFamily: "SF Mono, ui-monospace, monospace" }}>{c.color}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 4 }}>
        <Btn variant="outline" size="sm" icon="pencil" onClick={onEdit}>Edit</Btn>
        {!c.isSystem && (c.isArchived
          ? <Btn variant="outline" size="sm" icon="restore" onClick={onRestore}>Restore</Btn>
          : <Btn variant="outline" size="sm" icon="archive" onClick={onArchive}>Archive</Btn>
        )}
      </div>
    </div>
  );
}
