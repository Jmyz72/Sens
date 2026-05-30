import { describe, it, expect } from "vitest";
import { sparkPath } from "../components/Sparkline";

describe("sparkPath", () => {
  it("returns empty path for no points", () => {
    expect(sparkPath([], 64, 28)).toEqual({ line: "", area: "" });
  });
  it("maps a rising series to a line whose last y is above (smaller than) the first", () => {
    const { line, area } = sparkPath([0, 10], 64, 28);
    const ys = [...line.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(ys[1]).toBeLessThan(ys[0]); // higher value → smaller y (SVG top-down)
    expect(area.endsWith("Z")).toBe(true);
  });
  it("draws a flat series through the vertical middle", () => {
    const { line } = sparkPath([5, 5, 5], 60, 30);
    const ys = [...line.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    ys.forEach((y) => expect(y).toBeCloseTo(15, 1));
  });
});
