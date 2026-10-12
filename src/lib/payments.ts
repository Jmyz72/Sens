const PAYMENT_DESTINATIONS = new Set(["credit-card", "bnpl"]);
const PAYMENT_SOURCES = new Set(["cash", "ewallet", "savings", "current"]);

export function movementKind(destSubtype: string | undefined): "payment" | "transfer" {
  return destSubtype != null && PAYMENT_DESTINATIONS.has(destSubtype) ? "payment" : "transfer";
}

export function isPaymentSource(subtype: string): boolean {
  return PAYMENT_SOURCES.has(subtype);
}

export function payAmountField(balanceCents: number): string {
  if (balanceCents < 0) return (-balanceCents / 100).toFixed(2);
  return "";
}
