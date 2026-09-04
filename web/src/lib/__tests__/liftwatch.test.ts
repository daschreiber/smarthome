import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BREAKER_COOLDOWN_MS, BREAKER_EDGES, BREAKER_WINDOW_MS, C4_ROOM_ENTITY, MAX_OFF_ATTEMPTS,
  TV_ENTITY, evaluateTvFollow, liftDownFromState, loadLiftwatch, offAttemptsAllowed, offDevice,
  saveLiftwatch, tickLiftwatch, tvDevice, tvOnFromState, type LiftwatchState,
} from "../liftwatch";
import { TV_LIFT_ENTITY } from "../sleepwatch";
import { getState } from "../ha";
import { executeOnDevice } from "../execute";

vi.mock("../ha", () => ({ getState: vi.fn() }));
vi.mock("../execute", () => ({ executeOnDevice: vi.fn() }));
vi.mock("../audit", () => ({ audit: vi.fn() }));

/**
 * The TV follower's contract after the 2026-08-30 field tests: the ON side
 * is an edge (the TV comes on exactly once per lowering; a remote-control
 * off mid-session is never fought), the OFF side is the edge plus bounded
 * enforcement — and it goes through Control4's Room Off, the mechanism
 * the house's original programming used, because the Samsung fights a
 * network power-off. A circuit breaker takes the follower out of any
 * lift feedback loop. Unknown states hold; the first readable lift state
 * after a restart is a baseline, never an action.
 */

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liftwatch-test-"));
  process.env.LIFTWATCH_PATH = path.join(dir, "liftwatch.json");
  delete process.env.SLEEPWATCH_LIFT_STATE;
  delete process.env.LIFTWATCH_OFF_ENTITY;
  delete process.env.LIFTWATCH_OFF_ATTEMPTS;
});

const NOW = 1_800_000_000_000;
const DOWN: LiftwatchState = { enabled: true, lastDown: true, offAttempts: 0 };
const UP: LiftwatchState = { enabled: true, lastDown: false };
const FRESH: LiftwatchState = { enabled: true, lastDown: null };

describe("edge detection", () => {
  it("up → down commands the TV on; down → up commands it off", () => {
    const on = evaluateTvFollow(true, null, UP, NOW);
    expect(on.action).toBe("tv_on");
    expect(on.next).toMatchObject({ lastDown: true, offAttempts: 0, edges: [NOW] });
    const off = evaluateTvFollow(false, null, DOWN, NOW);
    expect(off.action).toBe("tv_off");
    expect(off.next).toMatchObject({ lastDown: false, offAttempts: 1, edges: [NOW] });
  });

  it("the ON side never re-asserts: TV off by remote with the lift down stays off", () => {
    expect(evaluateTvFollow(true, false, DOWN, NOW).action).toBeNull();
  });

  it("unreadable relay state holds — never an invented edge, even with the TV readable", () => {
    for (const st of [DOWN, UP, FRESH]) {
      const d = evaluateTvFollow(null, true, st, NOW);
      expect(d.action).toBeNull();
      expect(d.next).toEqual(st);
    }
  });

  it("first readable state after a restart is a baseline, not an action", () => {
    const down = evaluateTvFollow(true, true, FRESH, NOW);
    expect(down.action).toBeNull();
    expect(down.next.lastDown).toBe(true);
    // ...and the NEXT movement acts normally.
    expect(evaluateTvFollow(false, true, down.next, NOW + 30_000).action).toBe("tv_off");
    const up = evaluateTvFollow(false, true, FRESH, NOW);
    expect(up.action).toBeNull();
    expect(up.next.lastDown).toBe(false);
  });
});

