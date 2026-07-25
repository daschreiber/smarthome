import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { automationActiveNow, isAway, loadAway, setAway } from "../away";
import { createAutomation, listAutomations, setActiveWhen } from "../automations";

/**
 * Away mode's contract (owner-revised 2026-07-25 — away does NOT stop
 * everything): one house flag, default HOME, and each automation carries
 * an activeWhen mode. "always" is the default — an automation nobody has
 * thought about keeps working whatever the switch says. "home" pauses
 * while away; "away" runs only while away (presence lighting).
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

describe("automationActiveNow", () => {
  it("absent or 'always' runs in both states — the default changes nothing", () => {
    for (const a of [{}, { activeWhen: "always" as const }]) {
      expect(automationActiveNow(a, false)).toBe(true);
      expect(automationActiveNow(a, true)).toBe(true);
    }
  });

  it("'home' runs at home, pauses away; 'away' is the mirror", () => {
    expect(automationActiveNow({ activeWhen: "home" }, false)).toBe(true);
    expect(automationActiveNow({ activeWhen: "home" }, true)).toBe(false);
    expect(automationActiveNow({ activeWhen: "away" }, false)).toBe(false);
    expect(automationActiveNow({ activeWhen: "away" }, true)).toBe(true);
  });

  it("filters a mixed list the way the scheduler does, in both states", () => {
    const auts = [
      { id: "morning_shades" },
      { id: "evening_ac", activeWhen: "home" as const },
      { id: "presence_lights", activeWhen: "away" as const },
    ];
    expect(auts.filter((a) => automationActiveNow(a, false)).map((a) => a.id))
      .toEqual(["morning_shades", "evening_ac"]);
    expect(auts.filter((a) => automationActiveNow(a, true)).map((a) => a.id))
      .toEqual(["morning_shades", "presence_lights"]);
  });
});

describe("activeWhen in the automation store", () => {
  const spec = {
    name: "Balcony lights at sunset",
    steps: [{ time: "20:00", actions: [{ type: "room" as const, room: "Balcony", command: "lights_on" as const }] }],
  };

  it("defaults to always and round-trips each mode", () => {
    const a = createAutomation(spec, "daniel");
    expect(automationActiveNow(listAutomations()[0], true)).toBe(true); // default: away changes nothing
    setActiveWhen(a.id, "home");
    expect(listAutomations()[0].activeWhen).toBe("home");
    setActiveWhen(a.id, "away");
    expect(listAutomations()[0].activeWhen).toBe("away");
    setActiveWhen(a.id, "always");
    expect(listAutomations()[0].activeWhen).toBe("always");
    expect(() => setActiveWhen("nope", "home")).toThrow();
  });

  it("migrates the legacy awayBehavior field: explicit 'pause' → 'home', the rest → default", () => {
    const legacy = [
      { id: "a", name: "A", steps: spec.steps, enabled: true, createdBy: "d", createdAt: "t", awayBehavior: "pause" },
      { id: "b", name: "B", steps: spec.steps, enabled: true, createdBy: "d", createdAt: "t", awayBehavior: "run" },
      { id: "c", name: "C", steps: spec.steps, enabled: true, createdBy: "d", createdAt: "t" },
    ];
    fs.writeFileSync(process.env.AUTOMATIONS_PATH!, JSON.stringify(legacy));
    const items = listAutomations() as unknown as Array<Record<string, unknown>>;
    expect(items.find((x) => x.id === "a")?.activeWhen).toBe("home");
    expect(items.find((x) => x.id === "b")?.activeWhen).toBeUndefined(); // = always
    expect(items.find((x) => x.id === "c")?.activeWhen).toBeUndefined(); // = always
    for (const x of items) expect(x.awayBehavior).toBeUndefined();
  });
});
