import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The batch path (scenes, automations, the assistant) has no read-back, so
 * a picture Frame's turn_on sends the local packet and the cloud wake
 * together, and a press of Night/Morning sweeps every flagged Frame.
 */

vi.mock("../ha", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ha")>();
  return { ...actual, callService: vi.fn(async () => {}), getStates: vi.fn(async () => []) };
});
vi.mock("../audit", () => ({ audit: vi.fn() }));

import { callService, getStates, type HaState } from "../ha";
import { audit } from "../audit";
import { executeOnDevice, followArtFrames } from "../execute";
import { resetPressMemory } from "../artframes";
import { getDevice } from "../registry";

const calls = vi.mocked(callService);
const audits = vi.mocked(audit);

describe("executeOnDevice — picture Frames", () => {
  beforeEach(() => {
    calls.mockClear();
    audits.mockClear();
  });

  it("a turn_on sends the local packet AND the cloud wake, with the slow timeout", async () => {
    const right = getDevice("dining__dining_right")!;
    await executeOnDevice(right, { command: "turn_on" });
    expect(calls.mock.calls.map((c) => [c[1], c[2].entity_id, c[3]?.timeoutMs])).toEqual([
      ["turn_on", right.entityId, 12_000],
      ["turn_on", right.wakeEntityId, 12_000],
    ]);
  });

  it("a turn_off is one send — the held power key has never been dropped", async () => {
    const right = getDevice("dining__dining_right")!;
    await executeOnDevice(right, { command: "turn_off" });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls.mock.calls[0][2].entity_id).toBe(right.entityId);
  });

  it("a set without a wake entity (Den TV, SmartThings-only) sends once", async () => {
    const den = getDevice("den__den_tv")!;
    await executeOnDevice(den, { command: "turn_on" });
    expect(calls).toHaveBeenCalledTimes(1);
  });
});