describe("off enforcement (the 2026-08-30 stranded-on TV)", () => {
  beforeEach(() => { process.env.LIFTWATCH_OFF_ATTEMPTS = String(MAX_OFF_ATTEMPTS); });

  it("by default the off is ONE command per stow — a toggle key is never retried blind", () => {
    delete process.env.LIFTWATCH_OFF_ATTEMPTS;
    expect(offAttemptsAllowed()).toBe(1);
    const edge = evaluateTvFollow(false, true, DOWN, NOW);
    expect(edge.action).toBe("tv_off");
    // Still reads on a tick later: no second command.
    expect(evaluateTvFollow(false, true, edge.next, NOW + 30_000).action).toBeNull();
    // A stranded-on TV after a restart still gets its ONE off (the
    // restart-hole cover survives at a budget of one) — and no second.
    const stranded = evaluateTvFollow(false, true, { ...UP, offAttempts: 0 }, NOW);
    expect(stranded.action).toBe("tv_off");
    expect(evaluateTvFollow(false, true, stranded.next, NOW + 30_000).action).toBeNull();
    // The env re-enables the enforcement, clamped to the ceiling.
    process.env.LIFTWATCH_OFF_ATTEMPTS = "9";
    expect(offAttemptsAllowed()).toBe(MAX_OFF_ATTEMPTS);
    process.env.LIFTWATCH_OFF_ATTEMPTS = "0";
    expect(offAttemptsAllowed()).toBe(1);
  });

  it("a TV still on with the lift up is switched off — no edge required", () => {
    // Baseline re-learned as "up" after a deploy, TV left playing inside
    // the ceiling. The tick after the baseline acts.
    const d = evaluateTvFollow(false, true, { ...UP, offAttempts: 0 }, NOW);
    expect(d.action).toBe("tv_off");
    expect(d.next.offAttempts).toBe(1);
  });

  it("enforcement stops after MAX_OFF_ATTEMPTS, and never fires on TV off/unknown", () => {
    let st: LiftwatchState = { ...DOWN };
    let t = NOW;
    for (let i = 0; i < MAX_OFF_ATTEMPTS; i++) {
      const d = evaluateTvFollow(false, true, st, t);
      expect(d.action).toBe("tv_off");
      st = d.next;
      t += 30_000;
    }
    expect(evaluateTvFollow(false, true, st, t).action).toBeNull();
    expect(evaluateTvFollow(false, false, { ...UP, offAttempts: 0 }, NOW).action).toBeNull();
    expect(evaluateTvFollow(false, null, { ...UP, offAttempts: 0 }, NOW).action).toBeNull();
  });

  it("the next lowering resets the attempt budget", () => {
    const spent: LiftwatchState = { enabled: true, lastDown: false, offAttempts: MAX_OFF_ATTEMPTS };
    const down = evaluateTvFollow(true, null, spent, NOW);
    expect(down.action).toBe("tv_on");
    expect(down.next.offAttempts).toBe(0);
    expect(evaluateTvFollow(false, true, down.next, NOW + 60_000).action).toBe("tv_off");
  });
});

