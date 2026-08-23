import { describe, expect, it } from "vitest";
import { systemSummary } from "../systemSummary";

/**
 * The tile line's contract: never let an outage read as "all off". The house
 * has now been through two power cuts (2026-08-12, 2026-08-21) where the
 * Control4 link came back last and every one of its entities sat
 * `unavailable` — a system that cannot answer must say so.
 */

const on = (n: number) => `${n} on`;

describe("systemSummary", () => {
  it("counts what is on", () => {
    expect(systemSummary(3, 10, 0, on)).toBe("3 on");
  });

  it("says all off only when the whole system answered", () => {
    expect(systemSummary(0, 10, 0, on)).toBe("all off");
  });

  it("never says all off over a dead system", () => {
    expect(systemSummary(0, 14, 14, on)).toBe("not responding");
  });

  it("names a partial outage alongside the live count", () => {
    expect(systemSummary(2, 10, 3, on)).toBe("2 on · 3 not responding");
    expect(systemSummary(0, 10, 3, on)).toBe("all off · 3 not responding");
  });

  it("takes the system's own words for its on-state", () => {
    expect(systemSummary(1, 13, 0, (n) => `${n} zone${n === 1 ? "" : "s"} active`)).toBe(
      "1 zone active",
    );
    expect(systemSummary(4, 13, 0, (n) => `${n} zone${n === 1 ? "" : "s"} active`)).toBe(
      "4 zones active",
    );
    expect(systemSummary(0, 2, 0, on, "all closed")).toBe("all closed");
  });

  it("an empty system is not an outage", () => {
    expect(systemSummary(0, 0, 0, on)).toBe("all off");
  });
});
