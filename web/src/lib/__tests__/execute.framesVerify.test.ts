import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Sent" is not "obeyed" (2026-09-19): Exit floor answered 202, the sweep
 * logged `failed: []`, and the Den TV stayed on, because SmartThings had
 * marked it unavailable and HA answers 200 to a call against such an entity.
 * The sweep is read back and chased.
 */

vi.mock("../ha", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ha")>();
  return { ...actual, callService: vi.fn(async () => {}), getStates: vi.fn(async () => []) };
});
vi.mock("../audit", () => ({ audit: vi.fn() }));

import { callService, getStates, type HaState } from "../ha";
import { audit } from "../audit";
import { verifyFrameSweep } from "../execute";
import { FRAME_POLL_MS, FRAME_VERIFY_MS, claimFrames, resetPressMemory } from "../artframes";
import { getDevice } from "../registry";

const calls = vi.mocked(callService);
const states = vi.mocked(getStates);
const audits = vi.mocked(audit);
const den = () => getDevice("den__den_tv")!;
const read = (state: string) => [{ entity_id: den().entityId, state, attributes: {} } as unknown as HaState];

describe("verifyFrameSweep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    calls.mockClear();
    states.mockReset();
    audits.mockClear();
    resetPressMemory();
  });
  afterEach(() => vi.useRealTimers());

  it("a set that obeyed is left alone and nothing is logged", async () => {
    states.mockResolvedValue(read("off"));
    const run = verifyFrameSweep([den()], { command: "turn_off" }, "ha:1.1.43", claimFrames([den().id]), { floor: 5 });
    await vi.advanceTimersByTimeAsync(FRAME_POLL_MS);
    await run;
    expect(calls).not.toHaveBeenCalled();
    expect(audits).not.toHaveBeenCalled();
  });

  it("unavailable is waited out, and the set is re-commanded when it comes back still on", async () => {
    states
      .mockResolvedValueOnce(read("unavailable"))
      .mockResolvedValueOnce(read("unavailable"))
      .mockResolvedValueOnce(read("unavailable"))
      .mockResolvedValueOnce(read("on"))
      .mockResolvedValue(read("off"));
    const run = verifyFrameSweep([den()], { command: "turn_off" }, "ha:1.1.43", claimFrames([den().id]), { floor: 5 });
    await vi.advanceTimersByTimeAsync(FRAME_POLL_MS * 5);
    await run;
    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls.mock.calls[0].slice(0, 3)).toEqual(["media_player", "turn_off", { entity_id: den().entityId }]);
    expect(audits.mock.calls[0][0]).toMatchObject({
      command: "frames_turn_off_verify", ok: true,
      args: { floor: 5, reasserted: { den__den_tv: 1 }, unverified: {} },
    });
  });

  it("a set that never comes back is said so — not `failed: []`", async () => {
    states.mockResolvedValue(read("unavailable"));
    const run = verifyFrameSweep([den()], { command: "turn_off" }, "ha:1.1.43", claimFrames([den().id]), { floor: 5 });
    await vi.advanceTimersByTimeAsync(FRAME_VERIFY_MS + FRAME_POLL_MS);
    await run;
    expect(calls).not.toHaveBeenCalled();
    expect(audits.mock.calls[0][0]).toMatchObject({
      command: "frames_turn_off_verify", ok: false,
      args: { unverified: { den__den_tv: "unavailable" } },
    });
  });

  it("a newer press over the same set takes the verdict; the older chase lets go quietly", async () => {
    states.mockResolvedValue(read("on"));
    const run = verifyFrameSweep([den()], { command: "turn_off" }, "ha:1.1.43", claimFrames([den().id]));
    claimFrames([den().id]); // Lights 5 back on, a moment later
    await vi.advanceTimersByTimeAsync(FRAME_POLL_MS);
    await run;
    expect(calls).not.toHaveBeenCalled();
    expect(audits).not.toHaveBeenCalled();
  });

  describe("the local link reads a lit set 'off' (Dining Left and Middle, 2026-09-25)", () => {
    const left = () => getDevice("dining__dining_left")!;
    const readLeft = (own: string, cloud: string) =>
      [
        { entity_id: left().entityId, state: own, attributes: {} },
        { entity_id: left().wakeEntityId!, state: cloud, attributes: {} },
      ] as unknown as HaState[];

    it("'off' is not believed while SmartThings says on: the off goes through the cloud, not the power key", async () => {
      states
        .mockResolvedValueOnce(readLeft("off", "on"))
        .mockResolvedValueOnce(readLeft("off", "on"))
        .mockResolvedValueOnce(readLeft("off", "on"))
        .mockResolvedValue(readLeft("off", "off"));
      const run = verifyFrameSweep([left()], { command: "turn_off" }, "ha:1.1.18", claimFrames([left().id]), { floor: 6 });
      await vi.advanceTimersByTimeAsync(FRAME_POLL_MS * 5);
      await run;
      expect(calls).toHaveBeenCalledTimes(1);
      expect(calls.mock.calls[0].slice(0, 3)).toEqual(["media_player", "turn_off", { entity_id: left().wakeEntityId }]);
      expect(audits.mock.calls[0][0]).toMatchObject({
        command: "frames_turn_off_verify", ok: true,
        args: { reasserted: { dining__dining_left: 1 }, unverified: {} },
      });
    });

    it("a SmartThings entity that is unavailable proves nothing: 'off' stands", async () => {
      states.mockResolvedValue(readLeft("off", "unavailable"));
      const run = verifyFrameSweep([left()], { command: "turn_off" }, "ha:1.1.18", claimFrames([left().id]));
      await vi.advanceTimersByTimeAsync(FRAME_POLL_MS);
      await run;
      expect(calls).not.toHaveBeenCalled();
      expect(audits).not.toHaveBeenCalled();
    });

    it("a set that reads on locally is chased with the held power key, as before", async () => {
      states
        .mockResolvedValueOnce(readLeft("on", "on"))
        .mockResolvedValueOnce(readLeft("on", "on"))
        .mockResolvedValueOnce(readLeft("on", "on"))
        .mockResolvedValue(readLeft("off", "off"));
      const run = verifyFrameSweep([left()], { command: "turn_off" }, "ha:1.1.18", claimFrames([left().id]));
      await vi.advanceTimersByTimeAsync(FRAME_POLL_MS * 5);
      await run;
      expect(calls.mock.calls.map((c) => c[2].entity_id)).toEqual([left().entityId]);
    });

    it("never settled: the verdict says the cloud still had it on", async () => {
      states.mockResolvedValue(readLeft("off", "on"));
      const run = verifyFrameSweep([left()], { command: "turn_off" }, "ha:1.1.18", claimFrames([left().id]));
      await vi.advanceTimersByTimeAsync(FRAME_VERIFY_MS + FRAME_POLL_MS);
      await run;
      expect(calls).toHaveBeenCalledTimes(2);
      expect(audits.mock.calls[0][0]).toMatchObject({
        ok: false,
        args: { unverified: { dining__dining_left: "off, SmartThings on" } },
      });
    });

    it("an ON sweep ignores the cloud's reading", async () => {
      states.mockResolvedValue(readLeft("on", "off"));
      const run = verifyFrameSweep([left()], { command: "turn_on" }, "ha:1.1.18", claimFrames([left().id]));
      await vi.advanceTimersByTimeAsync(FRAME_POLL_MS);
      await run;
      expect(calls).not.toHaveBeenCalled();
      expect(audits).not.toHaveBeenCalled();
    });
  });

  it("stops at three sends for a set that positively ignores them", async () => {
    states.mockResolvedValue(read("on"));
    const run = verifyFrameSweep([den()], { command: "turn_off" }, "ha:1.1.43", claimFrames([den().id]));
    await vi.advanceTimersByTimeAsync(FRAME_VERIFY_MS + FRAME_POLL_MS);
    await run;
    expect(calls).toHaveBeenCalledTimes(2); // the sweep's own send was the first of three
    expect(audits.mock.calls[0][0]).toMatchObject({ ok: false, args: { reasserted: { den__den_tv: 2 }, unverified: { den__den_tv: "on" } } });
  });
});
