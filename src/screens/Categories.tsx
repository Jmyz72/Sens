// Categories screen: a master–detail layout. The left rail lists top-level
// categories grouped by kind (income / expense / transfer) with a subcategory
// count; selecting one shows it in the detail pane alongside an editable list
// of its subcategories. Two-level hierarchy only (see the subcategories spec).

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Category, CategoryKind } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Btn, Card, Empty, Field, GlyphTile, Modal, inputStyle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";
import { useAppData } from "../store";
import { useToast } from "../components/Toast";
import { categoryTree, reorderIds, moveTargets, type CategoryNode } from "../lib/categories";

// ── Preset colour palette (data constant, acceptable hardcoded hex) ─────────

const PALETTE = [
  "#33c9d6", "#46d39a", "#5b8def", "#a78bfa", "#d9728f",
  "#f0708c", "#e0a13c", "#5aa66d", "#56b3c4", "#9aa4b2",
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

// ── Create / edit modal (top-level or, with `parent`, a subcategory) ─────────

interface CategoryFormProps {
  initial?: Category;
  parent?: Category;
  defaultKind?: CategoryKind;
  onClose: () => void;
  onDone: () => void;
}

function CategoryForm({ initial, parent, defaultKind = "expense", onClose, onDone }: CategoryFormProps) {
  const t = useTheme();
  const isEdit = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<CategoryKind>(initial?.kind ?? parent?.kind ?? defaultKind);
  const [emoji, setEmoji] = useState(initial?.emoji ?? "");
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && emoji.trim().length > 0;
  const title = parent ? "New subcategory" : isEdit ? "Edit category" : "New category";

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (isEdit) {
        await client.updateCategory({ id: initial!.id, name: name.trim(), emoji: emoji.trim(), color: color ?? undefined });
      } else {
        await client.createCategory(name.trim(), parent ? parent.kind : kind, emoji.trim(), color ?? undefined, parent?.id ?? null);
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
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{title}</span>
        <button className="sens-icon-btn" onClick={onClose} style={{ width: 28, height: 28, color: t.dim }}>
          <Icon name="close" size={16} />
        </button>
      </div>

      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        {parent && (
          <div style={{ fontSize: 12.5, color: t.dim, display: "flex", alignItems: "center", gap: 7 }}>
            <GlyphTile tone={parent.color ?? t.accent} size={22} emoji={parent.emoji} radius={6} />
            Under <strong style={{ color: t.text, fontWeight: 600 }}>{parent.name}</strong>
          </div>
        )}

        {!isEdit && !parent && (
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

        <div style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: 10 }}>
          <Field label="Emoji">
            <input className="sens-input" value={emoji} maxLength={4}
              onChange={(e) => setEmoji(e.target.value)} placeholder="😀"
              style={{ ...inputStyle(t), textAlign: "center", fontSize: 20 }} />
          </Field>
          <Field label="Name">
            <input className="sens-input" value={name} onChange={(e) => setName(e.target.value)}
              placeholder={parent ? "e.g. Coffee" : "e.g. Dining out"} style={inputStyle(t)} autoFocus />
          </Field>
        </div>

        <Field label="Colour (optional)">
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", paddingTop: 2 }}>
            <button className="sens-btn" onClick={() => setColor(null)} title="None"
              style={{ width: 26, height: 26, borderRadius: 6, background: t.panel2,
                border: `1.5px solid ${color === null ? t.text : t.border}`,
                display: "flex", alignItems: "center", justifyContent: "center" }}>
              {color === null && <Icon name="close" size={11} color={t.dim} />}
            </button>
            {PALETTE.map((hex) => (
              <button key={hex} className="sens-btn" onClick={() => setColor(hex)} title={hex}
                style={{ width: 26, height: 26, borderRadius: 6, background: hex,
                  border: `1.5px solid ${color === hex ? t.text : "transparent"}`,
                  boxShadow: color === hex ? `0 0 0 2px ${hexA(hex, 0.4)}` : "none",
                  transition: "box-shadow .1s, border-color .1s" }} />
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
            {isEdit ? "Save changes" : parent ? "Add subcategory" : "Create category"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

// ── Move modal ───────────────────────────────────────────────────────────────

function MoveCategoryModal({ category, all, onClose, onDone }: {
  category: Category;
  all: Category[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTheme();
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);
  const targets = moveTargets(all, category);
  const isSub = category.parentId != null;
  const hasChildren = all.some((c) => c.parentId === category.id);

  async function move(parentId: string | null) {
    setBusy(true);
    try { await client.setCategoryParent(category.id, parentId); onDone(); }
    catch (e) { notify((e as { message?: string })?.message ?? "Failed to move category", "error"); }
    finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose} width={360}>
      <div style={{ padding: "16px 20px", borderBottom: `0.5px solid ${t.divider}`, fontSize: 15, fontWeight: 700 }}>
        Move "{category.name}"
      </div>
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        {isSub && (
          <Btn variant="outline" size="md" disabled={busy} onClick={() => move(null)}>
            Make top-level category
          </Btn>
        )}
        {targets.length === 0 && !isSub && (
          <div style={{ fontSize: 12.5, color: t.faint }}>
            {hasChildren
              ? "Empty this category's subcategories first to make it a subcategory."
              : `No other ${KIND_LABELS[category.kind].toLowerCase()} category to move under — create one first.`}
          </div>
        )}
        {targets.map((p) => (
          <Btn key={p.id} variant="outline" size="md" disabled={busy} onClick={() => move(p.id)}>
            <GlyphTile tone={p.color ?? t.accent} size={20} emoji={p.emoji} radius={6} /> Under {p.name}
          </Btn>
        ))}
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState<CategoryKind | null>(null);
  const [addingSubTo, setAddingSubTo] = useState<Category | null>(null);
  const [editing, setEditing] = useState<Category | null>(null);
  const [moving, setMoving] = useState<Category | null>(null);

  useEffect(() => {
    client.listCategories(undefined, true).then(setAll).catch(() => {});
  }, [version]);

  const treesByKind = useMemo(() => {
    const visible = all.filter((c) => showArchived || !c.isArchived);
    return KIND_ORDER.map((kind) => ({ kind, nodes: categoryTree(visible, kind) }));
  }, [all, showArchived]);

  const selectedNode = useMemo<CategoryNode | null>(() => {
    for (const { nodes } of treesByKind) {
      const n = nodes.find((n) => n.category.id === selectedId);
      if (n) return n;
    }
    return null;
  }, [treesByKind, selectedId]);

  useEffect(() => {
    if (selectedNode) return;
    const first = treesByKind.flatMap((g) => g.nodes)[0];
    setSelectedId(first ? first.category.id : null);
  }, [treesByKind, selectedNode]);

  async function archive(c: Category) {
    try { await client.archiveCategory(c.id); await reload(); }
    catch (e) { notify((e as { message?: string })?.message ?? "Failed to archive category", "error"); }
  }
  async function restore(c: Category) {
    try { await client.restoreCategory(c.id); await reload(); }
    catch (e) { notify((e as { message?: string })?.message ?? "Failed to restore category", "error"); }
  }
  async function del(c: Category) {
    try { await client.deleteCategory(c.id); await reload(); }
    catch (e) { notify((e as { message?: string })?.message ?? "Failed to delete category", "error"); }
  }
  async function afterMutation() {
    await reload();
    setCreating(null);
    setAddingSubTo(null);
    setEditing(null);
  }

  async function commitReorder(siblings: Category[], fromId: string, toId: string) {
    const ids = siblings.map((c) => c.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    const next = reorderIds(ids, from, to);
    try { await client.reorderCategories(next); await reload(); }
    catch (e) { notify((e as { message?: string })?.message ?? "Failed to reorder", "error"); }
  }

  const activeCount = all.filter((c) => !c.isArchived).length;
  const hasArchived = all.some((c) => c.isArchived);

  return (
    <div className="sens-screen" style={{ display: "flex", gap: 14, alignItems: "flex-start", maxWidth: 940 }}>
      {/* LEFT RAIL */}
      <div style={{ width: 290, flexShrink: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        <Card>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 500, color: t.text }}>{activeCount} active</div>
              <div style={{ fontSize: 12, color: t.faint, marginTop: 2 }}>Categories &amp; subcategories</div>
            </div>
            <Btn variant="primary" icon="plus" size="md" onClick={() => setCreating("expense")}>New</Btn>
          </div>
          {hasArchived && (
            <div style={{ marginTop: 10 }}>
              <Btn variant="outline" size="sm" onClick={() => setShowArchived((s) => !s)}>
                {showArchived ? "Hide archived" : "Show archived"}
              </Btn>
            </div>
          )}
        </Card>

        <Card pad={0} style={{ overflow: "hidden" }}>
          {treesByKind.map(({ kind, nodes }) => (
            <div key={kind}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "12px 16px 8px" }}>
                <Icon name={KIND_ICONS[kind]} size={12} color={t.dim} stroke={2} />
                <span style={{ fontSize: 11.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  {KIND_LABELS[kind]}
                </span>
              </div>
              {nodes.length === 0 ? (
                <div style={{ padding: "0 16px 12px", fontSize: 12, color: t.faint }}>None yet</div>
              ) : (
                nodes.map((node) => {
                  const c = node.category;
                  const on = c.id === selectedId;
                  return (
                    <button key={c.id} className="sens-row" onClick={() => setSelectedId(c.id)}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData("text/plain", c.id)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const fromId = e.dataTransfer.getData("text/plain");
                        if (fromId) commitReorder(nodes.map((n) => n.category), fromId, c.id);
                      }}
                      style={{
                        width: "100%", display: "flex", alignItems: "center", gap: 11, padding: "8px 16px",
                        background: on ? t.panel2 : "transparent", border: "none", cursor: "pointer",
                        opacity: c.isArchived ? 0.55 : 1, textAlign: "left",
                        borderLeft: `2px solid ${on ? (c.color ?? t.accent) : "transparent"}`,
                      }}>
                      <GlyphTile tone={c.color ?? t.accent} size={28} emoji={c.emoji} radius={8} />
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: on ? 650 : 550, color: t.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {c.name}
                      </span>
                      {node.children.length > 0 && (
                        <span style={{ fontSize: 11, color: t.faint, fontVariantNumeric: "tabular-nums" }}>{node.children.length}</span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          ))}
        </Card>
      </div>

      {/* DETAIL PANE */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {selectedNode ? (
          <CategoryDetail
            node={selectedNode}
            onEdit={() => setEditing(selectedNode.category)}
            onArchive={() => archive(selectedNode.category)}
            onRestore={() => restore(selectedNode.category)}
            onAddSub={() => setAddingSubTo(selectedNode.category)}
            onEditChild={(child) => setEditing(child)}
            onArchiveChild={(child) => archive(child)}
            onRestoreChild={(child) => restore(child)}
            onDelete={() => del(selectedNode.category)}
            onDeleteChild={(child) => del(child)}
            onReorderChildren={(fromId, toId) => commitReorder(selectedNode.children, fromId, toId)}
            onMove={() => setMoving(selectedNode.category)}
            onMoveChild={(child) => setMoving(child)}
          />
        ) : (
          <Card><Empty icon="filter" title="No categories yet" hint="Create one with the New button." /></Card>
        )}
      </div>

      {/* MODALS */}
      {creating !== null && (
        <CategoryForm defaultKind={creating} onClose={() => setCreating(null)} onDone={afterMutation} />
      )}
      {addingSubTo && (
        <CategoryForm parent={addingSubTo} onClose={() => setAddingSubTo(null)} onDone={afterMutation} />
      )}
      {editing && (
        <CategoryForm initial={editing} onClose={() => setEditing(null)} onDone={afterMutation} />
      )}
      {moving && (
        <MoveCategoryModal category={moving} all={all} onClose={() => setMoving(null)} onDone={() => { setMoving(null); reload(); }} />
      )}
    </div>
  );
}

// ── Detail pane ──────────────────────────────────────────────────────────────

function CategoryDetail({
  node, onEdit, onArchive, onRestore, onAddSub, onEditChild, onArchiveChild, onRestoreChild, onDelete, onDeleteChild, onReorderChildren, onMove, onMoveChild,
}: {
  node: CategoryNode;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onAddSub: () => void;
  onEditChild: (c: Category) => void;
  onArchiveChild: (c: Category) => void;
  onRestoreChild: (c: Category) => void;
  onDelete: () => void;
  onDeleteChild: (c: Category) => void;
  onReorderChildren: (fromId: string, toId: string) => void;
  onMove: () => void;
  onMoveChild: (c: Category) => void;
}) {
  const t = useTheme();
  const c = node.category;

  return (
    <Card pad={0} style={{ overflow: "hidden" }}>
      {/* Hero */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: 18, borderBottom: `0.5px solid ${t.divider}` }}>
        <GlyphTile tone={c.color ?? t.accent} size={48} emoji={c.emoji} radius={12} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: -0.2, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {c.name}
            {c.isArchived && <Tag tone={t.faint}>Archived</Tag>}
          </div>
          <div style={{ fontSize: 12.5, color: t.dim, marginTop: 3 }}>
            {KIND_LABELS[c.kind]} · {node.children.length} {node.children.length === 1 ? "subcategory" : "subcategories"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <Btn variant="outline" size="sm" icon="pencil" onClick={onEdit}>Edit</Btn>
          <Btn variant="outline" size="sm" icon="swap" onClick={onMove}>Move</Btn>
          {c.isArchived
            ? <Btn variant="outline" size="sm" icon="restore" onClick={onRestore}>Restore</Btn>
            : <Btn variant="outline" size="sm" icon="archive" onClick={onArchive}>Archive</Btn>
          }
          {node.children.length === 0 && (
            <Btn variant="danger" size="sm" icon="trash" onClick={onDelete}>Delete</Btn>
          )}
        </div>
      </div>

      {/* Subcategories */}
      <div style={{ padding: 18 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: t.faint, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 }}>
          Subcategories
        </div>

        {node.children.length === 0 ? (
          <div style={{ fontSize: 12.5, color: t.faint, marginBottom: 12 }}>No subcategories yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            {node.children.map((child) => (
              <div key={child.id} className="sens-row"
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/plain", child.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const fromId = e.dataTransfer.getData("text/plain");
                  if (fromId) onReorderChildren(fromId, child.id);
                }}
                style={{ display: "flex", alignItems: "center", gap: 11, padding: "8px 10px",
                  border: `0.5px solid ${t.border}`, borderRadius: 9, opacity: child.isArchived ? 0.55 : 1 }}>
                <GlyphTile tone={child.color ?? t.accent} size={28} emoji={child.emoji} radius={8} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 550, display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                  {child.name}
                  {child.isArchived && <Tag tone={t.faint}>Archived</Tag>}
                </span>
                <div style={{ display: "flex", gap: 4 }}>
                  <Btn variant="outline" size="sm" icon="pencil" onClick={() => onEditChild(child)}>Edit</Btn>
                  <Btn variant="outline" size="sm" icon="swap" onClick={() => onMoveChild(child)}>Move</Btn>
                  {child.isArchived
                    ? <Btn variant="outline" size="sm" icon="restore" onClick={() => onRestoreChild(child)}>Restore</Btn>
                    : <Btn variant="outline" size="sm" icon="archive" onClick={() => onArchiveChild(child)}>Archive</Btn>}
                  <Btn variant="danger" size="sm" icon="trash" onClick={() => onDeleteChild(child)}>Delete</Btn>
                </div>
              </div>
            ))}
          </div>
        )}

        {!c.isArchived && (
          <Btn variant="outline" size="md" icon="plus" onClick={onAddSub}>Add subcategory</Btn>
        )}
      </div>
    </Card>
  );
}

function Tag({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: tone, border: `0.5px solid ${hexA(tone, 0.4)}`, borderRadius: 4, padding: "1px 5px", textTransform: "uppercase" }}>
      {children}
    </span>
  );
}
