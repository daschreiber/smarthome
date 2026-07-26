import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  evaluateSaunaFollow, loadSaunawatch, saunaAcDevices, saunaAcFan, saunaAcTemp, saveSaunawatch,
  type SaunawatchState,
} from "../saunawatch";

/**
 * The sauna follower's contract: the Sauna room A/C mirrors the sauna's
 * power EDGES — on-edge starts it at the set-point, off-edge stops it.
 * Unknown status holds; the first readable status after a restart is a
 * baseline, never an action; a human's mid-session A/C change is never
 * fought (no level enforcement at all).
 */

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saunawatch-test-"));
  process.env.SAUNAWATCH_PATH = path.join(dir, "saunawatch.json");
  delete process.env.SAUNA_AC_TEMP;
  delete process.env.SAUNA_AC_FAN;
});

const ON: SaunawatchState = { enabled: true, lastPower: true };
const OFF: SaunawatchState = { enabled: true, lastPower: false };
const FRESH: SaunawatchState = { enabled: true, lastPower: null };

describe("edge detection", () => {
  it("off → on commands the A/C on; on → off commands it off", () => {
    expect(evaluateSaunaFollow(true, OFF)).toEqual({ action: "ac_on", next: { ...OFF, lastPower: true } });
    expect(evaluateSaunaFollow(false, ON)).toEqual({ action: "ac_off", next: { ...ON, lastPower: false } });
  });

  it("no change = no action, in both states (levels never re-assert)", () => {
    expect(evaluateSaunaFollow(true, ON).action).toBeNull();
    expect(evaluateSaunaFollow(false, OFF).action).toBeNull();
  });

  it("unreadable status holds the last known state — never an invented edge", () => {
    for (const st of [ON, OFF, FRESH]) {
      const d = evaluateSaunaFollow(null, st);
      expect(d.action).toBeNull();
      expect(d.next).toEqual(st);
    }
  });

  it("first readable status after a restart is a baseline, not an action", () => {
    const running = evaluateSaunaFollow(true, FRESH);
    expect(running.action).toBeNull();
    expect(running.next.lastPower).toBe(true);
    // ...and the NEXT change acts normally.
    expect(evaluateSaunaFollow(false, running.next).action).toBe("ac_off");
    const cold = evaluateSaunaFollow(false, FRESH);
    expect(cold.action).toBeNull();
    expect(cold.next.lastPower).toBe(false);
  });
});

describe("configuration", () => {
  it("state persists and defaults sanely", () => {
    expect(loadSaunawatch()).toEqual({ enabled: true, lastPower: null });
    saveSaunawatch({ enabled: false, lastPower: true });
    expect(loadSaunawatch()).toEqual({ enabled: false, lastPower: true });
    fs.writeFileSync(process.env.SAUNAWATCH_PATH!, "not json");
    expect(loadSaunawatch()).toEqual({ enabled: true, lastPower: null });
  });

  it("finds the Sauna room's A/C zone in the real entity map", () => {
    expect(saunaAcDevices().map((d) => d.entityId)).toEqual(["climate.ac_heating_a_c_sauna"]);
  });

  it("set-point defaults to 18° and clamps the env override to room bounds", () => {
    expect(saunaAcTemp()).toBe(18);
    process.env.SAUNA_AC_TEMP = "24";
    expect(saunaAcTemp()).toBe(24);
    process.env.SAUNA_AC_TEMP = "5";
    expect(saunaAcTemp()).toBe(10);
    process.env.SAUNA_AC_TEMP = "50";
    expect(saunaAcTemp()).toBe(32);
    process.env.SAUNA_AC_TEMP = "warm";
    expect(saunaAcTemp()).toBe(18);
  });

  it("fan defaults to high (the unit's max) with an env override", () => {
    expect(saunaAcFan()).toBe("high");
    process.env.SAUNA_AC_FAN = "medium";
    expect(saunaAcFan()).toBe("medium");
  });
});
