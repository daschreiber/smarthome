import { describe, expect, it } from "vitest";
import {
  fireSortKey, houseNow, nextAutomationFire, nextFireLabel, nextStepFire, resolveStepTime,
} from "../nextfire";

// Thursday 2026-07-16, 16:00 house time.
const NOW = { minutes: 16 * 60, day: 4, date: "2026-07-16" };

describe("houseNow", () => {
  it("reads the wall clock in the given timezone", () => {
    const d = new Date("2026-07-16T13:00:00Z");
    expect(houseNow("UTC", d)).toEqual({ minutes: 13 * 60, day: 4, date: "2026-07-16" });
    expect(houseNow("Asia/Jerusalem", d)).toEqual({ minutes: 16 * 60, day: 4, date: "2026-07-16" });
  });
  it("normalizes midnight to 0 minutes", () => {
    expect(houseNow("UTC", new Date("2026-07-16T00:00:00Z")).minutes).toBe(0);
  });
});

describe("nextStepFire", () => {
  it("daily step later today fires today, earlier fires tomorrow", () => {
    expect(nextStepFire({ time: "18:00" }, NOW)).toEqual({ dayOffset: 0, time: "18:00" });
    expect(nextStepFire({ time: "09:00" }, NOW)).toEqual({ dayOffset: 1, time: "09:00" });
    // exactly now counts as passed (the scheduler minute is already ticking)
    expect(nextStepFire({ time: "16:00" }, NOW)).toEqual({ dayOffset: 1, time: "16:00" });
  });
  it("weekly steps roll to the next matching day, up to a full week", () => {
    expect(nextStepFire({ time: "09:00", days: [6] }, NOW)).toEqual({ dayOffset: 2, time: "09:00" });
    expect(nextStepFire({ time: "09:00", days: [4] }, NOW)).toEqual({ dayOffset: 7, time: "09:00" });
    expect(nextStepFire({ time: "18:00", days: [4] }, NOW)).toEqual({ dayOffset: 0, time: "18:00" });
  });
  it("one-shots fire once and never in the past", () => {
    expect(nextStepFire({ time: "18:00", date: "2026-07-16" }, NOW))
      .toEqual({ dayOffset: 0, time: "18:00", date: "2026-07-16" });
    expect(nextStepFire({ time: "09:00", date: "2026-07-16" }, NOW)).toBeNull();
    expect(nextStepFire({ time: "09:00", date: "2026-07-15" }, NOW)).toBeNull();
    expect(nextStepFire({ time: "09:00", date: "2026-07-25" }, NOW))
      .toEqual({ dayOffset: 9, time: "09:00", date: "2026-07-25" });
    expect(nextStepFire({ time: "18:00", date: "2026-07-16", lastFired: "2026-07-16T18:00" }, NOW)).toBeNull();
  });
});

describe("nextAutomationFire", () => {
  it("picks the soonest step across the automation", () => {
    const nf = nextAutomationFire(
      [{ time: "09:00", days: [6] }, { time: "20:00" }, { time: "17:30" }],
      NOW,
    );
    expect(nf).toEqual({ dayOffset: 0, time: "17:30" });
  });
  it("returns null when nothing is upcoming (spent one-shots)", () => {
    expect(nextAutomationFire([{ time: "09:00", date: "2026-01-01" }], NOW)).toBeNull();
  });
  it("sort key orders by day then time", () => {
    expect(fireSortKey({ dayOffset: 0, time: "18:00" }))
      .toBeLessThan(fireSortKey({ dayOffset: 1, time: "07:00" }));
    expect(fireSortKey({ dayOffset: 1, time: "07:00" }))
      .toBeLessThan(fireSortKey({ dayOffset: 1, time: "09:00" }));
  });
});

describe("resolveStepTime", () => {
  const sun = { sunrise: "2026-07-16T02:47:00Z", sunset: "2026-07-16T16:41:00Z" };
  it("turns a sun step into a concrete house-clock time, offset applied", () => {
    expect(resolveStepTime({ sun: "sunset" }, sun, "UTC")).toEqual({ sun: undefined, time: "16:41" });
    expect(resolveStepTime({ sun: "sunset", sunOffsetMinutes: -41 }, sun, "UTC"))
      .toMatchObject({ time: "16:00" });
    expect(resolveStepTime({ sun: "sunset", sunOffsetMinutes: 19, days: [5] }, sun, "UTC"))
      .toMatchObject({ time: "17:00", days: [5] });
    expect(resolveStepTime({ sun: "sunrise" }, sun, "Asia/Jerusalem"))
      .toMatchObject({ time: "05:47" });
  });
  it("passes clock steps through and returns null without sun data", () => {
    expect(resolveStepTime({ time: "18:00" }, sun, "UTC")).toEqual({ time: "18:00" });
    expect(resolveStepTime({ sun: "sunset" }, null, "UTC")).toBeNull();
    expect(resolveStepTime({ sun: "sunset" }, { sunrise: null, sunset: null }, "UTC")).toBeNull();
  });
  it("feeds nextStepFire: unresolved sun steps yield no hint", () => {
    expect(nextStepFire({ sun: "sunset" }, { minutes: 960, day: 4, date: "2026-07-16" })).toBeNull();
  });
});

describe("nextFireLabel", () => {
  it("says today/tomorrow, then weekday, then date for far one-shots", () => {
    expect(nextFireLabel({ dayOffset: 0, time: "18:00" }, NOW)).toBe("today 18:00");
    expect(nextFireLabel({ dayOffset: 1, time: "07:00" }, NOW)).toBe("tomorrow 07:00");
    expect(nextFireLabel({ dayOffset: 2, time: "09:00" }, NOW)).toBe("Sat 09:00");
    expect(nextFireLabel({ dayOffset: 7, time: "09:00" }, NOW)).toBe("Thu 09:00");
    expect(nextFireLabel({ dayOffset: 9, time: "09:00", date: "2026-07-25" }, NOW)).toBe("2026-07-25 09:00");
  });
});
