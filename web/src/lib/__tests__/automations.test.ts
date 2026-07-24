import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AutomationSpecSchema, createAutomation, dueSteps, listAutomations, markFired,
  nowParts, recordHoldReasserts, stepHoldActive, stepIsDue, updateAutomation,
} from "../automations";

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-test-"));
  process.env.AUTOMATIONS_PATH = path.join(dir, "automations.json");
});

const NOW = { hhmm: "16:00", day: 4, date: "2026-07-16" }; // a Thursday

describe("AutomationSpecSchema", () => {
  it("accepts the canonical kitchen example", () => {
    const spec = {
      name: "Kitchen lights, tomorrow afternoon",
      steps: [
        { time: "16:00", date: "2026-07-17", actions: [{ type: "room", room: "Kitchen", command: "lights_on" }] },
        { time: "20:00", date: "2026-07-17", actions: [{ type: "room", room: "Kitchen", command: "lights_off" }] },
      ],
    };
    expect(AutomationSpecSchema.safeParse(spec).success).toBe(true);
  });
  it("rejects bad times and empty actions", () => {
    expect(AutomationSpecSchema.safeParse({ name: "x", steps: [{ time: "25:00", actions: [{ type: "scene", sceneId: "s" }] }] }).success).toBe(false);
    expect(AutomationSpecSchema.safeParse({ name: "x", steps: [{ time: "10:00", actions: [] }] }).success).toBe(false);
  });
});

describe("stepIsDue", () => {
  const base = { time: "16:00", actions: [{ type: "scene" as const, sceneId: "s" }] };
  it("fires on matching time, respects days and dates", () => {
    expect(stepIsDue({ ...base }, NOW)).toBe(true);
    expect(stepIsDue({ ...base, time: "16:01" }, NOW)).toBe(false);
    expect(stepIsDue({ ...base, days: [4] }, NOW)).toBe(true);
    expect(stepIsDue({ ...base, days: [0, 6] }, NOW)).toBe(false);
    expect(stepIsDue({ ...base, date: "2026-07-16" }, NOW)).toBe(true);
    expect(stepIsDue({ ...base, date: "2026-07-17" }, NOW)).toBe(false);
  });
  it("does not double-fire within the same minute", () => {
    expect(stepIsDue({ ...base, lastFired: "2026-07-16T16:00" }, NOW)).toBe(false);
    expect(stepIsDue({ ...base, lastFired: "2026-07-15T16:00" }, NOW)).toBe(true);
  });
});

