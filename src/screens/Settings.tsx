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

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const t = useTheme();
  return (
    <button
      role="switch"
      aria-checked={on}
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

  // transaction_time_enabled preference — default off (unset = off)
  const [timeEnabled, setTimeEnabled] = useState(false);
  const [timeLoaded, setTimeLoaded] = useState(false);

  useEffect(() => {
    client
      .getSetting("transaction_time_enabled")
      .then((v) => {
        setTimeEnabled(v === "1");
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
