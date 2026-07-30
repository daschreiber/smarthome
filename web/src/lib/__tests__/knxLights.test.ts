import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The contract: a light command is an intent, not a telegram. It re-asserts
 * itself while the light disagrees, escalates a dimmer's turn-on into an
 * explicit level, stands down after three tries, and remembers the ones that
 * never answered so the card can stop claiming they did.
 */

vi.mock("../ha", () => ({ callService: vi.fn(), getStates: vi.fn() }));

import { callService, getStates } from "../ha";
import {
  LIGHT_ATTEMPTS,
  UNVERIFIED_TTL_MS,
  claimLight,
  clearUnverified,
  holdsClaim,
  lightAgrees,
  lightRetriable,
  noteUnverified,
  reassertCall,
  resetUnverified,
  unverifiedFor,
  verifyLightSweep,
} from "../knxLights";
import type { Device } from "../registry";

const calls = vi.mocked(callService);
const states = vi.mocked(getStates);

const dimmer: Device = {
  id: "daniels_study__study_lights",
  entityId: "light.knx_dimmer_daniel_study_lights",
  kind: "light",
  label: "Study Spots",
  room: "Daniel's Study",
  floor: 5,
  group: "Lighting",
  category: "light_dimmer",
  visible: true,
  capabilities: ["on_off", "brightness"],
};

const strip: Device = {
  ...dimmer,
  id: "daniels_study__strip_1",
  entityId: "light.knx_dimmer_daniel_study_strip_1",
  label: "Daniel Study Strip 1",
};

const plainSwitch: Device = {
  ...dimmer,
  id: "daniels_study__desk_light",
  entityId: "light.knx_switch_daniel_study_desk_light",
  label: "Daniel Study Desk light",
  category: "light_switch",
  capabilities: ["on_off"],
};

const shade: Device = {
  id: "daniels_study__blinds",
  entityId: "cover.daniel_study_blinds_knx",
  kind: "cover",
  label: "Blinds",
  room: "Daniel's Study",
  floor: 5,
  group: "Shades",
  category: "shade",
  visible: true,
  capabilities: ["open_close_stop", "position"],
};

/** One HA bulk read: every named entity at `state`, others reported off.
 *  `levels` sets the 0-255 brightness attribute a lit fixture reports. */
const reading = (on: string[], levels: Record<string, number> = {}) =>
  [dimmer, strip, plainSwitch].map((d) => ({
    entity_id: d.entityId,
    state: on.includes(d.entityId) ? "on" : "off",
    attributes: levels[d.entityId] != null ? { brightness: levels[d.entityId] } : {},
    last_updated: "",
    last_changed: "",
  }));

/** The sweep's callers claim every fixture first (the routes do this). */
const claimAll = (ds: Device[]) => new Map(ds.map((d) => [d.id, claimLight(d.id)]));

