import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { callService, getStates } from "../ha";
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
    expect(calls).toHaveBeenCalledTimes(14);
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

  it("Morning pressed: every Frame gets turn_on — packet plus cloud wake where there is one", async () => {
    const morning = getDevice("whole_house__all_house_morning")!;
    await followArtFrames(morning, { command: "turn_on" }, "daniel");
    // 5 Frames: 4 with a wake entity (2 sends) + Den TV (1) = 9 sends
    expect(calls).toHaveBeenCalledTimes(9);
    expect(calls.mock.calls.every((c) => c[1] === "turn_on")).toBe(true);
    expect(audits.mock.calls[0][0]).toMatchObject({ command: "frames_turn_on", ok: true });
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

  it("Lights 5: the Den TV alone, off and back on", async () => {
    await followArtFrames(getDevice("whole_house__all_house_night")!, { command: "turn_on" }, "ha:1.1.18", { floor: 5, spare: false });
    await followArtFrames(getDevice("whole_house__all_house_morning")!, { command: "turn_on" }, "ha:1.1.18", { floor: 5, spare: false });
    expect(calls.mock.calls.map((c) => [c[1], c[2].entity_id])).toEqual([
      ["turn_off", "media_player.den_den_tv"],
      ["turn_on", "media_player.den_den_tv"],
    ]);
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
