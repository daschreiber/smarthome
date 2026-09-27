import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FITNESS_APP_ID, FITNESS_POLL_MS, FITNESS_WAIT_MS, GYM_LIGHTS_ENTITY, GYM_TV_ENTITY, _resetGymwatchForTests,
  evaluateGymFollow, gymTvDevice, gymwatchAvailable, lightsOnFromState, loadGymwatch, saveGymwatch,
  tickGymwatch, tvOnFromState, type GymwatchState,
} from "../gymwatch";
import { callService, getState } from "../ha";
import { executeOnDevice } from "../execute";
import { audit } from "../audit";

vi.mock("../ha", () => ({ getState: vi.fn(), getStates: vi.fn(), callService: vi.fn() }));
vi.mock("../execute", () => ({ executeOnDevice: vi.fn() }));
vi.mock("../audit", () => ({ audit: vi.fn() }));

/**
 * The Gym TV follows the gym lights (owner, 2026-09-27): lights on → TV on,
 * lights off → TV off, on the edge only; the off only at a TV that reads on.
 */

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gymwatch-test-"));
  process.env.GYMWATCH_PATH = path.join(dir, "gymwatch.json");
  _resetGymwatchForTests();
  vi.mocked(getState).mockReset();
  vi.mocked(callService).mockReset();
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

  it("no change, an unreadable light, or a first reading with no baseline acts on nothing", () => {
    expect(evaluateGymFollow(true, ON).action).toBeNull();
    expect(evaluateGymFollow(null, ON)).toEqual({ action: null, next: ON });
    expect(evaluateGymFollow(true, { enabled: true, lastLightsOn: null })).toEqual({ action: null, next: ON });
  });
});

