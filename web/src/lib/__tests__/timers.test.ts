import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createTimer, deleteTimer, dueTimers, listTimers, setTimerEnabled } from "../timers";
import { registry } from "../registry";
import type { HaState } from "../ha";

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "timers-test-"));
  process.env.TIMERS_PATH = path.join(dir, "timers.json");
});

const light = registry().devices.find((d) => d.visible && d.kind === "light" && d.category !== "scene_switch")!;

function state(s: string, changedMsAgo: number, nowMs: number): HaState {
  return {
    entity_id: light.entityId,
    state: s,
    attributes: {},
    last_updated: new Date(nowMs - changedMsAgo).toISOString(),
    last_changed: new Date(nowMs - changedMsAgo).toISOString(),
  };
}

describe("timer store", () => {
  it("creates, lists, toggles, and deletes rules", () => {
    const rule = createTimer(light.id, 20, "dan@x.com");
    expect(listTimers()).toHaveLength(1);
    setTimerEnabled(rule.id, false);
    expect(listTimers()[0].enabled).toBe(false);
    deleteTimer(rule.id);
    expect(listTimers()).toHaveLength(0);
  });

  it("rejects unknown devices, bad durations, and duplicates", () => {
    expect(() => createTimer("nope", 20, "u")).toThrow(/unknown device/);
    expect(() => createTimer(light.id, 0, "u")).toThrow(/between/);
    expect(() => createTimer(light.id, 100000, "u")).toThrow(/between/);
    createTimer(light.id, 20, "u");
    expect(() => createTimer(light.id, 30, "u")).toThrow(/already/);
  });

  it("never accepts the sauna", () => {
    const sauna = registry().devices.find((d) => d.kind === "sauna");
    if (sauna) expect(() => createTimer(sauna.id, 20, "u")).toThrow(/sauna/);
  });
});

describe("dueTimers", () => {
  const now = 1_750_000_000_000;

  it("fires only when the device has been ON longer than the rule allows", () => {
    const rule = createTimer(light.id, 20, "u");
    const on25min = new Map([[light.entityId, state("on", 25 * 60_000, now)]]);
    const on5min = new Map([[light.entityId, state("on", 5 * 60_000, now)]]);
    const off = new Map([[light.entityId, state("off", 60 * 60_000, now)]]);

    expect(dueTimers([rule], on25min, now).map((d) => d.device.id)).toEqual([light.id]);
    expect(dueTimers([rule], on5min, now)).toHaveLength(0);
    expect(dueTimers([rule], off, now)).toHaveLength(0);
  });

  it("skips disabled rules and missing states", () => {
    const rule = { ...createTimer(light.id, 20, "u"), enabled: false };
    const on25min = new Map([[light.entityId, state("on", 25 * 60_000, now)]]);
    expect(dueTimers([rule], on25min, now)).toHaveLength(0);
    expect(dueTimers([{ ...rule, enabled: true }], new Map(), now)).toHaveLength(0);
  });
});
