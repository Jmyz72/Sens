// Optional gain (income) and loss (expense) categories for value-update accounts.
// An empty choice means the category is picked each time the worth changes.

import type { Category } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Field, inputStyle } from "./ui";
import { appendMissingSelection, categoryPickerItems, type PickerItem } from "../lib/categories";

export function ValueCategoryFields({ categories, gainId, lossId, onGain, onLoss }: {
  categories: Category[];
  gainId: string;
  lossId: string;
  onGain: (id: string) => void;
  onLoss: (id: string) => void;
}) {
  return (
    <>
      <CategorySelect label="Gain category" value={gainId} items={appendMissingSelection(categoryPickerItems(categories, "income"), categories, gainId)} onChange={onGain} />
      <CategorySelect label="Loss category" value={lossId} items={appendMissingSelection(categoryPickerItems(categories, "expense"), categories, lossId)} onChange={onLoss} />
    </>
  );
}

function CategorySelect({ label, value, items, onChange }: {
  label: string;
  value: string;
  items: PickerItem[];
  onChange: (id: string) => void;
}) {
  const t = useTheme();
  return (
    <Field label={label}>
      <select className="sens-input" value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle(t), appearance: "none", cursor: "pointer" }}>
        <option value="" style={{ background: t.panel2 }}>Ask each time</option>
        {items.map((item) => (
          <option key={item.id} value={item.id} style={{ background: t.panel2 }}>
            {item.depth === 1 ? `  ${item.label}` : item.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