describe("followArtFrames", () => {
  beforeEach(() => {
    calls.mockClear();
    audits.mockClear();
    resetPressMemory();
  });

  it("one press, one sweep: the same press arriving again inside the window is logged and dropped", async () => {
    const night = getDevice("whole_house__all_house_night")!;
    await followArtFrames(night, { command: "turn_on" }, "daniel");
    expect(calls).toHaveBeenCalledTimes(5);
    // HA relaying the service call that tap made, a second later.
    await followArtFrames(night, { command: "turn_on" }, "ha:voice-or-ui");
    expect(calls).toHaveBeenCalledTimes(5);
    expect(audits).toHaveBeenCalledTimes(2);
    expect(audits.mock.calls[1][0]).toMatchObject({
      deviceId: "system:artframes", command: "frames_duplicate", user: "ha:voice-or-ui", ok: true,
      args: { press: "night", after: "whole_house__all_house_night" },
    });
    // Morning right after is a different press and sweeps.
    await followArtFrames(getDevice("whole_house__all_house_morning")!, { command: "turn_on" }, "daniel");
    expect(calls).toHaveBeenCalledTimes(13); // 5 off + 4 on with their wakes; the Den TV stays off
  });

  it("Night pressed: every Frame gets turn_off, one audit line for the sweep", async () => {
    const night = getDevice("whole_house__all_house_night")!;
    await followArtFrames(night, { command: "turn_on" }, "daniel");
    const targets = calls.mock.calls.map((c) => c[2].entity_id).sort();
    expect(targets).toEqual([
      "media_player.den_den_tv",
      "media_player.left_32_qe32ls03cbuxil",
      "media_player.lounge_tv_qe85ls03dauxsq",
      "media_player.middle_32_qe32ls03cbuxil",
      "media_player.right_32_qe32ls03cbuxil",
    ]);
    expect(calls.mock.calls.every((c) => c[1] === "turn_off")).toBe(true);
    expect(audits).toHaveBeenCalledTimes(1);
    expect(audits.mock.calls[0][0]).toMatchObject({ deviceId: "system:artframes", command: "frames_turn_off", ok: true, user: "daniel" });
  });

  it("Morning pressed: every Frame but the off-only Den TV gets turn_on — packet plus cloud wake", async () => {
    const morning = getDevice("whole_house__all_house_morning")!;
    await followArtFrames(morning, { command: "turn_on" }, "daniel");
    // 4 Frames with a wake entity, 2 sends each; the Den TV stays off (2026-09-22)
    expect(calls).toHaveBeenCalledTimes(8);
    expect(calls.mock.calls.every((c) => c[1] === "turn_on")).toBe(true);
    expect(calls.mock.calls.some((c) => c[2].entity_id === "media_player.den_den_tv")).toBe(false);
    expect(audits.mock.calls[0][0]).toMatchObject({
      command: "frames_turn_on", ok: true,
      args: { targets: ["dining__dining_left", "dining__dining_middle", "dining__dining_right", "lounge__lounge_tv"] },
    });
  });

  it("Night spares a Den or Lounge set that is showing television, and says so", async () => {
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    vi.mocked(getStates).mockResolvedValueOnce([
      { entity_id: "sensor.living_room_lounge_tv_tv_channel_name", state: "HDMI 1", attributes: {}, last_updated: anHourAgo, last_changed: anHourAgo },
      { entity_id: "sensor.den_den_tv_tv_channel_name", state: "art", attributes: {}, last_updated: anHourAgo, last_changed: anHourAgo },
    ]);
    const night = getDevice("whole_house__all_house_night")!;
    await followArtFrames(night, { command: "turn_on" }, "daniel");
    const targets = calls.mock.calls.map((c) => c[2].entity_id);
    expect(targets).not.toContain("media_player.lounge_tv_qe85ls03dauxsq");
    expect(targets).toContain("media_player.den_den_tv");
    expect(targets).toHaveLength(4);
    expect(audits.mock.calls[0][0].args).toMatchObject({ spared: ["lounge__lounge_tv"] });
  });

  it("Night darkens the Lounge TV when its sensor stuck on a video app days ago (2026-09-18)", async () => {
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    vi.mocked(getStates).mockResolvedValueOnce([
      { entity_id: "sensor.living_room_lounge_tv_tv_channel_name", state: "YouTube", attributes: {}, last_updated: fourDaysAgo, last_changed: fourDaysAgo },
    ]);
    const night = getDevice("whole_house__all_house_night")!;
    await followArtFrames(night, { command: "turn_on" }, "ha:1.1.24");
    const targets = calls.mock.calls.map((c) => c[2].entity_id);
    expect(targets).toContain("media_player.lounge_tv_qe85ls03dauxsq");
    expect(targets).toHaveLength(5);
    expect(audits.mock.calls[0][0].args).not.toHaveProperty("spared");
  });

  it("a failed state read spares nothing — only positive evidence", async () => {
    vi.mocked(getStates).mockRejectedValueOnce(new Error("HA down"));
    const night = getDevice("whole_house__all_house_night")!;
    await followArtFrames(night, { command: "turn_on" }, "daniel");
    expect(calls).toHaveBeenCalledTimes(5);
    expect(audits.mock.calls[0][0].args).not.toHaveProperty("spared");
  });

  it("Lights 6 off at the door: the sixth floor's four Frames, the Den TV untouched", async () => {
    const night = getDevice("whole_house__all_house_night")!;
    await followArtFrames(night, { command: "turn_on" }, "ha:1.1.18", { floor: 6, spare: false });
    const targets = calls.mock.calls.map((c) => c[2].entity_id).sort();
    expect(targets).toEqual([
      "media_player.left_32_qe32ls03cbuxil",
      "media_player.lounge_tv_qe85ls03dauxsq",
      "media_player.middle_32_qe32ls03cbuxil",
      "media_player.right_32_qe32ls03cbuxil",
    ]);
    expect(audits.mock.calls[0][0]).toMatchObject({ command: "frames_turn_off", args: { floor: 6 } });
  });

  describe("an off the local link cannot deliver goes through SmartThings (2026-09-25)", () => {
    const left = () => getDevice("dining__dining_left")!;
    const middle = () => getDevice("dining__dining_middle")!;
    /** HA's local link cannot reach the sets named; everything else answers. */
    const localDown = (...entityIds: string[]) =>
      calls.mockImplementation(async (_domain, _service, data) => {
        if (entityIds.includes(data.entity_id as string)) throw new Error("HA 500: failed to connect");
      });
    afterEach(() => calls.mockImplementation(async () => {}));

    it("Lights 6 off: Left and Middle unreachable locally get the cloud off; the sweep is not a failure", async () => {
      localDown(left().entityId, middle().entityId);
      await followArtFrames(getDevice("whole_house__all_house_night")!, { command: "turn_on" }, "ha:1.1.18", { floor: 6, spare: false });
      const cloud = calls.mock.calls.filter((c) => c[2].entity_id === left().wakeEntityId || c[2].entity_id === middle().wakeEntityId);
      expect(cloud.map((c) => [c[1], c[2].entity_id, c[3]?.timeoutMs]).sort()).toEqual([
        ["turn_off", left().wakeEntityId, 12_000],
        ["turn_off", middle().wakeEntityId, 12_000],
      ]);
      // The two that answered locally get nothing more.
      expect(calls).toHaveBeenCalledTimes(6);
      expect(audits.mock.calls[0][0]).toMatchObject({
        command: "frames_turn_off", ok: true,
        args: {
          failed: [],
          viaCloud: {
            dining__dining_left: expect.stringContaining("failed to connect"),
            dining__dining_middle: expect.stringContaining("failed to connect"),
          },
        },
      });
    });

    it("both roads down: the set is still reported failed", async () => {
      localDown(left().entityId, left().wakeEntityId!);
      await followArtFrames(getDevice("whole_house__all_house_night")!, { command: "turn_on" }, "ha:1.1.18", { floor: 6, spare: false });
      expect(audits.mock.calls[0][0]).toMatchObject({
        ok: false,
        args: { failed: [{ target: "dining__dining_left" }] },
      });
      expect(audits.mock.calls[0][0].args).not.toHaveProperty("viaCloud");
    });

    /** Every command to one set, in the order it reached HA. */
    const sentTo = (entityIds: string[]) =>
      calls.mock.calls.filter((c) => entityIds.includes(c[2].entity_id as string)).map((c) => [c[1], c[2].entity_id]);

    it("Lights 6 back on while the off is still failing: the on waits its turn, and no cloud off follows it (Codex, #147)", async () => {
      let failLocal: (err: Error) => void = () => {};
      calls.mockImplementation(async (_domain, service, data) => {
        if (service === "turn_off" && data.entity_id === left().entityId) {
          await new Promise<void>((_, reject) => { failLocal = reject; });
        }
      });
      const night = followArtFrames(getDevice("whole_house__all_house_night")!, { command: "turn_on" }, "ha:1.1.24", { floor: 6, spare: false });
      await vi.waitFor(() => expect(sentTo([left().entityId])).toHaveLength(1));
      const morning = followArtFrames(getDevice("whole_house__all_house_morning")!, { command: "turn_on" }, "ha:1.1.24", { floor: 6, spare: false });
      await Promise.resolve();
      // Nothing has overtaken the held power key.
      expect(sentTo([left().entityId, left().wakeEntityId!])).toEqual([["turn_off", left().entityId]]);
      failLocal(new Error("timeout"));
      await Promise.all([night, morning]);
      expect(sentTo([left().entityId, left().wakeEntityId!])).toEqual([
        ["turn_off", left().entityId],
        ["turn_on", left().entityId],
        ["turn_on", left().wakeEntityId],
      ]);
      expect(audits.mock.calls.find((c) => c[0].command === "frames_turn_off")![0]).toMatchObject({
        ok: false,
        args: { failed: [{ target: "dining__dining_left" }] },
      });
    });

    it("an on pressed while the cloud off is in flight goes out after it lands (Codex, #148)", async () => {
      let landCloudOff: () => void = () => {};
      calls.mockImplementation(async (_domain, service, data) => {
        if (service === "turn_off" && data.entity_id === left().entityId) throw new Error("timeout");
        if (service === "turn_off" && data.entity_id === left().wakeEntityId) {
          await new Promise<void>((resolve) => { landCloudOff = resolve; });
        }
      });
      const night = followArtFrames(getDevice("whole_house__all_house_night")!, { command: "turn_on" }, "ha:1.1.24", { floor: 6, spare: false });
      await vi.waitFor(() => expect(sentTo([left().wakeEntityId!])).toHaveLength(1));
      const morning = followArtFrames(getDevice("whole_house__all_house_morning")!, { command: "turn_on" }, "ha:1.1.24", { floor: 6, spare: false });
      await Promise.resolve();
      expect(sentTo([left().entityId, left().wakeEntityId!])).toEqual([
        ["turn_off", left().entityId],
        ["turn_off", left().wakeEntityId],
      ]);
      landCloudOff();
      await Promise.all([night, morning]);
      expect(sentTo([left().entityId, left().wakeEntityId!])).toEqual([
        ["turn_off", left().entityId],
        ["turn_off", left().wakeEntityId],
        ["turn_on", left().entityId],
        ["turn_on", left().wakeEntityId],
      ]);
    });

    it("Morning pressed while Night is still reading the sensors: the older Night stands down (Codex, #148)", async () => {
      let answerRead: (s: HaState[]) => void = () => {};
      vi.mocked(getStates).mockImplementationOnce(() => new Promise<HaState[]>((resolve) => { answerRead = resolve; }));
      const night = followArtFrames(getDevice("whole_house__all_house_night")!, { command: "turn_on" }, "daniel");
      await followArtFrames(getDevice("whole_house__all_house_morning")!, { command: "turn_on" }, "ha:voice-or-ui");
      answerRead([]);
      await night;
      // Morning's ons went out; Night, the older press, sent no off to the
      // sets Morning claimed. (The Den TV is off-only: Morning never claims
      // it, so Night still darkens it.)
      const den = getDevice("den__den_tv")!.entityId;
      expect(calls.mock.calls.filter((c) => c[1] === "turn_off").map((c) => c[2].entity_id)).toEqual([den]);
      expect(calls.mock.calls.filter((c) => c[1] === "turn_on").length).toBeGreaterThan(0);
    });

    it("a cloud off that lands with no newer press sends nothing more", async () => {
      localDown(left().entityId);
      await followArtFrames(getDevice("whole_house__all_house_night")!, { command: "turn_on" }, "ha:1.1.18", { floor: 6, spare: false });
      expect(calls.mock.calls.some((c) => c[1] === "turn_on")).toBe(false);
    });

    it("an off that went through locally sends nothing to the cloud", async () => {
      await followArtFrames(getDevice("whole_house__all_house_night")!, { command: "turn_on" }, "ha:1.1.18", { floor: 6, spare: false });
      expect(calls.mock.calls.some((c) => String(c[2].entity_id).startsWith("media_player.living_room_"))).toBe(false);
    });

    it("a failed ON is not answered with a cloud off", async () => {
      localDown(left().entityId);
      await followArtFrames(getDevice("whole_house__all_house_morning")!, { command: "turn_on" }, "ha:1.1.18", { floor: 6, spare: false });
      expect(calls.mock.calls.some((c) => c[1] === "turn_off")).toBe(false);
    });
  });

  it("Lights 5: the Den TV alone goes off; Lights 5 back on leaves it off (off-only) and logs nothing", async () => {
    await followArtFrames(getDevice("whole_house__all_house_night")!, { command: "turn_on" }, "ha:1.1.18", { floor: 5, spare: false });
    await followArtFrames(getDevice("whole_house__all_house_morning")!, { command: "turn_on" }, "ha:1.1.18", { floor: 5, spare: false });
    expect(calls.mock.calls.map((c) => [c[1], c[2].entity_id])).toEqual([
      ["turn_off", "media_player.den_den_tv"],
    ]);
    expect(audits).toHaveBeenCalledTimes(1);
  });

  it("a door press does not spare: a Lounge sensor stuck on a video app still goes dark, unread", async () => {
    vi.mocked(getStates).mockClear();
    await followArtFrames(getDevice("whole_house__all_house_night")!, { command: "turn_on" }, "ha:1.1.18", { spare: false });
    expect(getStates).not.toHaveBeenCalled();
    expect(calls).toHaveBeenCalledTimes(5);
    expect(audits.mock.calls[0][0].args).not.toHaveProperty("spared");
  });

  it("Lights 6 then Lights 5 two seconds apart both sweep", async () => {
    const night = getDevice("whole_house__all_house_night")!;
    await followArtFrames(night, { command: "turn_on" }, "ha:1.1.18", { floor: 6, spare: false });
    await followArtFrames(night, { command: "turn_on" }, "ha:1.1.18", { floor: 5, spare: false });
    expect(calls).toHaveBeenCalledTimes(5);
    expect(audits.mock.calls.map((c) => c[0].command)).toEqual(["frames_turn_off", "frames_turn_off"]);
  });

  it("Exit pressed in the app: all five off, a watched set included", async () => {
    vi.mocked(getStates).mockClear();
    await followArtFrames(getDevice("whole_house__all_house_exit")!, { command: "turn_on" }, "daniel");
    expect(calls).toHaveBeenCalledTimes(5);
    expect(calls.mock.calls.every((c) => c[1] === "turn_off")).toBe(true);
    expect(getStates).not.toHaveBeenCalled();
    expect(audits.mock.calls[0][0]).toMatchObject({ command: "frames_turn_off", args: { after: "whole_house__all_house_exit" } });
  });

  it("any other press is not the Frames' business", async () => {
    const welcome = getDevice("whole_house__welcome")!;
    await followArtFrames(welcome, { command: "turn_on" }, "daniel");
    await followArtFrames(getDevice("whole_house__all_house_night")!, { command: "turn_off" }, "daniel");
    expect(calls).not.toHaveBeenCalled();
    expect(audits).not.toHaveBeenCalled();
  });
});
