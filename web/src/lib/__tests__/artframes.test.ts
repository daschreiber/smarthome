import { describe, expect, it } from "vitest";
import {
  MORNING_SCENE_SWITCH,
  NIGHT_SCENE_SWITCH,
  WATCHED_EVIDENCE_MAX_AGE_MS,
  artFrameFollow,
  artFrames,
  beingWatched,
  spareWatched,
  type SensorRead,
} from "../artframes";
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

  it("Exit pressed → Frames off, like Night", () => {
    expect(artFrameFollow(exit, { command: "turn_on" })).toEqual({ command: "turn_off" });
    expect(artFrameFollow(exit, { command: "turn_off" })).toBeNull();
  });

  it("other scene switches and non-scene devices leave the Frames alone", () => {
    const welcome: Device = { ...night, id: "whole_house__welcome", entityId: "light.knx_switch_welcome", label: "Welcome" };
    expect(artFrameFollow(welcome, { command: "turn_on" })).toBeNull();
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

const lounge: Device = {
  id: "lounge__lounge_tv",
  entityId: "media_player.lounge_tv_qe85ls03dauxsq",
  kind: "media_player",
  label: "Lounge TV",
  room: "Lounge",
  floor: 6,
  group: "Media",
  category: "media",
  visible: true,
  capabilities: ["on_off"],
  artFrame: true,
  retryPower: true,
  artModeEntityId: "sensor.living_room_lounge_tv_tv_channel_name",
};
const diningLeft: Device = {
  ...lounge,
  id: "dining__dining_left",
  entityId: "media_player.left_32_qe32ls03cbuxil",
  label: "Dining Left",
  room: "Dining",
  artModeEntityId: undefined,
};

// "Now" for the freshness tests, and readings that changed some time before.
const NOW = Date.parse("2026-09-18T20:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 60 * 60 * 1000;
const fresh = (state: string) => ({ state, lastChanged: ago(HOUR) });

describe("beingWatched", () => {
  it("television is anything the sensor reports that is not art — while the reading is fresh", () => {
    expect(beingWatched(lounge, fresh("art"), NOW)).toBe(false);
    expect(beingWatched(lounge, fresh("HDMI 1"), NOW)).toBe(true);
    expect(beingWatched(lounge, fresh("BBC One"), NOW)).toBe(true);
  });

  it("only positive evidence spares a set — no sensor, no reading, unavailable all read as art", () => {
    expect(beingWatched(lounge, undefined, NOW)).toBe(false);
    expect(beingWatched(lounge, fresh(""), NOW)).toBe(false);
    expect(beingWatched(lounge, fresh("unavailable"), NOW)).toBe(false);
    expect(beingWatched(lounge, fresh("unknown"), NOW)).toBe(false);
    expect(beingWatched(diningLeft, fresh("HDMI 1"), NOW)).toBe(false); // no art_mode_entity on the row
  });

  it("a stale reading is not evidence: the sensor that stuck on a video app for four days", () => {
    expect(WATCHED_EVIDENCE_MAX_AGE_MS).toBe(4 * HOUR);
    expect(beingWatched(lounge, { state: "YouTube", lastChanged: ago(4 * 24 * HOUR) }, NOW)).toBe(false);
    expect(beingWatched(lounge, { state: "YouTube", lastChanged: ago(4 * HOUR + 1) }, NOW)).toBe(false);
    expect(beingWatched(lounge, { state: "YouTube", lastChanged: ago(4 * HOUR) }, NOW)).toBe(true);
    expect(beingWatched(lounge, { state: "YouTube", lastChanged: ago(5 * 60 * 1000) }, NOW)).toBe(true);
  });

  it("a reading with no usable timestamp is not evidence either", () => {
    expect(beingWatched(lounge, { state: "HDMI 1" }, NOW)).toBe(false);
    expect(beingWatched(lounge, { state: "HDMI 1", lastChanged: "" }, NOW)).toBe(false);
    expect(beingWatched(lounge, { state: "HDMI 1", lastChanged: "not a date" }, NOW)).toBe(false);
  });
});

describe("spareWatched", () => {
  const reads: Record<string, SensorRead> = { "sensor.living_room_lounge_tv_tv_channel_name": fresh("HDMI 1") };
  const readOf = (id: string) => reads[id];

  it("Night spares the set that is showing television and darkens the rest", () => {
    const { targets, spared } = spareWatched([lounge, diningLeft], { command: "turn_off" }, readOf, NOW);
    expect(spared.map((d) => d.id)).toEqual(["lounge__lounge_tv"]);
    expect(targets.map((d) => d.id)).toEqual(["dining__dining_left"]);
  });

  it("Morning takes them all — turning on a set that is on changes nothing", () => {
    const { targets, spared } = spareWatched([lounge, diningLeft], { command: "turn_on" }, readOf, NOW);
    expect(spared).toEqual([]);
    expect(targets).toHaveLength(2);
  });

  it("a set back in art is darkened like the others", () => {
    const { spared } = spareWatched([lounge], { command: "turn_off" }, () => fresh("art"), NOW);
    expect(spared).toEqual([]);
  });

  it("a set whose sensor stuck days ago is darkened like the others", () => {
    const stuck = () => ({ state: "YouTube", lastChanged: ago(4 * 24 * HOUR) });
    const { targets, spared } = spareWatched([lounge, diningLeft], { command: "turn_off" }, stuck, NOW);
    expect(spared).toEqual([]);
    expect(targets).toHaveLength(2);
  });
});
