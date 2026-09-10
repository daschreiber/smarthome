import { describe, expect, it } from "vitest";
import { MORNING_SCENE_SWITCH, NIGHT_SCENE_SWITCH, artFrameFollow, artFrames } from "../artframes";
import type { Device } from "../registry";

/**
 * The contract: the picture Frames follow a PRESS of Night (off) or Morning
 * (on) — nothing else moves them, and only the rows the map flags are
 * Frames.
 */

const night: Device = {
  id: "whole_house__all_house_night",
  entityId: NIGHT_SCENE_SWITCH,
  kind: "light",
  label: "All House Night",
  room: "Whole House",
  floor: null,
  group: "Scenes",
  category: "scene_switch",
  visible: true,
  capabilities: ["on_off"],
};
const morning: Device = { ...night, id: "whole_house__all_house_morning", entityId: MORNING_SCENE_SWITCH, label: "All House Morning" };
const exit: Device = { ...night, id: "whole_house__all_house_exit", entityId: "light.knx_switch_all_house_exit", label: "All House Exit" };
const plainLight: Device = { ...night, id: "den__desk", entityId: NIGHT_SCENE_SWITCH, category: "light_switch", group: "Lighting" };

describe("artFrameFollow", () => {
  it("Night pressed → Frames off; Morning pressed → Frames on", () => {
    expect(artFrameFollow(night, { command: "turn_on" })).toEqual({ command: "turn_off" });
    expect(artFrameFollow(morning, { command: "turn_on" })).toEqual({ command: "turn_on" });
  });

  it("only a press counts — a scene switch's turn_off means nothing on KNX either", () => {
    expect(artFrameFollow(night, { command: "turn_off" })).toBeNull();
    expect(artFrameFollow(morning, { command: "turn_off" })).toBeNull();
  });

  it("other scene switches and non-scene devices leave the Frames alone", () => {
    expect(artFrameFollow(exit, { command: "turn_on" })).toBeNull();
    expect(artFrameFollow(plainLight, { command: "turn_on" })).toBeNull();
  });
});

describe("artFrames", () => {
  it("is exactly the five picture Frames the map flags", () => {
    const ids = artFrames().map((d) => d.id).sort();
    expect(ids).toEqual([
      "den__den_tv",
      "dining__dining_left",
      "dining__dining_middle",
      "dining__dining_right",
      "lounge__lounge_tv",
    ]);
    for (const d of artFrames()) {
      expect(d.kind).toBe("media_player");
      expect(d.retryPower).toBe(true);
    }
  });
});
