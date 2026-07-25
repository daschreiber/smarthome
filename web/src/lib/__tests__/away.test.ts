import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { isAway, loadAway, runsWhileAway, setAway } from "../away";
import { createAutomation, listAutomations, setAwayBehavior } from "../automations";

/**
 * Away mode's contract: a single house flag, default HOME. Scheduled
 * automations pause under it unless explicitly marked "run" — the default
 * is the whole point (nobody flips twelve toggles before a trip), the
 * exception is how presence lighting keeps firing in an empty house.
 */

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "away-test-"));
  process.env.AWAY_PATH = path.join(dir, "away.json");
  process.env.AUTOMATIONS_PATH = path.join(dir, "automations.json");
});

describe("away state", () => {
  it("defaults to home when no file exists", () => {
    expect(loadAway()).toEqual({ away: false });
    expect(isAway()).toBe(false);
  });

  it("persists the flip with who and when", () => {
    setAway(true, "daniel");
    const st = loadAway();
    expect(st.away).toBe(true);
    expect(st.setBy).toBe("daniel");
    expect(Date.parse(st.since!)).not.toBeNaN();
    expect(isAway()).toBe(true);
    setAway(false, "daniel");
    expect(isAway()).toBe(false);
  });

  it("treats a corrupt file as home — a broken flag must never strand the schedules", () => {
    fs.writeFileSync(process.env.AWAY_PATH!, "not json");
    expect(isAway()).toBe(false);
  });
});

describe("runsWhileAway", () => {
  it("pauses by default; only an explicit 'run' keeps an automation firing", () => {
    expect(runsWhileAway({})).toBe(false);
    expect(runsWhileAway({ awayBehavior: "pause" })).toBe(false);
    expect(runsWhileAway({ awayBehavior: "run" })).toBe(true);
  });

  it("round-trips through the automation store", () => {
    const spec = {
      name: "Balcony lights at sunset",
      steps: [{ time: "20:00", actions: [{ type: "room" as const, room: "Balcony", command: "lights_on" as const }] }],
    };
    const a = createAutomation(spec, "daniel");
    expect(runsWhileAway(listAutomations()[0])).toBe(false);
    setAwayBehavior(a.id, "run");
    expect(runsWhileAway(listAutomations()[0])).toBe(true);
    setAwayBehavior(a.id, "pause");
    expect(runsWhileAway(listAutomations()[0])).toBe(false);
    expect(() => setAwayBehavior("nope", "run")).toThrow();
  });

  it("filters a mixed list the way the scheduler does", () => {
    const auts = [
      { id: "morning_shades", awayBehavior: undefined },
      { id: "presence_lights", awayBehavior: "run" as const },
      { id: "evening_ac", awayBehavior: "pause" as const },
    ];
    const active = auts.filter(runsWhileAway).map((a) => a.id);
    expect(active).toEqual(["presence_lights"]);
  });
});
