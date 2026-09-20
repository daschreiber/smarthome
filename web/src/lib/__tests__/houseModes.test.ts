import { describe, expect, it } from "vitest";
import {
  HOUSE_MODES, houseModeById, houseModeVocabulary, listHouseModes, resolveHouseMode,
} from "../houseModes";
import { getDevice } from "../registry";

/**
 * The whole-house modes as scenes: a fixed table over the registry's scene
 * switches, with the spoken aliases an agent may use for them.
 */

describe("the mode table", () => {
  it("names the five whole-house scene switches, each present in the registry", () => {
    expect(HOUSE_MODES.map((m) => [m.id, m.name, m.deviceId])).toEqual([
      ["mode_night", "Night", "whole_house__all_house_night"],
      ["mode_morning", "Morning", "whole_house__all_house_morning"],
      ["mode_exit", "Exit", "whole_house__all_house_exit"],
      ["mode_welcome", "Welcome", "whole_house__welcome"],
      ["mode_main", "Main All House", "whole_house__main_all_house"],
    ]);
    for (const m of HOUSE_MODES) {
      const d = getDevice(m.deviceId);
      expect(d, m.id).toBeDefined();
      expect(d!.category, m.id).toBe("scene_switch");
      expect(d!.room, m.id).toBe("Whole House");
      expect(d!.capabilities, m.id).toContain("on_off");
    }
  });

  it("lists every mode with its switch, in table order", () => {
    const listed = listHouseModes();
    expect(listed.map((x) => x.mode.id)).toEqual(HOUSE_MODES.map((m) => m.id));
    expect(listed.map((x) => x.device.label)).toEqual(["All House Night", "All House Morning", "All House Exit", "Welcome", "Main All House"]);
  });

  it("the vocabulary line carries every id and alias for the tool descriptions", () => {
    const line = houseModeVocabulary();
    for (const m of HOUSE_MODES) {
      expect(line).toContain(m.id);
      for (const a of m.aliases) expect(line).toContain(`"${a}"`);
    }
  });
});

describe("resolveHouseMode", () => {
  const cases: Array<[string, string]> = [
    ["night mode", "mode_night"], ["night", "mode_night"], ["sleep mode", "mode_night"],
    ["day mode", "mode_morning"], ["morning mode", "mode_morning"], ["morning", "mode_morning"], ["day", "mode_morning"],
    ["exit mode", "mode_exit"], ["leaving", "mode_exit"], ["away mode", "mode_exit"],
    ["welcome mode", "mode_welcome"], ["arriving", "mode_welcome"],
    ["main all house", "mode_main"],
  ];

  it.each(cases)("alias %j resolves to %s", (alias, id) => {
    expect(resolveHouseMode(alias)?.id).toBe(id);
  });

  it("is case-insensitive and forgiving about spacing, hyphens and underscores", () => {
    expect(resolveHouseMode("Night Mode")?.id).toBe("mode_night");
    expect(resolveHouseMode("  SLEEP MODE ")?.id).toBe("mode_night");
    expect(resolveHouseMode("night-mode")?.id).toBe("mode_night");
    expect(resolveHouseMode("night_mode")?.id).toBe("mode_night");
    expect(resolveHouseMode("MODE_NIGHT")?.id).toBe("mode_night");
    expect(resolveHouseMode("Away  Mode")?.id).toBe("mode_exit");
  });

  it("takes the mode's id, its clean name, and the switch's device id", () => {
    expect(resolveHouseMode("mode_welcome")?.id).toBe("mode_welcome");
    expect(resolveHouseMode("Welcome")?.id).toBe("mode_welcome");
    expect(resolveHouseMode("whole_house__welcome")?.id).toBe("mode_welcome");
    expect(resolveHouseMode("Main All House")?.id).toBe("mode_main");
  });

  it("answers undefined for anything else — never a guess", () => {
    for (const s of ["", "   ", "party mode", "evening", "nightly", "mode", "all house", "pre_workout"]) {
      expect(resolveHouseMode(s), JSON.stringify(s)).toBeUndefined();
    }
  });
});

describe("houseModeById", () => {
  it("matches a stored id exactly, and nothing looser", () => {
    expect(houseModeById("mode_night")?.name).toBe("Night");
    expect(houseModeById("night mode")).toBeUndefined();
    expect(houseModeById("MODE_NIGHT")).toBeUndefined();
    expect(houseModeById("pre_workout")).toBeUndefined();
  });
});
