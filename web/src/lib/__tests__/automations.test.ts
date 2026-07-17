import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AutomationSpecSchema, createAutomation, dueSteps, listAutomations, markFired,
  nowParts, stepIsDue,
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
