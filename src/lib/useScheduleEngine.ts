// Runs the schedule pass when Sens opens, when the window focuses, and when the
// next due time arrives. Upcoming is whatever tap-to-post rows are due.

import { useEffect, useRef, useState } from "react";
import { client } from "../client";
import type { Transaction, UpcomingOccurrence } from "../types";

const MAX_TIMEOUT = 2_147_483_647;

/** Local milliseconds for `YYYY-MM-DDTHH:MM`, or null when it is not that shape. */
function localStampMs(stamp: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(stamp);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const at = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day) return null;
  return at.getTime();
}

export function useScheduleEngine(version: number, reload: () => Promise<void>) {
  const [upcoming, setUpcoming] = useState<UpcomingOccurrence[]>([]);
  const [away, setAway] = useState<Transaction[]>([]);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const timer = useRef<number | null>(null);
  const runRef = useRef<() => Promise<void>>(async () => {});

  function addAway(rows: Transaction[]) {
    if (rows.length === 0) return;
    setAway((prev) => {
      const ids = new Set(prev.map((row) => row.id));
      const next = rows.filter((row) => !ids.has(row.id));
      if (next.length === 0) return prev;
      next.sort((a, b) => (a.transactionDate < b.transactionDate ? -1 : a.transactionDate > b.transactionDate ? 1 : a.id < b.id ? -1 : 1));
      return [...prev, ...next];
    });
  }

  function clearTimer() {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }

  function arm(nextWakeAt: string | null) {
    clearTimer();
    if (!nextWakeAt) return;
    const at = localStampMs(nextWakeAt);
    if (at == null || at <= Date.now()) return;
    const delay = Math.min(at - Date.now(), MAX_TIMEOUT);
    timer.current = window.setTimeout(() => { void runRef.current(); }, delay);
  }

  // A response only lands if no newer load started after it.
  const loadSeq = useRef(0);

  async function loadUpcoming() {
    const seq = ++loadSeq.current;
    try {
      const rows = await client.listUpcoming();
      if (seq === loadSeq.current) setUpcoming(rows);
    } catch {
      // Keep the list from the last successful read.
    }
  }

  runRef.current = async () => {
    try {
      const pass = await client.runSchedulePass();
      if (pass.posted.length > 0) {
        addAway(pass.posted);
        await reloadRef.current();
      }
      arm(pass.nextWakeAt);
      await loadUpcoming();
    } catch {
      // The next focus tries the pass again.
    }
  };

  useEffect(() => {
    void runRef.current();
    const onFocus = () => { void runRef.current(); };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearTimer();
    };
  }, []);

  useEffect(() => {
    void loadUpcoming();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // Saving stores the schedule only. One pass afterwards posts what is due, and
  // its `posted` rows are exactly what the away notice lists.
  async function commitSchedule(write: () => Promise<void>) {
    await write();
    try {
      const pass = await client.runSchedulePass();
      addAway(pass.posted);
      await reloadRef.current();
      arm(pass.nextWakeAt);
      await loadUpcoming();
    } catch {
      // The schedule is already saved. The next focus runs the pass again.
    }
  }

  return {
    upcoming,
    upcomingCount: upcoming.length,
    away,
    dismissAway: () => setAway([]),
    commitSchedule,
  };
}