describe("sun-triggered steps", () => {
  const prevTz = process.env.APP_TZ;
  beforeAll(() => { process.env.APP_TZ = "UTC"; });
  afterAll(() => { process.env.APP_TZ = prevTz; });

  const actions = [{ type: "scene" as const, sceneId: "s" }];
  const at = (hhmm: string) => Date.parse(`2026-07-16T${hhmm}:00Z`); // NOW is 16:00 UTC Thursday

  it("requires exactly one of time or sun, and offsets only with sun", () => {
    const ok = (steps: unknown) => AutomationSpecSchema.safeParse({ name: "x", steps }).success;
    expect(ok([{ sun: "sunset", actions }])).toBe(true);
    expect(ok([{ sun: "sunset", sunOffsetMinutes: -30, days: [5], actions }])).toBe(true);
    expect(ok([{ actions }])).toBe(false); // neither
    expect(ok([{ time: "16:00", sun: "sunset", actions }])).toBe(false); // both
    expect(ok([{ time: "16:00", sunOffsetMinutes: 15, actions }])).toBe(false); // offset without sun
    expect(ok([{ sun: "sunset", sunOffsetMinutes: 500, actions }])).toBe(false); // out of range
  });

  it("fires when an event instant plus offset lands on this minute", () => {
    const sun = { sunrise: [], sunset: [at("16:00")] };
    expect(stepIsDue({ sun: "sunset", actions }, NOW, sun)).toBe(true);
    expect(stepIsDue({ sun: "sunrise", actions }, NOW, sun)).toBe(false);
    expect(stepIsDue({ sun: "sunset", actions }, { ...NOW, hhmm: "16:01" }, sun)).toBe(false);
    // 30 min before an event at 16:30
    expect(stepIsDue({ sun: "sunset", sunOffsetMinutes: -30, actions }, NOW,
      { sunrise: [], sunset: [at("16:30")] })).toBe(true);
    // 30 min after an event that already passed — retained instant still fires
    expect(stepIsDue({ sun: "sunset", sunOffsetMinutes: 30, actions }, NOW,
      { sunrise: [], sunset: [at("15:30"), Date.parse("2026-07-17T15:31:00Z")] })).toBe(true);
  });

  it("respects days, one-shot dates, dedup, and missing sun data", () => {
    const sun = { sunrise: [], sunset: [at("16:00")] };
    expect(stepIsDue({ sun: "sunset", days: [6], actions }, NOW, sun)).toBe(false);
    expect(stepIsDue({ sun: "sunset", days: [4], actions }, NOW, sun)).toBe(true);
    expect(stepIsDue({ sun: "sunset", date: "2026-07-17", actions }, NOW, sun)).toBe(false);
    expect(stepIsDue({ sun: "sunset", lastFired: "2026-07-16T16:00", actions }, NOW, sun)).toBe(false);
    expect(stepIsDue({ sun: "sunset", actions }, NOW, undefined)).toBe(false);
    expect(stepIsDue({ sun: "sunset", actions }, NOW, { sunrise: [], sunset: [] })).toBe(false);
  });
});

describe("store + one-shot lifecycle", () => {
  it("marks fired and self-disables fully-dated automations", () => {
    const a = createAutomation(
      {
        name: "Once",
        steps: [
          { time: "16:00", date: "2026-07-16", actions: [{ type: "room", room: "Kitchen", command: "lights_on" }] },
          { time: "20:00", date: "2026-07-16", actions: [{ type: "room", room: "Kitchen", command: "lights_off" }] },
        ],
      },
      "daniel@x.com",
    );
    expect(dueSteps(listAutomations(), NOW)).toHaveLength(1);
    markFired(a.id, 0, NOW);
    expect(listAutomations()[0].enabled).toBe(true); // second step still pending
    markFired(a.id, 1, { ...NOW, hhmm: "20:00" });
    expect(listAutomations()[0].enabled).toBe(false); // one-shot complete
  });

  it("recurring automations stay enabled after firing", () => {
    const a = createAutomation(
      { name: "Daily", steps: [{ time: "16:00", actions: [{ type: "scene", sceneId: "cozy" }] }] },
      "daniel@x.com",
    );
    markFired(a.id, 0, NOW);
    expect(listAutomations()[0].enabled).toBe(true);
    expect(dueSteps(listAutomations(), NOW)).toHaveLength(0); // fired this minute
    expect(dueSteps(listAutomations(), { ...NOW, date: "2026-07-17", day: 5 })).toHaveLength(1);
  });
});

describe("nowParts", () => {
  it("formats wall-clock parts in a fixed timezone", () => {
    const p = nowParts(new Date("2026-07-16T13:00:00Z"), "Asia/Jerusalem");
    expect(p).toEqual({ hhmm: "16:00", day: 4, date: "2026-07-16" });
  });
});

