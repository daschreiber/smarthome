import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_OFF_ATTEMPTS, TV_ENTITY, evaluateTvFollow, liftDownFromState, loadLiftwatch,
  offHoldSecs, offKey, saveLiftwatch, tickLiftwatch, tvDevice, tvOnFromState,
  tvRemoteEntity, type LiftwatchState,
} from "../liftwatch";
import { TV_LIFT_ENTITY } from "../sleepwatch";
import { callService, getState } from "../ha";
import { executeOnDevice } from "../execute";

vi.mock("../ha", () => ({ getState: vi.fn(), callService: vi.fn() }));
vi.mock("../execute", () => ({ executeOnDevice: vi.fn() }));
vi.mock("../audit", () => ({ audit: vi.fn() }));

/**
 * The TV follower's contract, after the 2026-08-30 field test: the ON side
 * is an edge (the TV comes on exactly once per lowering; a remote-control
 * off mid-session is never fought), while the OFF side is the edge plus
 * bounded enforcement — a TV that still reads "on" with the lift up keeps
 * getting turn_off, up to MAX_OFF_ATTEMPTS per stow, because a TV inside
 * the ceiling is never a human's choice. Unknown states hold; the first
 * readable lift state after a restart is a baseline, never an action.
 */

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liftwatch-test-"));
  process.env.LIFTWATCH_PATH = path.join(dir, "liftwatch.json");
  delete process.env.SLEEPWATCH_LIFT_STATE;
  delete process.env.LIFTWATCH_TV_REMOTE;
  delete process.env.LIFTWATCH_OFF_KEY;
  delete process.env.LIFTWATCH_OFF_HOLD_SECS;
});

const DOWN: LiftwatchState = { enabled: true, lastDown: true, offAttempts: 0 };
const UP: LiftwatchState = { enabled: true, lastDown: false };
const FRESH: LiftwatchState = { enabled: true, lastDown: null };

describe("edge detection", () => {
  it("up → down commands the TV on; down → up commands it off", () => {
    expect(evaluateTvFollow(true, null, UP)).toEqual({
      action: "tv_on", next: { ...UP, lastDown: true, offAttempts: 0 },
    });
    expect(evaluateTvFollow(false, null, DOWN)).toEqual({
      action: "tv_off", next: { ...DOWN, lastDown: false, offAttempts: 1 },
    });
  });

  it("the ON side never re-asserts: TV off by remote with the lift down stays off", () => {
    expect(evaluateTvFollow(true, false, DOWN).action).toBeNull();
  });

  it("unreadable relay state holds — never an invented edge, even with the TV readable", () => {
    for (const st of [DOWN, UP, FRESH]) {
      const d = evaluateTvFollow(null, true, st);
      expect(d.action).toBeNull();
      expect(d.next).toEqual(st);
    }
  });

  it("first readable state after a restart is a baseline, not an action", () => {
    const down = evaluateTvFollow(true, true, FRESH);
    expect(down.action).toBeNull();
    expect(down.next.lastDown).toBe(true);
    // ...and the NEXT movement acts normally.
    expect(evaluateTvFollow(false, true, down.next).action).toBe("tv_off");
    const up = evaluateTvFollow(false, true, FRESH);
    expect(up.action).toBeNull();
    expect(up.next.lastDown).toBe(false);
  });
});

describe("off enforcement (the 2026-08-30 stranded-on TV)", () => {
  it("a TV still on with the lift up is switched off — no edge required", () => {
    // The exact field failure: baseline re-learned as "up" after a deploy,
    // TV left playing inside the ceiling. The tick after the baseline acts.
    const d = evaluateTvFollow(false, true, { ...UP, offAttempts: 0 });
    expect(d.action).toBe("tv_off");
    expect(d.next.offAttempts).toBe(1);
  });

  it("enforcement stops after MAX_OFF_ATTEMPTS, and never fires on TV off/unknown", () => {
    let st: LiftwatchState = { ...DOWN };
    // Edge plus enforcement: exactly MAX_OFF_ATTEMPTS commands in total.
    for (let i = 0; i < MAX_OFF_ATTEMPTS; i++) {
      const d = evaluateTvFollow(false, true, st);
      expect(d.action).toBe("tv_off");
      st = d.next;
    }
    expect(evaluateTvFollow(false, true, st).action).toBeNull();
    // Off or unknown TV never draws an enforcement command.
    expect(evaluateTvFollow(false, false, { ...UP, offAttempts: 0 }).action).toBeNull();
    expect(evaluateTvFollow(false, null, { ...UP, offAttempts: 0 }).action).toBeNull();
  });

  it("the next lowering resets the attempt budget", () => {
    const spent: LiftwatchState = { enabled: true, lastDown: false, offAttempts: MAX_OFF_ATTEMPTS };
    const down = evaluateTvFollow(true, null, spent);
    expect(down.action).toBe("tv_on");
    expect(down.next.offAttempts).toBe(0);
    expect(evaluateTvFollow(false, true, down.next).action).toBe("tv_off");
  });
});

