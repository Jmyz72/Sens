// Due and overdue tap-to-post rows. Renders nothing when there are none.

import { useState } from "react";
import type { UpcomingOccurrence } from "../types";
import { useTheme } from "../theme/ThemeProvider";
import { Btn, Card, Money } from "./ui";
import { Icon } from "./Icon";
import { client } from "../client";
import { KIND_META, kindColor, signedFor } from "../lib/kinds";
import { fmtDate, fmtTime } from "../lib/format";
import { useToast } from "./Toast";
import { PostOccurrence } from "../modals/PostOccurrence";

export function UpcomingList({ rows, onReload }: { rows: UpcomingOccurrence[]; onReload: () => void }) {
  const t = useTheme();
  const { notify } = useToast();
  const [posting, setPosting] = useState<UpcomingOccurrence | null>(null);
  const [skipping, setSkipping] = useState<string | null>(null);
  if (rows.length === 0) return null;

  async function skip(row: UpcomingOccurrence) {
    setSkipping(`${row.scheduleId}:${row.occurrenceDate}`);
    try {
      await client.skipScheduleOccurrence(row.scheduleId, row.occurrenceDate);
      onReload();
    } catch (e) {
      notify((e as { message?: string })?.message ?? "Couldn't skip", "error");
    } finally {
      setSkipping(null);
    }
  }

  return (
    <>
      <Card pad={0} style={{ overflow: "hidden" }}>
        <div style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.faint, borderBottom: `0.5px solid ${t.divider}` }}>
          Upcoming
        </div>
        <div style={{ padding: "6px 16px 8px" }}>
          {rows.map((row) => {
            const meta = KIND_META[row.kind];
            const color = kindColor(t, row.kind);
            const movement = row.kind === "transfer" || row.kind === "payment";
            const when = [fmtDate(row.occurrenceDate), row.time ? fmtTime(row.time) : ""].filter(Boolean).join(" · ");
            const skipKey = `${row.scheduleId}:${row.occurrenceDate}`;
            return (
              <div key={skipKey} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `0.5px solid ${t.divider}` }}>
                <Icon name={meta.icon} size={16} color={color} stroke={2} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: t.text }}>{row.label}</div>
                  <div style={{ fontSize: 12, color: t.dim, marginTop: 2 }}>{when} · {row.accountName}</div>
                  {row.blockReason && <div style={{ fontSize: 12, color: t.expense, marginTop: 4 }}>{row.blockReason}</div>}
                </div>
                <Money cents={movement ? row.amountCents : signedFor(row.kind, row.amountCents)} signed={!movement} color={color} />
                <Btn size="sm" variant="outline" disabled={!!row.blockReason} onClick={() => { if (!row.blockReason) setPosting(row); }}>Post</Btn>
                <Btn size="sm" variant="ghost" disabled={skipping === skipKey} onClick={() => skip(row)}>Skip</Btn>
              </div>
            );
          })}
        </div>
      </Card>
      {posting && (
        <PostOccurrence row={posting} onClose={() => setPosting(null)} onDone={() => { setPosting(null); onReload(); }} />
      )}
    </>
  );
}