describe("updateAutomation", () => {
  it("replaces name and steps in place, keeps id/enabled/creator, resets firing", () => {
    const a = createAutomation(
      { name: "Old", steps: [{ time: "16:00", actions: [{ type: "scene", sceneId: "s" }], lastFired: "2026-07-16T16:00" }] },
      "daniel@x.com",
    );
    const updated = updateAutomation(a.id, {
      name: "New name",
      steps: [{ time: "07:30", days: [1], actions: [{ type: "room", room: "Kitchen", command: "lights_on" }] }],
    });
    expect(updated.id).toBe(a.id);
    expect(updated.enabled).toBe(true);
    expect(updated.createdBy).toBe("daniel@x.com");
    expect(updated.name).toBe("New name");
    expect(updated.steps[0].time).toBe("07:30");
    expect(updated.steps[0].lastFired).toBeUndefined();
    expect(listAutomations()).toHaveLength(1); // in place, not duplicated
  });
  it("throws for an unknown id", () => {
    expect(() => updateAutomation("nope", { name: "x", steps: [{ time: "10:00", actions: [{ type: "scene", sceneId: "s" }] }] })).toThrow();
  });
});

describe("holdUntil", () => {
  const actions = [{ type: "device" as const, deviceId: "balcony_6th__balcony_plants", command: { command: "turn_on" } }];
  it("schema accepts a valid hold time and rejects garbage", () => {
    const ok = (extra: object) =>
      AutomationSpecSchema.safeParse({ name: "x", steps: [{ sun: "sunset", sunOffsetMinutes: -15, actions, ...extra }] }).success;
    expect(ok({ holdUntil: "02:00" })).toBe(true);
    expect(ok({})).toBe(true);
    expect(ok({ holdUntil: "26:00" })).toBe(false);
    expect(ok({ holdUntil: "2am" })).toBe(false);
  });
  it("hold window opens after the firing minute and closes at holdUntil, crossing midnight", () => {
    // Fired at 19:29 with hold until 02:00 — the balcony case.
    const step = { sun: "sunset" as const, sunOffsetMinutes: -15, actions, holdUntil: "02:00", lastFired: "2026-07-23T19:29" };
    const at = (date: string, hhmm: string) => stepHoldActive(step, { hhmm, day: 4, date });
    expect(at("2026-07-23", "19:29")).toBe(false); // firing minute itself: actions just ran
    expect(at("2026-07-23", "19:30")).toBe(true);
    expect(at("2026-07-23", "23:59")).toBe(true);
    expect(at("2026-07-24", "00:00")).toBe(true);
    expect(at("2026-07-24", "01:59")).toBe(true);
    expect(at("2026-07-24", "02:00")).toBe(false); // hand-off to the 02:00 off-automation
    expect(at("2026-07-24", "12:00")).toBe(false);
  });
  it("same-day hold when holdUntil is later on the clock than the firing time", () => {
    const step = { time: "08:00", actions, holdUntil: "17:00", lastFired: "2026-07-23T08:00" };
    expect(stepHoldActive(step, { hhmm: "12:00", day: 4, date: "2026-07-23" })).toBe(true);
    expect(stepHoldActive(step, { hhmm: "17:00", day: 4, date: "2026-07-23" })).toBe(false);
    expect(stepHoldActive(step, { hhmm: "12:00", day: 5, date: "2026-07-24" })).toBe(false); // stale firing
  });
  it("no hold without holdUntil or before the step has ever fired", () => {
    const now = { hhmm: "20:00", day: 4, date: "2026-07-23" };
    expect(stepHoldActive({ time: "19:00", actions, lastFired: "2026-07-23T19:00" }, now)).toBe(false);
    expect(stepHoldActive({ time: "19:00", actions, holdUntil: "02:00" }, now)).toBe(false);
  });
  it("markFired resets the re-assert budget; recordHoldReasserts persists it", () => {
    const a = createAutomation(
      { name: "Balcony lights", steps: [{ time: "19:29", actions, holdUntil: "02:00" }] },
      "daniel@x.com",
    );
    recordHoldReasserts(a.id, 0, 3);
    expect(listAutomations()[0].steps[0].holdReasserts).toBe(3);
    markFired(a.id, 0, { hhmm: "19:29", day: 4, date: "2026-07-23" });
    expect(listAutomations()[0].steps[0].holdReasserts).toBe(0);
  });
});