describe("state mapping", () => {
  it('default household convention: relay "on" = lift down, "off" = stowed', () => {
    expect(liftDownFromState("on")).toBe(true);
    expect(liftDownFromState("off")).toBe(false);
  });

  it("SLEEPWATCH_LIFT_STATE flips the follower and Sleep sense together", () => {
    process.env.SLEEPWATCH_LIFT_STATE = "on";
    expect(liftDownFromState("on")).toBe(false);
    expect(liftDownFromState("off")).toBe(true);
  });

  it("anything but the two real relay states is unknown, not a position", () => {
    for (const s of ["unavailable", "unknown", "", undefined, null]) {
      expect(liftDownFromState(s)).toBeNull();
    }
  });

  it("TV power: powered states are on, off/standby off, the rest unknown", () => {
    for (const s of ["on", "playing", "paused", "idle", "buffering"]) {
      expect(tvOnFromState(s)).toBe(true);
    }
    expect(tvOnFromState("off")).toBe(false);
    expect(tvOnFromState("standby")).toBe(false);
    for (const s of ["unavailable", "unknown", undefined, null]) {
      expect(tvOnFromState(s)).toBeNull();
    }
  });
});

describe("tick vs. a concurrent pause", () => {
  beforeEach(() => {
    vi.mocked(getState).mockReset();
    vi.mocked(executeOnDevice).mockReset();
  });

  it("a pause flipped while HA was being polled wins — no command, no un-pause", async () => {
    saveLiftwatch({ enabled: true, lastDown: false });
    vi.mocked(getState).mockImplementation(async (id: string) => {
      // The admin pauses (resetting the baseline, exactly as the API route
      // does) while the requests are in flight.
      if (id === TV_LIFT_ENTITY) {
        saveLiftwatch({ enabled: false, lastDown: null });
        return { state: "on" } as never;
      }
      return { state: "off" } as never;
    });
    await tickLiftwatch();
    expect(executeOnDevice).not.toHaveBeenCalled();
    expect(loadLiftwatch()).toEqual({ enabled: false, lastDown: null });
  });

  it("an ordinary edge still commands the TV and advances the baseline", async () => {
    saveLiftwatch({ enabled: true, lastDown: false });
    vi.mocked(getState).mockImplementation(async (id: string) =>
      ({ state: id === TV_LIFT_ENTITY ? "on" : "off" }) as never,
    );
    await tickLiftwatch();
    expect(executeOnDevice).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: TV_ENTITY }),
      { command: "turn_on" },
    );
    expect(loadLiftwatch()).toEqual({ enabled: true, lastDown: true, offAttempts: 0 });
  });

  it("the stranded-on TV is cleaned up end-to-end through the tick", async () => {
    // Baseline says up, budget fresh, relay off, TV playing in the ceiling.
    saveLiftwatch({ enabled: true, lastDown: false, offAttempts: 0 });
    vi.mocked(getState).mockImplementation(async (id: string) =>
      ({ state: id === TV_LIFT_ENTITY ? "off" : "on" }) as never,
    );
    await tickLiftwatch();
    expect(executeOnDevice).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: TV_ENTITY }),
      { command: "turn_off" },
    );
    expect(loadLiftwatch()).toEqual({ enabled: true, lastDown: false, offAttempts: 1 });
  });
});

