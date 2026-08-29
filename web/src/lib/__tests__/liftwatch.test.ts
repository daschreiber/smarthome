import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TV_ENTITY, evaluateTvFollow, liftDownFromState, loadLiftwatch, saveLiftwatch, tickLiftwatch,
  tvDevice, type LiftwatchState,
} from "../liftwatch";
import { getState } from "../ha";
import { executeOnDevice } from "../execute";

vi.mock("../ha", () => ({ getState: vi.fn() }));
vi.mock("../execute", () => ({ executeOnDevice: vi.fn() }));
vi.mock("../audit", () => ({ audit: vi.fn() }));

/**
 * The TV follower's contract: the Master Bedroom TV mirrors the ceiling
 * lift's EDGES — down-edge turns it on, up-edge turns it off. Unknown
 * relay state holds; the first readable state after a restart is a
 * baseline, never an action; a human's remote-control choice mid-session
 * is never fought (no level enforcement at all).
 */

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liftwatch-test-"));
  process.env.LIFTWATCH_PATH = path.join(dir, "liftwatch.json");
  delete process.env.SLEEPWATCH_LIFT_STATE;
});

const DOWN: LiftwatchState = { enabled: true, lastDown: true };
const UP: LiftwatchState = { enabled: true, lastDown: false };
const FRESH: LiftwatchState = { enabled: true, lastDown: null };

describe("edge detection", () => {
  it("up → down commands the TV on; down → up commands it off", () => {
    expect(evaluateTvFollow(true, UP)).toEqual({ action: "tv_on", next: { ...UP, lastDown: true } });
    expect(evaluateTvFollow(false, DOWN)).toEqual({ action: "tv_off", next: { ...DOWN, lastDown: false } });
  });

  it("no change = no action, in both positions (levels never re-assert)", () => {
    expect(evaluateTvFollow(true, DOWN).action).toBeNull();
    expect(evaluateTvFollow(false, UP).action).toBeNull();
  });

  it("unreadable relay state holds the last known position — never an invented edge", () => {
    for (const st of [DOWN, UP, FRESH]) {
      const d = evaluateTvFollow(null, st);
      expect(d.action).toBeNull();
      expect(d.next).toEqual(st);
    }
  });

  it("first readable state after a restart is a baseline, not an action", () => {
    const down = evaluateTvFollow(true, FRESH);
    expect(down.action).toBeNull();
    expect(down.next.lastDown).toBe(true);
    // ...and the NEXT movement acts normally.
    expect(evaluateTvFollow(false, down.next).action).toBe("tv_off");
    const up = evaluateTvFollow(false, FRESH);
    expect(up.action).toBeNull();
    expect(up.next.lastDown).toBe(false);
  });
});

describe("relay polarity", () => {
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
});

describe("tick vs. a concurrent pause", () => {
  beforeEach(() => {
    vi.mocked(getState).mockReset();
    vi.mocked(executeOnDevice).mockReset();
  });

  it("a pause flipped while HA was being polled wins — no command, no un-pause", async () => {
    saveLiftwatch({ enabled: true, lastDown: false });
    vi.mocked(getState).mockImplementation(async () => {
      // The admin pauses (resetting the baseline, exactly as the API route
      // does) while the getState request is in flight.
      saveLiftwatch({ enabled: false, lastDown: null });
      return { state: "on" } as never;
    });
    await tickLiftwatch();
    expect(executeOnDevice).not.toHaveBeenCalled();
    expect(loadLiftwatch()).toEqual({ enabled: false, lastDown: null });
  });

  it("an ordinary edge still commands the TV and advances the baseline", async () => {
    saveLiftwatch({ enabled: true, lastDown: false });
    vi.mocked(getState).mockResolvedValue({ state: "on" } as never);
    await tickLiftwatch();
    expect(executeOnDevice).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: TV_ENTITY }),
      { command: "turn_on" },
    );
    expect(loadLiftwatch()).toEqual({ enabled: true, lastDown: true });
  });
});

describe("configuration", () => {
  it("state persists and defaults sanely", () => {
    expect(loadLiftwatch()).toEqual({ enabled: true, lastDown: null });
    saveLiftwatch({ enabled: false, lastDown: true });
    expect(loadLiftwatch()).toEqual({ enabled: false, lastDown: true });
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
