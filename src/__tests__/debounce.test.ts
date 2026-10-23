import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce } from "../lib/debounce";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("debounce", () => {
  it("collapses 5 calls within 100ms into one trailing invocation", () => {
    const fn = vi.fn();
    const d = debounce(fn, 250);
    for (let i = 0; i < 5; i++) { d(); vi.advanceTimersByTime(20); }
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200); // 220 ms since the last call
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel drops the pending call", () => {
    const fn = vi.fn();
    const d = debounce(fn, 250);
    d();
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});