describe("the state file", () => {
  it("missing: a fresh, enabled start", () => {
    expect(loadGymwatch()).toEqual({ enabled: true, lastLightsOn: null });
  });

  it("corrupt: an error, not a silent re-enable, and nothing is sent", async () => {
    fs.writeFileSync(process.env.GYMWATCH_PATH!, '{"enabled": fal');
    expect(() => loadGymwatch()).toThrow(/not valid JSON/);
    vi.mocked(getState).mockImplementation(states("on", "off"));
    await expect(tickGymwatch()).rejects.toThrow();
    expect(executeOnDevice).not.toHaveBeenCalled();
    expect(fs.readFileSync(process.env.GYMWATCH_PATH!, "utf8")).toBe('{"enabled": fal');
  });

  it("the baseline survives a restart, so a change during a deploy is followed", async () => {
    saveGymwatch(OFF); // written by the previous process
    vi.mocked(getState).mockImplementation(states("on", "off"));
    await tickGymwatch();
    expect(executeOnDevice).toHaveBeenCalledWith(expect.objectContaining({ entityId: GYM_TV_ENTITY }), { command: "turn_on" });
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

  it("the TV is read only on an off edge, after the lights, so a TV switched off meanwhile is not toggled back on", async () => {
    saveGymwatch(ON);
    const order: string[] = [];
    vi.mocked(getState).mockImplementation(async (id: string) => {
      order.push(id);
      return { state: "off" } as never;
    });
    await tickGymwatch();
    expect(order).toEqual([GYM_LIGHTS_ENTITY, GYM_TV_ENTITY]);
    expect(executeOnDevice).not.toHaveBeenCalled();

    vi.mocked(getState).mockClear();
    vi.mocked(getState).mockImplementation(states("off", "on"));
    await tickGymwatch(); // no edge: the TV is not read at all
    expect(vi.mocked(getState).mock.calls.map((c) => c[0])).toEqual([GYM_LIGHTS_ENTITY]);
  });

  it("overlapping passes: a second tick while one is in flight is skipped", async () => {
    saveGymwatch(ON);
    let release!: () => void;
    vi.mocked(getState).mockImplementation(async (id: string) => {
      if (id === GYM_TV_ENTITY) await new Promise<void>((r) => { release = r; });
      return { state: id === GYM_LIGHTS_ENTITY ? "off" : "on" } as never;
    });
    const first = tickGymwatch();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await tickGymwatch(); // overlaps: returns without reading anything
    expect(vi.mocked(getState).mock.calls.map((c) => c[0])).toEqual([GYM_LIGHTS_ENTITY, GYM_TV_ENTITY]);
    release();
    await first;
    expect(executeOnDevice).toHaveBeenCalledTimes(1);
    expect(executeOnDevice).toHaveBeenCalledWith(expect.anything(), { command: "turn_off" });
  });

  it("the lights come back on while the TV is being read: the stale off is dropped", async () => {
    saveGymwatch(ON);
    vi.mocked(getState).mockImplementation(async (id: string) => {
      if (id === GYM_TV_ENTITY) saveGymwatch(ON); // a newer edge was recorded meanwhile
      return { state: id === GYM_LIGHTS_ENTITY ? "off" : "on" } as never;
    });
    await tickGymwatch();
    expect(executeOnDevice).not.toHaveBeenCalled();
  });

  it("an unreadable TV at the off edge is skipped, not guessed", async () => {
    saveGymwatch(ON);
    vi.mocked(getState).mockImplementation(async (id: string) => {
      if (id === GYM_TV_ENTITY) throw new Error("HA timeout");
      return { state: "off" } as never;
    });
    await tickGymwatch();
    expect(executeOnDevice).not.toHaveBeenCalled();
    expect(vi.mocked(audit).mock.calls[0][0]).toMatchObject({ command: "gym_tv_off", args: { skipped: "TV reads unreadable" } });
  });

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

describe("Apple Fitness: the Apple TV app opens once the rule has woken the TV", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const launches = () => vi.mocked(callService).mock.calls.filter((c) => c[1] === "play_media");
  const appAudit = () => vi.mocked(audit).mock.calls.map((c) => c[0]).find((a) => a.command === "gym_tv_app");

  /** Lights on; the TV reads off until `wakesAfter` reads of it, then on. */
  const waking = (wakesAfter: number) => {
    let tvReads = 0;
    vi.mocked(getState).mockImplementation(async (id: string) => {
      if (id === GYM_LIGHTS_ENTITY) return { state: "on" } as never;
      return { state: tvReads++ < wakesAfter ? "off" : "on" } as never;
    });
  };

  it("lights on, TV off → turn_on, then the Apple TV app once the TV reads on", async () => {
    saveGymwatch(OFF);
    waking(3); // the read at the edge, then two polls still off
    await tickGymwatch();
    expect(executeOnDevice).toHaveBeenCalledWith(expect.anything(), { command: "turn_on" });
    expect(launches()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FITNESS_POLL_MS * 3);
    expect(launches()).toEqual([
      ["media_player", "play_media", { entity_id: GYM_TV_ENTITY, media_content_type: "app", media_content_id: FITNESS_APP_ID }],
    ]);
    expect(appAudit()).toMatchObject({ ok: true, args: { app: FITNESS_APP_ID } });
  });

  it("a TV already on is left on whatever it shows", async () => {
    saveGymwatch(OFF);
    vi.mocked(getState).mockImplementation(states("on", "playing"));
    await tickGymwatch();
    await vi.advanceTimersByTimeAsync(FITNESS_WAIT_MS * 2);
    expect(launches()).toHaveLength(0);
  });

  it("an unreadable TV at the edge: no app (it might be showing something)", async () => {
    saveGymwatch(OFF);
    vi.mocked(getState).mockImplementation(states("on", "unavailable"));
    await tickGymwatch();
    await vi.advanceTimersByTimeAsync(FITNESS_WAIT_MS * 2);
    expect(launches()).toHaveLength(0);
  });

  it("the lights go off before the TV wakes: given up, audited", async () => {
    saveGymwatch(OFF);
    waking(100);
    await tickGymwatch();
    saveGymwatch(OFF); // the next tick recorded the lights going off
    await vi.advanceTimersByTimeAsync(FITNESS_POLL_MS);
    expect(launches()).toHaveLength(0);
    expect(appAudit()).toMatchObject({ args: { skipped: expect.stringContaining("lights off") } });
  });

  it("paused meanwhile: given up", async () => {
    saveGymwatch(OFF);
    waking(100);
    await tickGymwatch();
    saveGymwatch({ enabled: false, lastLightsOn: true });
    await vi.advanceTimersByTimeAsync(FITNESS_WAIT_MS);
    expect(launches()).toHaveLength(0);
  });

  it("a TV that never wakes: given up after the wait, audited as a failure", async () => {
    saveGymwatch(OFF);
    waking(1_000);
    await tickGymwatch();
    await vi.advanceTimersByTimeAsync(FITNESS_WAIT_MS + FITNESS_POLL_MS);
    expect(launches()).toHaveLength(0);
    expect(appAudit()).toMatchObject({ ok: false, args: { skipped: expect.stringContaining("not on within") } });
  });

  it("a failed turn_on opens nothing", async () => {
    saveGymwatch(OFF);
    waking(0);
    vi.mocked(executeOnDevice).mockRejectedValue(new Error("HA 500"));
    await tickGymwatch();
    await vi.advanceTimersByTimeAsync(FITNESS_WAIT_MS);
    expect(launches()).toHaveLength(0);
  });

  it("a failed launch is audited, not thrown", async () => {
    saveGymwatch(OFF);
    waking(1);
    vi.mocked(callService).mockRejectedValue(new Error("HTTP 400"));
    await tickGymwatch();
    await vi.advanceTimersByTimeAsync(FITNESS_POLL_MS);
    expect(appAudit()).toMatchObject({ ok: false, error: "HTTP 400" });
  });

  it("the tick doesn't wait for the TV to wake", async () => {
    saveGymwatch(OFF);
    waking(1_000);
    await expect(tickGymwatch()).resolves.toBeUndefined(); // no timers advanced
    expect(executeOnDevice).toHaveBeenCalledTimes(1);
  });
});