beforeEach(() => {
  resetUnverified();
  calls.mockReset();
  calls.mockResolvedValue(undefined);
  states.mockReset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knxlights-test-"));
  process.env.AUDIT_LOG_PATH = path.join(dir, "audit.log");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("lightRetriable", () => {
  it("covers the light commands a state read can prove", () => {
    expect(lightRetriable(dimmer, { command: "turn_on" })).toBe(true);
    expect(lightRetriable(dimmer, { command: "turn_off" })).toBe(true);
    expect(lightRetriable(dimmer, { command: "set_brightness", brightnessPct: 40 })).toBe(true);
    expect(lightRetriable(plainSwitch, { command: "turn_on" })).toBe(true);
  });

  it("leaves everything that isn't a light alone", () => {
    expect(lightRetriable(shade, { command: "open" })).toBe(false);
    expect(lightRetriable(shade, { command: "close" })).toBe(false);
  });
});

describe("reassertCall", () => {
  it("attempt 0 is the ordinary call — nothing added", () => {
    expect(reassertCall(dimmer, { command: "turn_on" }, 0)).toEqual({
      domain: "light",
      service: "turn_on",
      data: { entity_id: dimmer.entityId },
    });
  });

  it("escalates a dimmer's retry to an explicit level (the shape the slider sends)", () => {
    expect(reassertCall(dimmer, { command: "turn_on" }, 1)).toEqual({
      domain: "light",
      service: "turn_on",
      data: { entity_id: dimmer.entityId, brightness_pct: 100 },
    });
  });

  it("a plain switch has nothing to escalate to — it just goes again", () => {
    expect(reassertCall(plainSwitch, { command: "turn_on" }, 1)).toEqual({
      domain: "light",
      service: "turn_on",
      data: { entity_id: plainSwitch.entityId },
    });
  });

  it("turn_off and set_brightness repeat verbatim — their telegram already names a value", () => {
    expect(reassertCall(dimmer, { command: "turn_off" }, 2).data).toEqual({
      entity_id: dimmer.entityId,
    });
    expect(reassertCall(dimmer, { command: "set_brightness", brightnessPct: 30 }, 2).data).toEqual({
      entity_id: dimmer.entityId,
      brightness_pct: 30,
    });
  });
});

describe("lightAgrees", () => {
  it("state alone settles on and off", () => {
    expect(lightAgrees({ command: "turn_on" }, "on", null)).toBe(true);
    expect(lightAgrees({ command: "turn_on" }, "off", null)).toBe(false);
    expect(lightAgrees({ command: "turn_off" }, "off", null)).toBe(true);
    expect(lightAgrees({ command: "turn_off" }, "on", 255)).toBe(false);
  });

  it("a dim is only proven by the LEVEL — 'on' is free for an already-lit light", () => {
    const dim = { command: "set_brightness", brightnessPct: 30 } as const;
    expect(lightAgrees(dim, "on", 77)).toBe(true); // 77/255 ≈ 30%
    expect(lightAgrees(dim, "on", 255)).toBe(false); // still at its old level
    expect(lightAgrees(dim, "off", null)).toBe(false);
  });

  it("tolerates the 0-255 round trip, and trusts a light that reports no level", () => {
    const dim = { command: "set_brightness", brightnessPct: 50 } as const;
    expect(lightAgrees(dim, "on", 128)).toBe(true); // 128/255 = 50.2%
    expect(lightAgrees(dim, "on", null)).toBe(true); // nothing to compare against
  });
});

describe("claims", () => {
  it("a newer command takes the light; the older token stops holding it", () => {
    const first = claimLight(dimmer.id);
    expect(holdsClaim(dimmer.id, first)).toBe(true);
    const second = claimLight(dimmer.id);
    expect(holdsClaim(dimmer.id, first)).toBe(false);
    expect(holdsClaim(dimmer.id, second)).toBe(true);
  });

  it("claiming supersedes the previous verdict — the card follows the new command", () => {
    noteUnverified(dimmer.id, "turn_on");
    claimLight(dimmer.id);
    expect(unverifiedFor(dimmer.id)).toBeNull();
  });
});

describe("unverified marks", () => {
  it("remembers, clears, and expires", () => {
    expect(unverifiedFor(dimmer.id)).toBeNull();
    noteUnverified(dimmer.id, "turn_on");
    expect(unverifiedFor(dimmer.id)?.command).toBe("turn_on");
    clearUnverified(dimmer.id);
    expect(unverifiedFor(dimmer.id)).toBeNull();
  });

  it("a mark older than the TTL is history, not news", () => {
    noteUnverified(dimmer.id, "turn_on");
    const later = Date.now() + UNVERIFIED_TTL_MS + 1000;
    expect(unverifiedFor(dimmer.id, undefined, later)).toBeNull();
  });

  it("a light that got there in the end retires its own mark", () => {
    noteUnverified(dimmer.id, "turn_on");
    // Late telegram, or someone at the wall switch — either way it's on now.
    expect(unverifiedFor(dimmer.id, "on")).toBeNull();
    noteUnverified(dimmer.id, "turn_off");
    expect(unverifiedFor(dimmer.id, "on")?.command).toBe("turn_off");
    expect(unverifiedFor(dimmer.id, "off")).toBeNull();
  });
});

describe("verifyLightSweep", () => {
  it("re-asserts only the light that stayed dark, and stops when it lights", async () => {
    vi.useFakeTimers();
    // The strip reports on straight away; the spots hold out past the first
    // re-assert window and only then light.
    let poll = 0;
    states.mockImplementation(async () =>
      reading(poll++ < 6 ? [strip.entityId] : [strip.entityId, dimmer.entityId]),
    );
    const done = verifyLightSweep([dimmer, strip], { command: "turn_on" }, "daniel", "Daniel's Study", claimAll([dimmer, strip]));
    await vi.advanceTimersByTimeAsync(20_000);
    await done;
    expect(calls.mock.calls).toEqual([
      ["light", "turn_on", { entity_id: dimmer.entityId, brightness_pct: 100 }],
    ]);
    expect(unverifiedFor(dimmer.id)).toBeNull();
    expect(unverifiedFor(strip.id)).toBeNull();
  });

  it("stands down after LIGHT_ATTEMPTS and marks the light unverified", async () => {
    vi.useFakeTimers();
    states.mockResolvedValue(reading([])); // nothing ever comes on
    const done = verifyLightSweep([dimmer], { command: "turn_on" }, "daniel", "Daniel's Study", claimAll([dimmer]));
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
    // One send happened before this function was called, so it adds the rest.
    expect(calls).toHaveBeenCalledTimes(LIGHT_ATTEMPTS - 1);
    expect(unverifiedFor(dimmer.id)?.command).toBe("turn_on");
  });

  it("an unavailable light is waited out, never shouted at", async () => {
    vi.useFakeTimers();
    states.mockResolvedValue([
      { entity_id: dimmer.entityId, state: "unavailable", attributes: {}, last_updated: "", last_changed: "" },
    ]);
    const done = verifyLightSweep([dimmer], { command: "turn_on" }, "daniel", null, claimAll([dimmer]));
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
    expect(calls).not.toHaveBeenCalled();
    // Still not proven on, so the card is told the truth about it.
    expect(unverifiedFor(dimmer.id)?.command).toBe("turn_on");
  });

  it("ignores non-light targets entirely", async () => {
    vi.useFakeTimers();
    states.mockResolvedValue(reading([]));
    const done = verifyLightSweep([shade], { command: "turn_on" }, "daniel", null, claimAll([shade]));
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
    expect(calls).not.toHaveBeenCalled();
    expect(states).not.toHaveBeenCalled();
  });

  it("a turn_off that never lands is chased the same way", async () => {
    vi.useFakeTimers();
    states.mockResolvedValue(reading([dimmer.entityId])); // stays on
    const done = verifyLightSweep([dimmer], { command: "turn_off" }, "daniel", null, claimAll([dimmer]));
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
    expect(calls.mock.calls).toEqual([
      ["light", "turn_off", { entity_id: dimmer.entityId }],
      ["light", "turn_off", { entity_id: dimmer.entityId }],
    ]);
    expect(unverifiedFor(dimmer.id)?.command).toBe("turn_off");
  });

  it("stands down the moment a newer command claims the light — never undoes it", async () => {
    vi.useFakeTimers();
    states.mockResolvedValue(reading([])); // the turn_on never lands
    const done = verifyLightSweep([dimmer], { command: "turn_on" }, "daniel", null, claimAll([dimmer]));
    await vi.advanceTimersByTimeAsync(1_000);
    // The owner changes their mind mid-verification: a turn_off claims it.
    claimLight(dimmer.id);
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
    // Not one re-assert: relighting here would undo the newer command.
    expect(calls).not.toHaveBeenCalled();
    // And the verdict belongs to the newer command, not this one.
    expect(unverifiedFor(dimmer.id)).toBeNull();
  });

  it("chases a dim that the fixture ignored, even though it is already lit", async () => {
    vi.useFakeTimers();
    // Lit the whole time, but stuck at full — the level telegram went missing.
    states.mockResolvedValue(reading([dimmer.entityId], { [dimmer.entityId]: 255 }));
    const cmd = { command: "set_brightness", brightnessPct: 30 } as const;
    const done = verifyLightSweep([dimmer], cmd, "daniel", null, claimAll([dimmer]));
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
    expect(calls.mock.calls).toEqual([
      ["light", "turn_on", { entity_id: dimmer.entityId, brightness_pct: 30 }],
      ["light", "turn_on", { entity_id: dimmer.entityId, brightness_pct: 30 }],
    ]);
    expect(unverifiedFor(dimmer.id)?.command).toBe("set_brightness");
  });

  it("a dim that landed is done — no retry, no mark", async () => {
    vi.useFakeTimers();
    states.mockResolvedValue(reading([dimmer.entityId], { [dimmer.entityId]: 77 }));
    const cmd = { command: "set_brightness", brightnessPct: 30 } as const;
    const done = verifyLightSweep([dimmer], cmd, "daniel", null, claimAll([dimmer]));
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
    expect(calls).not.toHaveBeenCalled();
    expect(unverifiedFor(dimmer.id)).toBeNull();
  });

  it("clears a stale mark once the light finally proves itself", async () => {
    vi.useFakeTimers();
    noteUnverified(dimmer.id, "turn_on");
    states.mockResolvedValue(reading([dimmer.entityId]));
    const done = verifyLightSweep([dimmer], { command: "turn_on" }, "daniel", null, claimAll([dimmer]));
    await vi.advanceTimersByTimeAsync(20_000);
    await done;
    expect(unverifiedFor(dimmer.id)).toBeNull();
  });
});