describe("off escalation (the 2026-08-30 flash-but-stays-on Samsung)", () => {
  beforeEach(() => {
    vi.mocked(getState).mockReset();
    vi.mocked(callService).mockReset();
    vi.mocked(executeOnDevice).mockReset();
  });

  /** Relay up, TV playing; the remote entity resolves unless nulled. */
  const states = (remoteExists: boolean) => async (id: string) => {
    if (id === TV_LIFT_ENTITY) return { state: "off" } as never;
    if (id === tvRemoteEntity()) return (remoteExists ? { state: "off" } : null) as never;
    return { state: "on" } as never;
  };

  it("attempt 1 stays the integration's own turn_off", async () => {
    saveLiftwatch({ enabled: true, lastDown: true, offAttempts: 0 });
    vi.mocked(getState).mockImplementation(states(true));
    await tickLiftwatch();
    expect(executeOnDevice).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: TV_ENTITY }),
      { command: "turn_off" },
    );
    expect(callService).not.toHaveBeenCalled();
  });

  it("attempt 2 escalates to a held power key through the remote entity", async () => {
    saveLiftwatch({ enabled: true, lastDown: false, offAttempts: 1 });
    vi.mocked(getState).mockImplementation(states(true));
    await tickLiftwatch();
    expect(callService).toHaveBeenCalledWith("remote", "send_command", {
      entity_id: tvRemoteEntity(), command: "KEY_POWER", hold_secs: 3,
    });
    expect(executeOnDevice).not.toHaveBeenCalled();
    expect(loadLiftwatch().offAttempts).toBe(2);
  });

  it("no remote entity (older HA, or LIFTWATCH_TV_REMOTE emptied) falls back to turn_off", async () => {
    saveLiftwatch({ enabled: true, lastDown: false, offAttempts: 1 });
    vi.mocked(getState).mockImplementation(states(false));
    await tickLiftwatch();
    expect(callService).not.toHaveBeenCalled();
    expect(executeOnDevice).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: TV_ENTITY }),
      { command: "turn_off" },
    );

    vi.mocked(executeOnDevice).mockClear();
    process.env.LIFTWATCH_TV_REMOTE = "";
    saveLiftwatch({ enabled: true, lastDown: false, offAttempts: 1 });
    vi.mocked(getState).mockImplementation(states(true));
    await tickLiftwatch();
    expect(callService).not.toHaveBeenCalled();
    expect(executeOnDevice).toHaveBeenCalled();
  });

  it("a pause flipped while the remote was being probed wins — no held press", async () => {
    saveLiftwatch({ enabled: true, lastDown: false, offAttempts: 1 });
    vi.mocked(getState).mockImplementation(async (id: string) => {
      if (id === TV_LIFT_ENTITY) return { state: "off" } as never;
      if (id === tvRemoteEntity()) {
        // The admin pauses while the probe is in flight.
        saveLiftwatch({ enabled: false, lastDown: null });
        return { state: "off" } as never;
      }
      return { state: "on" } as never;
    });
    await tickLiftwatch();
    expect(callService).not.toHaveBeenCalled();
    expect(executeOnDevice).not.toHaveBeenCalled();
    expect(loadLiftwatch()).toEqual({ enabled: false, lastDown: null });
  });

  it("key and hold are env-tunable, hold clamped and droppable", async () => {
    expect(offKey()).toBe("KEY_POWER");
    process.env.LIFTWATCH_OFF_KEY = "KEY_POWEROFF";
    expect(offKey()).toBe("KEY_POWEROFF");
    expect(offHoldSecs()).toBe(3);
    process.env.LIFTWATCH_OFF_HOLD_SECS = "99";
    expect(offHoldSecs()).toBe(10);
    process.env.LIFTWATCH_OFF_HOLD_SECS = "0";
    expect(offHoldSecs()).toBe(0);
    // hold 0 sends a plain press: no hold_secs in the payload.
    saveLiftwatch({ enabled: true, lastDown: false, offAttempts: 1 });
    vi.mocked(getState).mockImplementation(states(true));
    await tickLiftwatch();
    expect(callService).toHaveBeenCalledWith("remote", "send_command", {
      entity_id: tvRemoteEntity(), command: "KEY_POWEROFF",
    });
  });
});

describe("configuration", () => {
  it("state persists and defaults sanely", () => {
    expect(loadLiftwatch()).toEqual({ enabled: true, lastDown: null });
    saveLiftwatch({ enabled: false, lastDown: true, offAttempts: 2 });
    expect(loadLiftwatch()).toEqual({ enabled: false, lastDown: true, offAttempts: 2 });
    fs.writeFileSync(process.env.LIFTWATCH_PATH!, "not json");
    expect(loadLiftwatch()).toEqual({ enabled: true, lastDown: null });
  });

  it("finds the lift's TV in the real entity map, hidden card and all", () => {
    const dev = tvDevice();
    expect(dev?.entityId).toBe(TV_ENTITY);
    expect(dev?.room).toBe("Master Bedroom");
    // The follower needs power commands to clear the capability gate even
    // though the room shows no card for the TV.
    expect(dev?.capabilities).toContain("on_off");
  });
});
