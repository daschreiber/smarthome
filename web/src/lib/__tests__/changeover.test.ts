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

vi.mock("../ha", () => ({ callService: vi.fn(), getState: vi.fn() }));

import { callService, getState } from "../ha";
import { changeoverStatus, modeFromRelayState, relayEntityId, startChangeover } from "../changeover";

const calls = vi.mocked(callService);
const reads = vi.mocked(getState);

/** A relay state read shaped like lib/ha's HaState. */
const relayState = (state: string) =>
  ({ entity_id: "light.relay", state, attributes: {}, last_updated: "", last_changed: "" });

beforeEach(() => {
  vi.useFakeTimers();
  calls.mockReset();
  calls.mockResolvedValue(undefined);
  reads.mockReset();
  // The relay answers "off" (cooling) unless a test says otherwise.
  reads.mockResolvedValue(relayState("off"));
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
    expect((await startChangeover(5, "cool", "test")).ok).toBe(true);
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
    expect((await startChangeover(6, "heat", "test")).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(calls.mock.calls).toEqual([
      ["climate", "set_hvac_mode", { entity_id: "climate.l1_110", hvac_mode: "cool" }],
      ["light", "turn_on", { entity_id: "light.knx_switch_ac_heat_6th" }],
      ["light", "turn_on", { entity_id: "light.knx_switch_ac_heat_6th" }],
      ["climate", "turn_off", { entity_id: "climate.l1_110" }],
    ]);
  });

  it("respects the C4 delays: the second relay flip waits the full 3+7s", async () => {
    await startChangeover(5, "heat", "test");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(calls).toHaveBeenCalledTimes(2); // mode + first flip only
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls).toHaveBeenCalledTimes(4);
  });
});

describe("concurrency and failure", () => {
  it("one changeover per floor at a time; other floor unaffected", async () => {
    expect((await startChangeover(5, "heat", "test")).ok).toBe(true);
    expect(changeoverStatus(5).pending).toBe("heat");
    expect((await startChangeover(5, "cool", "test")).ok).toBe(false);
    expect((await startChangeover(6, "cool", "test")).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(13_000);
    expect((await startChangeover(5, "cool", "test")).ok).toBe(true); // done → allowed again
  });

  it("a failed HA call records lastError and clears pending", async () => {
    calls.mockRejectedValueOnce(new Error("HA down"));
    await startChangeover(5, "heat", "test");
    await vi.advanceTimersByTimeAsync(13_000);
    expect(changeoverStatus(5)).toEqual({ pending: null, lastError: "HA down" });
    // ...and the next successful run clears the error.
    await startChangeover(5, "heat", "test");
    await vi.advanceTimersByTimeAsync(13_000);
    expect(changeoverStatus(5).lastError).toBeNull();
  });
});

describe("outage guard", () => {
  /**
   * A changeover with a dead relay is not a harmless no-op: HA answers 200
   * for an unavailable entity, so the sequence would still cycle the
   * sacrificial CoolMaster unit (alive on its own bridge) for 13s, flip
   * nothing, and audit success. Refuse before anything is sent.
   */
  it("refuses when the relay is unavailable — and sends nothing", async () => {
    reads.mockResolvedValue(relayState("unavailable"));
    const out = await startChangeover(6, "heat", "test");
    expect(out).toEqual({
      ok: false,
      reason: "unreachable",
      error: expect.stringContaining("not responding"),
    });
    expect(calls).not.toHaveBeenCalled();
    expect(changeoverStatus(6).pending).toBeNull();
  });

  it("refuses when the relay entity is gone (failed config entry deletes it)", async () => {
    reads.mockResolvedValue(null);
    expect((await startChangeover(5, "cool", "test")).ok).toBe(false);
    expect(calls).not.toHaveBeenCalled();
  });

  it("proceeds on a failed read — our own hiccup must not brick the mode", async () => {
    reads.mockRejectedValue(new Error("fetch failed"));
    expect((await startChangeover(5, "heat", "test")).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(calls).toHaveBeenCalledTimes(4);
  });

  it("proceeds on 'unknown' — the transient state after an HA restart", async () => {
    reads.mockResolvedValue(relayState("unknown"));
    expect((await startChangeover(5, "heat", "test")).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(calls).toHaveBeenCalledTimes(4);
  });

  it("claims the floor before reading the relay — two taps can't both start", async () => {
    // The reachability read is an await; without a claim taken first, a
    // second tap slips through the "already in progress" check.
    let answer!: (state: ReturnType<typeof relayState>) => void;
    reads.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const first = startChangeover(5, "heat", "test");
    expect(await startChangeover(5, "cool", "test")).toMatchObject({
      ok: false,
      reason: "busy",
    });
    answer(relayState("off"));
    expect((await first).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(calls).toHaveBeenCalledTimes(4); // one sequence, not two
  });

  it("a refused command releases the floor for the next attempt", async () => {
    reads.mockResolvedValueOnce(relayState("unavailable"));
    expect((await startChangeover(6, "heat", "test")).ok).toBe(false);
    // ...Control4 comes back, and the very next tap works.
    expect((await startChangeover(6, "heat", "test")).ok).toBe(true);
  });

  it("a busy floor reports busy, not an outage", async () => {
    await startChangeover(5, "heat", "test");
    expect(await startChangeover(5, "cool", "test")).toEqual({
      ok: false,
      reason: "busy",
      error: expect.stringContaining("already in progress"),
    });
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
