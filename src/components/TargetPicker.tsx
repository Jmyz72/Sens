// TargetPicker: modal to select a re-categorize target (category) or
// move-to-account target. Used by the bulk action flow.

import type { Account, Category } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Modal } from "./ui";
import { categoryPickerItems } from "../lib/categories";
import type { BulkAction } from "../lib/txnSelection";
import type { BulkTarget } from "./BulkPreviewSheet";

export function TargetPicker({
  action,
  accounts,
  categories,
  onCancel,
  onChoose,
}: {
  action: BulkAction;
  accounts: Account[];
  categories: Category[];
  onCancel: () => void;
  onChoose: (target: BulkTarget) => void;
}) {
  const t = useTheme();
  const isMove = action === "move";

  // For re-categorize: offer both income & expense categories (bulk selection
  // may mix kinds). De-dup is not needed — names are per-kind and IDs are unique.
  const catItems = isMove
    ? []
    : [
        ...categoryPickerItems(categories, "income"),
        ...categoryPickerItems(categories, "expense"),
      ];

  return (
    <Modal onClose={onCancel} width={360}>
      <div
        style={{
          padding: "15px 18px",
          borderBottom: `0.5px solid ${t.divider}`,
          fontSize: 15,
          fontWeight: 700,
        }}
      >
        {isMove ? "Move to account" : "Re-categorize to"}
      </div>

      <div style={{ maxHeight: 380, overflowY: "auto", padding: 8 }}>
        {isMove
          ? accounts.filter((a) => !a.isArchived).map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => onChoose({ accountId: a.id, accountName: a.name })}
                style={{
                  display: "flex",
                  width: "100%",
                  textAlign: "left",
                  padding: "9px 11px",
                  borderRadius: 8,
                  border: "none",
                  background: "transparent",
                  color: t.text,
                  cursor: "pointer",
                  fontSize: 13,
                  fontFamily: t.font,
                }}
              >
                {a.name}
              </button>
            ))
          : catItems.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onChoose({ categoryId: c.id, categoryName: c.label })}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  padding: "9px 11px",
                  paddingLeft: c.depth ? 26 : 11,
                  borderRadius: 8,
                  border: "none",
                  background: "transparent",
                  color: t.text,
                  cursor: "pointer",
                  fontSize: 13,
                  fontFamily: t.font,
                }}
              >
                <span>{c.emoji}</span> {c.label}
              </button>
            ))}
      </div>
    </Modal>
  );
}
