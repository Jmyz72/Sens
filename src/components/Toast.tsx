// Toast: lightweight notification stack. Uses the design system (panel
// background, hairline border, sens-pop entry). Error toasts use the
// expense/negative token; info uses accent. Auto-dismiss after 4 s.
// No external dependencies.

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { hexA } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { Icon } from "./Icon";

// ── Types ────────────────────────────────────────────────────────────────────

export type ToastKind = "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastCtxValue {
  notify: (message: string, kind?: ToastKind) => void;
}

// ── Context ──────────────────────────────────────────────────────────────────

const ToastCtx = createContext<ToastCtxValue>({ notify: () => {} });

export function useToast(): ToastCtxValue {
  return useContext(ToastCtx);
}

// ── Provider ─────────────────────────────────────────────────────────────────

const MAX_TOASTS = 4;
const DURATION_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counterRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, kind: ToastKind = "info") => {
      const id = ++counterRef.current;
      setToasts((prev) => {
        const next = [...prev, { id, message, kind }];
        // cap to MAX_TOASTS — drop oldest if needed
        return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
      });
      setTimeout(() => dismiss(id), DURATION_MS);
    },
    [dismiss],
  );

  return (
    <ToastCtx.Provider value={{ notify }}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </ToastCtx.Provider>
  );
}

// ── Stack renderer ────────────────────────────────────────────────────────────

function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 9999,
        pointerEvents: "none",
      }}
    >
      {toasts.map((toast) => (
        <ToastBubble key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastBubble({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const t = useTheme();
  const accentColor = toast.kind === "error" ? t.expense : t.accent;

  return (
    <div
      className="sens-pop"
      style={{
        pointerEvents: "auto",
        display: "flex",
        alignItems: "center",
        gap: 10,
        minWidth: 240,
        maxWidth: 380,
        padding: "10px 12px",
        background: t.panel,
        border: `0.5px solid ${t.borderStrong}`,
        borderLeft: `2.5px solid ${accentColor}`,
        borderRadius: 11,
        boxShadow: `0 8px 32px ${hexA("#000000", t.mode === "dark" ? 0.5 : 0.18)}`,
      }}
    >
      <Icon
        name={toast.kind === "error" ? "alertCircle" : "info"}
        size={15}
        color={accentColor}
        stroke={2}
      />
      <span
        style={{
          flex: 1,
          fontSize: 13,
          fontWeight: 500,
          color: t.text,
          lineHeight: 1.4,
          wordBreak: "break-word",
        }}
      >
        {toast.message}
      </span>
      <button
        onClick={() => onDismiss(toast.id)}
        className="sens-icon-btn"
        title="Dismiss"
        style={{ width: 22, height: 22, color: t.faint, flexShrink: 0 }}
      >
        <Icon name="close" size={13} color={t.faint} />
      </button>
    </div>
  );
}
