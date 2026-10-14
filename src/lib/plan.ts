export function resolveAmount(
  versions: { effectiveMonth: string; amountCents: number | null }[],
  month: string,
): number | null {
  let best: { effectiveMonth: string; amountCents: number | null } | null = null;
  for (const v of versions) {
    if (v.effectiveMonth <= month && (best == null || v.effectiveMonth > best.effectiveMonth)) best = v;
  }
  return best ? best.amountCents : null;
}

export function monthlyRequired(
  today: string,
  targetDate: string | null,
  balanceCents: number,
  targetCents: number,
): number | null {
  if (targetDate == null) return null;
  const gap = targetCents - balanceCents;
  if (gap <= 0 || targetDate < today) return null;
  const idx = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
  const d = idx(targetDate.slice(0, 7)) - idx(today.slice(0, 7));
  const months = d <= 0 ? 1 : d;
  return Math.ceil(gap / months);
}

export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
