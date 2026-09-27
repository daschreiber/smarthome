import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GYM_LIGHTS_ENTITY, GYM_TV_ENTITY, evaluateGymFollow, gymTvDevice, gymwatchAvailable,
  lightsOnFromState, loadGymwatch, saveGymwatch, tickGymwatch, tvOnFromState, type GymwatchState,
} from "../gymwatch";
import { getState } from "../ha";
import { executeOnDevice } from "../execute";
import { audit } from "../audit";

vi.mock("../ha", () => ({ getState: vi.fn(), getStates: vi.fn() }));
vi.mock("../execute", () => ({ executeOnDevice: vi.fn() }));
vi.mock("../audit", () => ({ audit: vi.fn() }));

/**
 * The Gym TV follows the gym lights (owner, 2026-09-27): lights on → TV on,
 * lights off → TV off, on the edge only; the off only at a TV that reads on.
 */

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gymwatch-test-"));
  process.env.GYMWATCH_PATH = path.join(dir, "gymwatch.json");
  vi.mocked(getState).mockReset();
  vi.mocked(executeOnDevice).mockReset();
  vi.mocked(audit).mockClear();
});

const OFF: GymwatchState = { enabled: true, lastLightsOn: false };
const ON: GymwatchState = { enabled: true, lastLightsOn: true };

/** Lights and TV read independently. */
const states = (lights: string, tv: string) => async (id: string) =>
  ({ state: id === GYM_LIGHTS_ENTITY ? lights : tv }) as never;

describe("the map", () => {
  it("has the Gym TV as a Gym media card, and the follower is available", () => {
    expect(gymTvDevice()).toMatchObject({ id: "gym__gym_tv", entityId: GYM_TV_ENTITY, room: "Gym", kind: "media_player" });
    expect(gymwatchAvailable()).toBe(true);
  });
});

describe("state mapping", () => {
  it("lights: only on and off are evidence", () => {
    expect(lightsOnFromState("on")).toBe(true);
    expect(lightsOnFromState("off")).toBe(false);
    for (const s of ["unavailable", "unknown", undefined, null]) expect(lightsOnFromState(s)).toBeNull();
  });

  it("TV: playing/idle/on read as on; off/standby as off; the rest proves nothing", () => {
    for (const s of ["on", "playing", "paused", "idle", "buffering"]) expect(tvOnFromState(s)).toBe(true);
    for (const s of ["off", "standby"]) expect(tvOnFromState(s)).toBe(false);
    for (const s of ["unavailable", "unknown", undefined]) expect(tvOnFromState(s)).toBeNull();
  });
});

describe("edge detection", () => {
  it("off → on is tv_on; on → off is tv_off", () => {
    expect(evaluateGymFollow(true, OFF)).toEqual({ action: "tv_on", next: ON });
    expect(evaluateGymFollow(false, ON)).toEqual({ action: "tv_off", next: OFF });
  });

  it("no change, an unreadable light, or a first reading after a restart acts on nothing", () => {
    expect(evaluateGymFollow(true, ON).action).toBeNull();
    expect(evaluateGymFollow(null, ON)).toEqual({ action: null, next: ON });
    expect(evaluateGymFollow(true, { enabled: true, lastLightsOn: null })).toEqual({ action: null, next: ON });
  });
});

describe("tick", () => {
  it("lights on → the Gym TV gets turn_on", async () => {
    saveGymwatch(OFF);
    vi.mocked(getState).mockImplementation(states("on", "off"));
    await tickGymwatch();
    expect(executeOnDevice).toHaveBeenCalledWith(expect.objectContaining({ entityId: GYM_TV_ENTITY }), { command: "turn_on" });
    expect(loadGymwatch()).toEqual(ON);
    expect(vi.mocked(audit).mock.calls[0][0]).toMatchObject({ command: "gym_tv_on", ok: true });
  });

  it("lights off with the TV on → turn_off", async () => {
    saveGymwatch(ON);
    vi.mocked(getState).mockImplementation(states("off", "playing"));
    await tickGymwatch();
    expect(executeOnDevice).toHaveBeenCalledWith(expect.objectContaining({ entityId: GYM_TV_ENTITY }), { command: "turn_off" });
    expect(loadGymwatch()).toEqual(OFF);
  });

  it.each(["off", "standby", "unavailable", "unknown"])(
    "lights off with the TV reading %s → nothing sent (a power-key off could switch it on), but the skip is audited",
    async (tv) => {
      saveGymwatch(ON);
      vi.mocked(getState).mockImplementation(states("off", tv));
      await tickGymwatch();
      expect(executeOnDevice).not.toHaveBeenCalled();
      expect(loadGymwatch()).toEqual(OFF);
      expect(vi.mocked(audit).mock.calls[0][0]).toMatchObject({ command: "gym_tv_off", args: { skipped: expect.stringContaining(tv) } });
    },
  );

  it("dimming (lights stay on) and steady states send nothing", async () => {
    saveGymwatch(ON);
    vi.mocked(getState).mockImplementation(states("on", "on"));
    await tickGymwatch();
    await tickGymwatch();
    expect(executeOnDevice).not.toHaveBeenCalled();
  });

  it("a TV switched off by hand with the lights on is not switched back on", async () => {
    saveGymwatch(ON);
    vi.mocked(getState).mockImplementation(states("on", "off"));
    await tickGymwatch();
    expect(executeOnDevice).not.toHaveBeenCalled();
  });

  it("a failed command is audited, not thrown", async () => {
    saveGymwatch(OFF);
    vi.mocked(getState).mockImplementation(states("on", "off"));
    vi.mocked(executeOnDevice).mockRejectedValue(new Error("HA 500"));
    await expect(tickGymwatch()).resolves.toBeUndefined();
    expect(vi.mocked(audit).mock.calls[0][0]).toMatchObject({ command: "gym_tv_on", ok: false, error: "HA 500" });
  });

  it("paused: nothing is read or sent; a pause flipped mid-tick wins", async () => {
    saveGymwatch({ enabled: false, lastLightsOn: false });
    vi.mocked(getState).mockImplementation(states("on", "off"));
    await tickGymwatch();
    expect(getState).not.toHaveBeenCalled();

    saveGymwatch(OFF);
    vi.mocked(getState).mockImplementation(async (id: string) => {
      if (id === GYM_LIGHTS_ENTITY) saveGymwatch({ enabled: false, lastLightsOn: null });
      return { state: id === GYM_LIGHTS_ENTITY ? "on" : "off" } as never;
    });
    await tickGymwatch();
    expect(executeOnDevice).not.toHaveBeenCalled();
    expect(loadGymwatch()).toEqual({ enabled: false, lastLightsOn: null });
  });
});
