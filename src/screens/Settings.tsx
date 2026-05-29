// Settings screen: appearance, dashboard preferences, and about.
// All colors via theme tokens; segmented control matches AddTransaction kind selector style.

import { useEffect, useState } from "react";
import { useTheme, useThemeMode } from "../theme/ThemeProvider";
import { hexA } from "../theme/tokens";
import { Card, SectionTitle } from "../components/ui";
import { Icon } from "../components/Icon";
import { client } from "../client";

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

// ─── Settings screen ─────────────────────────────────────────────────────────

export function Settings() {
  const t = useTheme();
  const { mode, toggle } = useThemeMode();

  // remember_month preference — tri-state: null = loading, then boolean
  const [rememberMonth, setRememberMonth] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    client
      .getSetting("remember_month")
      .then((v) => {
        setRememberMonth(v === "1");
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  async function handleRememberToggle(val: boolean) {
    setRememberMonth(val);
    await client.setSetting("remember_month", val ? "1" : "0");
  }

  type ThemeOpt = "dark" | "light";
  const themeOptions: { value: ThemeOpt; label: string; icon: React.ReactNode }[] = [
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

  function handleThemeChange(val: ThemeOpt) {
    if (val !== mode) toggle();
  }

  return (
    <div className="sens-screen" style={{ maxWidth: 560, display: "flex", flexDirection: "column", gap: 20 }}>
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
            right={<span style={{ fontSize: 13, color: t.faint, fontFamily: t.mono }}>0.1.0</span>}
          />
        </div>
      </Card>
    </div>
  );
}