describe("circuit breaker (the 2026-08-30 lift oscillation)", () => {
  /** Alternate the lift `n` times, one edge per tick. */
  const cycle = (st: LiftwatchState, n: number, from: number, stepMs = 30_000) => {
    const actions: string[] = [];
    let t = from;
    for (let i = 0; i < n; i++) {
      const d = evaluateTvFollow(!st.lastDown, true, st, t);
      actions.push(String(d.action));
      st = d.next;
      t += stepMs;
    }
    return { st, actions, t };
  };

  it("a human testing open/close twice is not a fault", () => {
    const { actions, st } = cycle({ ...UP, offAttempts: 0 }, 4, NOW);
    expect(actions).toEqual(["tv_on", "tv_off", "tv_on", "tv_off"]);
    expect(st.breakerUntil).toBeUndefined();
  });

  it("the sixth edge in five minutes trips it: one audit, then silence, tracking continues", () => {
    const r = cycle({ ...UP, offAttempts: 0 }, BREAKER_EDGES, NOW);
    expect(r.actions[BREAKER_EDGES - 1]).toBe("breaker_trip");
    expect(r.st.breakerUntil).toBe(r.t - 30_000 + BREAKER_COOLDOWN_MS);
    // More oscillation while open: no commands, no second trip, but the
    // baseline still follows the relay.
    const more = cycle(r.st, 3, r.t);
    expect(more.actions).toEqual(["null", "null", "null"]);
    expect(more.st.lastDown).toBe(!r.st.lastDown);
    expect(more.st.breakerUntil).toBe(r.st.breakerUntil);
  });

  it("closes by time: after the cooldown a normal edge acts again", () => {
    const r = cycle({ ...UP, offAttempts: 0 }, BREAKER_EDGES, NOW);
    const later = r.st.breakerUntil! + 1_000;
    // Old edges have aged out of the window, so this is an ordinary edge.
    const d = evaluateTvFollow(!r.st.lastDown, true, r.st, later);
    expect(d.action).toBe(r.st.lastDown ? "tv_off" : "tv_on");
    expect(d.next.edges).toEqual([later]);
  });

  it("edges older than the window don't count", () => {
    // Five edges spread over 40 minutes never accumulate to a trip.
    const r = cycle({ ...UP, offAttempts: 0 }, BREAKER_EDGES + 2, NOW, BREAKER_WINDOW_MS + 60_000);
    expect(r.actions).not.toContain("breaker_trip");
    expect(r.st.breakerUntil).toBeUndefined();
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

describe("tick", () => {
  beforeEach(() => {
    vi.mocked(getState).mockReset();
    vi.mocked(executeOnDevice).mockReset();
  });

  const states = (lift: string, tv: string) => async (id: string) =>
    ({ state: id === TV_LIFT_ENTITY ? lift : tv }) as never;

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

  it("lift down → the Samsung's own turn_on (network wake — the path that works)", async () => {
    saveLiftwatch({ enabled: true, lastDown: false });
    vi.mocked(getState).mockImplementation(states("on", "off"));
    await tickLiftwatch();
    expect(executeOnDevice).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: TV_ENTITY }),
      { command: "turn_on" },
    );
    expect(loadLiftwatch()).toMatchObject({ enabled: true, lastDown: true, offAttempts: 0 });
  });

  it("lift up → one Samsung turn_off, the only path proven to reach the TV", async () => {
    saveLiftwatch({ enabled: true, lastDown: true, offAttempts: 0 });
    vi.mocked(getState).mockImplementation(states("off", "on"));
    await tickLiftwatch();
    expect(executeOnDevice).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: TV_ENTITY }),
      { command: "turn_off" },
    );
    expect(loadLiftwatch()).toMatchObject({ enabled: true, lastDown: false, offAttempts: 1 });
    // The TV still reads on next tick: nothing more is sent by default.
    vi.mocked(executeOnDevice).mockClear();
    await tickLiftwatch();
    expect(executeOnDevice).not.toHaveBeenCalled();
  });

  it("with the enforcement re-enabled, a stranded-on TV is cleaned up through the tick", async () => {
    process.env.LIFTWATCH_OFF_ATTEMPTS = "3";
    saveLiftwatch({ enabled: true, lastDown: false, offAttempts: 0 });
    vi.mocked(getState).mockImplementation(states("off", "on"));
    await tickLiftwatch();
    expect(executeOnDevice).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: TV_ENTITY }),
      { command: "turn_off" },
    );
  });

  it("LIFTWATCH_OFF_ENTITY redirects the off (e.g. Control4 Room Off); an unknown entity falls back to the TV", async () => {
    process.env.LIFTWATCH_OFF_ENTITY = C4_ROOM_ENTITY;
    expect(offDevice()?.entityId).toBe(C4_ROOM_ENTITY);
    process.env.LIFTWATCH_OFF_ENTITY = "media_player.does_not_exist";
    expect(offDevice()?.entityId).toBe(TV_ENTITY);
    delete process.env.LIFTWATCH_OFF_ENTITY;
    expect(offDevice()?.entityId).toBe(TV_ENTITY);
  });

  it("an open breaker sends nothing, even on a clean edge", async () => {
    saveLiftwatch({ enabled: true, lastDown: false, breakerUntil: Date.now() + 60_000 });
    vi.mocked(getState).mockImplementation(states("on", "off"));
    await tickLiftwatch();
    expect(executeOnDevice).not.toHaveBeenCalled();
    expect(loadLiftwatch().lastDown).toBe(true);
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

  it("finds the lift's TV and the Control4 room zone in the real entity map", () => {
    const dev = tvDevice();
    expect(dev?.entityId).toBe(TV_ENTITY);
    expect(dev?.room).toBe("Master Bedroom");
    expect(dev?.capabilities).toContain("on_off");
    process.env.LIFTWATCH_OFF_ENTITY = C4_ROOM_ENTITY;
    const room = offDevice();
    expect(room?.entityId).toBe(C4_ROOM_ENTITY);
    expect(room?.room).toBe("Master Bedroom");
    expect(room?.kind).toBe("media_player");
    // Room Off rides the typed command layer: the zone must clear the
    // on_off capability gate.
    expect(room?.capabilities).toContain("on_off");
  });
});
