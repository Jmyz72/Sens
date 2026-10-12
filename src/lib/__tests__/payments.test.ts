import { describe, expect, it } from "vitest";
import { isPaymentSource, movementKind, payAmountField } from "../payments";

describe("movementKind", () => {
  it("is payment only for a credit card or BNPL destination", () => {
    expect(movementKind("credit-card")).toBe("payment");
    expect(movementKind("bnpl")).toBe("payment");
    expect(movementKind("savings")).toBe("transfer");
    expect(movementKind("personal-loan")).toBe("transfer");
    expect(movementKind(undefined)).toBe("transfer");
  });
});

describe("isPaymentSource", () => {
  it("allows only cash, e-wallet, savings, and current", () => {
    for (const subtype of ["cash", "ewallet", "savings", "current"]) {
      expect(isPaymentSource(subtype)).toBe(true);
    }
    expect(isPaymentSource("credit-card")).toBe(false);
    expect(isPaymentSource("investment")).toBe(false);
  });
});

describe("payAmountField", () => {
  it("starts at the amount owed and is blank when nothing is owed", () => {
    expect(payAmountField(-80_000)).toBe("800.00");
    expect(payAmountField(0)).toBe("");
    expect(payAmountField(2_000)).toBe("");
  });
});
