import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The changeover's contract: replicate the installer's Control4 macro
 * exactly — sacrificial unit to the OPPOSITE mode, 3s, relay flip, 7s,
 * relay flip again, 3s, unit off — with one changeover per floor at a time
 * and failures recorded (never thrown into the void).
 */

vi.mock("../ha", () => ({ callService: vi.fn() }));

import { callService } from "../ha";
import { changeoverStatus, modeFromRelayState, relayEntityId, startChangeover } from "../changeover";

const calls = vi.mocked(callService);

beforeEach(() => {
  vi.useFakeTimers();
  calls.mockReset();
  calls.mockResolvedValue(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changeover-test-"));
  process.env.AUDIT_LOG_PATH = path.join(dir, "audit.log");
});

afterEach(async () => {
  // Drain any in-flight sequence so state never leaks across tests.
  await vi.advanceTimersByTimeAsync(20_000);
  vi.useRealTimers();
});

describe("sequence", () => {
  it("to cooling: unit briefly to HEAT, relay off twice, unit off — in order", async () => {
    expect(startChangeover(5, "cool", "test").ok).toBe(true);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(calls.mock.calls).toEqual([
      ["climate", "set_hvac_mode", { entity_id: "climate.l1_109", hvac_mode: "heat" }],
      ["light", "turn_off", { entity_id: "light.knx_switch_ac_heat_5th" }],
      ["light", "turn_off", { entity_id: "light.knx_switch_ac_heat_5th" }],
      ["climate", "turn_off", { entity_id: "climate.l1_109" }],
    ]);
    expect(changeoverStatus(5)).toEqual({ pending: null, lastError: null });
  });

  it("to heating on floor 6: unit briefly to COOL, relay on twice", async () => {
    expect(startChangeover(6, "heat", "test").ok).toBe(true);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(calls.mock.calls).toEqual([
      ["climate", "set_hvac_mode", { entity_id: "climate.l1_110", hvac_mode: "cool" }],
      ["light", "turn_on", { entity_id: "light.knx_switch_ac_heat_6th" }],
      ["light", "turn_on", { entity_id: "light.knx_switch_ac_heat_6th" }],
      ["climate", "turn_off", { entity_id: "climate.l1_110" }],
    ]);
  });

  it("respects the C4 delays: the second relay flip waits the full 3+7s", async () => {
    startChangeover(5, "heat", "test");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(calls).toHaveBeenCalledTimes(2); // mode + first flip only
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls).toHaveBeenCalledTimes(4);
  });
});

describe("concurrency and failure", () => {
  it("one changeover per floor at a time; other floor unaffected", async () => {
    expect(startChangeover(5, "heat", "test").ok).toBe(true);
    expect(changeoverStatus(5).pending).toBe("heat");
    expect(startChangeover(5, "cool", "test").ok).toBe(false);
    expect(startChangeover(6, "cool", "test").ok).toBe(true);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(startChangeover(5, "cool", "test").ok).toBe(true); // done → allowed again
  });

  it("a failed HA call records lastError and clears pending", async () => {
    calls.mockRejectedValueOnce(new Error("HA down"));
    startChangeover(5, "heat", "test");
    await vi.advanceTimersByTimeAsync(13_000);
    expect(changeoverStatus(5)).toEqual({ pending: null, lastError: "HA down" });
    // ...and the next successful run clears the error.
    startChangeover(5, "heat", "test");
    await vi.advanceTimersByTimeAsync(13_000);
    expect(changeoverStatus(5).lastError).toBeNull();
  });
});

describe("relay state read-back", () => {
  it("relay on = heating, off = cooling, anything else unknown", () => {
    expect(modeFromRelayState("on")).toBe("heat");
    expect(modeFromRelayState("off")).toBe("cool");
    expect(modeFromRelayState("unavailable")).toBeNull();
    expect(modeFromRelayState(undefined)).toBeNull();
  });

  it("floor → relay mapping matches the entity map", () => {
    expect(relayEntityId(5)).toBe("light.knx_switch_ac_heat_5th");
    expect(relayEntityId(6)).toBe("light.knx_switch_ac_heat_6th");
  });
});
