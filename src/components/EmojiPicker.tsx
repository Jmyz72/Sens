// Reusable searchable emoji picker. Renders as a popover anchored to a trigger
// element. Loads the (committed) emoji catalog lazily on first open so it never
// enters the initial bundle. All colors come from theme tokens.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Icon } from "./Icon";
import { inputStyle } from "./ui";
import {
  filterEmojis,
  groupEmojis,
  loadRecents,
  pushRecent,
  SUGGESTED,
  type EmojiEntry,
} from "../lib/emoji";

export function EmojiPicker({
  value,
  onSelect,
  onClose,
  anchorRef,
}: {
  value: string;
  onSelect: (emoji: string) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const t = useTheme();
  const popRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<EmojiEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>(() => loadRecents());

  // Lazy-load the catalog on mount (component only mounts when picker opens).
  useEffect(() => {
    let alive = true;
    import("../assets/emoji-data.json").then((m) => {
      if (alive) setData(m.default as EmojiEntry[]);
    });
    return () => { alive = false; };
  }, []);

  // Close on outside click and Esc.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (popRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchorRef, onClose]);

  // Position the popover under the anchor, flipping up if it would overflow.
  const pos = useMemo(() => {
    const a = anchorRef.current?.getBoundingClientRect();
    if (!a) return { top: 0, left: 0 };
    const W = 320, H = 360, gap = 6;
    let left = a.left;
    if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8;
    let top = a.bottom + gap;
    if (top + H > window.innerHeight - 8) top = Math.max(8, a.top - H - gap);
    return { top, left };
  }, [anchorRef]);

  const groups = useMemo(() => (data ? groupEmojis(data) : []), [data]);
  const results = useMemo(
    () => (data && query.trim() ? filterEmojis(data, query) : null),
    [data, query],
  );

  function choose(emoji: string) {
    setRecents((r) => pushRecent(r, emoji));
    onSelect(emoji);
    onClose();
  }

  const cell = (e: EmojiEntry | string) => {
    const ch = typeof e === "string" ? e : e.c;
    const title = typeof e === "string" ? undefined : e.n;
    const on = ch === value;
    return (
      <button key={ch} title={title} onClick={() => choose(ch)}
        style={{
          width: 34, height: 34, fontSize: 20, lineHeight: "34px", border: "none",
          borderRadius: 7, cursor: "pointer", background: on ? hexA(t.accent, 0.2) : "transparent",
          padding: 0,
        }}
        onMouseEnter={(ev) => (ev.currentTarget.style.background = t.panel2)}
        onMouseLeave={(ev) => (ev.currentTarget.style.background = on ? hexA(t.accent, 0.2) : "transparent")}>
        {ch}
      </button>
    );
  };

  const sectionLabel: React.CSSProperties = {
    fontSize: 10.5, fontWeight: 700, color: t.faint, textTransform: "uppercase",
    letterSpacing: 0.5, padding: "10px 4px 4px",
  };

  return (
    <div ref={popRef} className="sens-pop"
      style={{
        position: "fixed", top: pos.top, left: pos.left, width: 320, zIndex: 200,
        background: t.panel, border: `0.5px solid ${t.borderStrong}`, borderRadius: 12,
        boxShadow: "0 20px 60px rgba(0,0,0,0.45)", display: "flex", flexDirection: "column",
        maxHeight: 360, overflow: "hidden",
      }}>
      {/* Search */}
      <div style={{ padding: 10, borderBottom: `0.5px solid ${t.divider}`, position: "relative" }}>
        <Icon name="search" size={14} color={t.faint}
          style={{ position: "absolute", left: 20, top: 21 }} />
        <input className="sens-input" autoFocus value={query}
          onChange={(e) => setQuery(e.target.value)} placeholder="Search emoji"
          style={{ ...inputStyle(t), height: 34, paddingLeft: 32 }} />
      </div>

      {/* Body */}
      <div style={{ overflow: "auto", padding: "0 10px 10px" }}>
        {!data ? (
          <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: t.faint }}>Loading…</div>
        ) : results ? (
          results.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: t.faint }}>No matches</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, paddingTop: 8 }}>
              {results.slice(0, 300).map(cell)}
            </div>
          )
        ) : (
          <>
            {recents.length > 0 && (
              <>
                <div style={sectionLabel}>Recent</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
                  {recents.map((c) => cell(c))}
                </div>
              </>
            )}
            <div style={sectionLabel}>Suggested</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
              {SUGGESTED.map((c) => cell(c))}
            </div>
            {groups.map((g) => (
              <div key={g.group}>
                <div style={{ ...sectionLabel, position: "sticky", top: 0, background: t.panel, zIndex: 1 }}>
                  {g.group}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
                  {g.emojis.map(cell)}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
