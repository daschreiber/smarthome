import { describe, expect, it } from "vitest";
import { CommandSchema, assertCommandAllowed, buildServiceCall, expectedStates } from "../commands";
import type { Device } from "../registry";

const dimmer: Device = {
  id: "daniels_study__study_lights",
  entityId: "light.knx_dimmer_daniel_study_lights",
  kind: "light",
  label: "Study lights",
  room: "Daniel's Study",
  floor: 5,
  group: "Lighting",
  category: "light_dimmer",
  visible: true,
  capabilities: ["on_off", "brightness"],
};

const shade: Device = {
  id: "daniels_study__blinds",
  entityId: "cover.daniel_s_study_daniel_study_blinds",
  kind: "cover",
  label: "Blinds",
  room: "Daniel's Study",
  floor: 5,
  group: "Shades",
  category: "shade",
  visible: true,
  capabilities: ["open_close_stop", "position"],
};

const climate: Device = {
  id: "kitchen__a_c_heating",
  entityId: "climate.ac_heating_a_c_kitchen",
  kind: "climate",
  label: "A/C & Heating",
  room: "Kitchen",
  floor: 6,
  group: "Climate & Comfort",
  category: "climate_zone",
  visible: true,
  capabilities: ["set_temperature", "hvac_mode"],
};

describe("climate zone on/off (hvac_mode capability)", () => {
  it("allows turn_on/turn_off and maps them to the climate domain", () => {
    expect(buildServiceCall(climate, { command: "turn_on" })).toEqual({
      domain: "climate", service: "turn_on", data: { entity_id: climate.entityId },
    });
    expect(buildServiceCall(climate, { command: "turn_off" })).toEqual({
      domain: "climate", service: "turn_off", data: { entity_id: climate.entityId },
    });
  });
  it("still rejects on/off for devices with neither on_off nor hvac_mode", () => {
    expect(() => assertCommandAllowed(shade, { command: "turn_on" })).toThrow();
  });
  it("verifies climate turn_off by state but declines to verify turn_on", () => {
    expect(expectedStates({ command: "turn_off" }, "climate")).toEqual(["off"]);
    expect(expectedStates({ command: "turn_on" }, "climate")).toBeNull();
    expect(expectedStates({ command: "turn_on" }, "light")).toEqual(["on"]);
  });
});

describe("climate fan mode", () => {
  const zone: Device = {
    ...climate,
    capabilities: ["set_temperature", "hvac_mode", "fan_mode"],
    coolmasterUnits: ["L1.111", "L1.114"],
  };
  it("targets the zone's CoolMaster units, like setpoints do", () => {
    expect(buildServiceCall(zone, { command: "set_fan_mode", fanMode: "high" })).toEqual({
      domain: "climate",
      service: "set_fan_mode",
      data: { entity_id: ["climate.l1_111", "climate.l1_114"], fan_mode: "high" },
    });
  });
  it("requires the fan_mode capability", () => {
    expect(() => assertCommandAllowed(shade, { command: "set_fan_mode", fanMode: "high" })).toThrow();
  });
  it("schema accepts sane modes and rejects junk", () => {
    expect(CommandSchema.safeParse({ command: "set_fan_mode", fanMode: "low" }).success).toBe(true);
    expect(CommandSchema.safeParse({ command: "set_fan_mode", fanMode: "" }).success).toBe(false);
    expect(CommandSchema.safeParse({ command: "set_fan_mode", fanMode: "x".repeat(40) }).success).toBe(false);
  });
});

describe("vacuum commands", () => {
  const vacuum: Device = {
    id: "lounge__lounge_roborock",
    entityId: "vacuum.roborock_lounge",
    kind: "vacuum",
    label: "Lounge Roborock",
    room: "Lounge",
    floor: 6,
    group: "Appliances",
    category: "vacuum",
    visible: true,
    capabilities: ["vacuum_control"],
  };

  it("maps clean/pause/dock to the vacuum domain services", () => {
    expect(buildServiceCall(vacuum, { command: "start_cleaning" })).toEqual({
      domain: "vacuum", service: "start", data: { entity_id: vacuum.entityId },
    });
    expect(buildServiceCall(vacuum, { command: "pause_cleaning" })).toEqual({
      domain: "vacuum", service: "pause", data: { entity_id: vacuum.entityId },
    });
    expect(buildServiceCall(vacuum, { command: "return_to_dock" })).toEqual({
      domain: "vacuum", service: "return_to_base", data: { entity_id: vacuum.entityId },
    });
  });

  it("refuses vacuum commands elsewhere and non-vacuum commands on the vacuum", () => {
    expect(() => buildServiceCall(shade, { command: "start_cleaning" })).toThrow(/does not support/);
    expect(() => buildServiceCall(dimmer, { command: "return_to_dock" })).toThrow(/does not support/);
    expect(() => buildServiceCall(vacuum, { command: "turn_on" })).toThrow(/does not support/);
    expect(() => buildServiceCall(vacuum, { command: "stop" })).toThrow(/does not support/);
  });

  it("verifies by vacuum activity state", () => {
    expect(expectedStates({ command: "start_cleaning" })).toEqual(["cleaning"]);
    expect(expectedStates({ command: "pause_cleaning" })).toEqual(["paused"]);
    expect(expectedStates({ command: "return_to_dock" })).toEqual(["returning", "docked"]);
  });

  it("maps a segment clean to Roborock's app_segment_clean", () => {
    expect(
      buildServiceCall(vacuum, { command: "start_cleaning", segments: [16, 17], repeat: 2 }),
    ).toEqual({
      domain: "vacuum",
      service: "send_command",
      data: {
        entity_id: vacuum.entityId,
        command: "app_segment_clean",
        params: [{ segments: [16, 17], repeat: 2 }],
      },
    });
  });

  it("omits repeat for a single pass and segments for a whole-floor clean", () => {
    expect(
      buildServiceCall(vacuum, { command: "start_cleaning", segments: [16], repeat: 1 }).data,
    ).toEqual({
      entity_id: vacuum.entityId,
      command: "app_segment_clean",
      params: [{ segments: [16] }],
    });
    expect(buildServiceCall(vacuum, { command: "start_cleaning" })).toEqual({
      domain: "vacuum", service: "start", data: { entity_id: vacuum.entityId },
    });
  });

  it("maps suction to vacuum.set_fan_speed", () => {
    expect(buildServiceCall(vacuum, { command: "set_fan_speed", fanSpeed: "max_plus" })).toEqual({
      domain: "vacuum",
      service: "set_fan_speed",
      data: { entity_id: vacuum.entityId, fan_speed: "max_plus" },
    });
  });

  it("bounds segment/pass/fan-speed inputs at the schema", () => {
    expect(CommandSchema.safeParse({ command: "start_cleaning", segments: [16] }).success).toBe(true);
    expect(CommandSchema.safeParse({ command: "start_cleaning", segments: [] }).success).toBe(false);
    expect(CommandSchema.safeParse({ command: "start_cleaning", segments: [1.5] }).success).toBe(false);
    expect(CommandSchema.safeParse({ command: "start_cleaning", repeat: 4 }).success).toBe(false);
    expect(CommandSchema.safeParse({ command: "set_fan_speed", fanSpeed: "balanced" }).success).toBe(true);
    expect(CommandSchema.safeParse({ command: "set_fan_speed", fanSpeed: "rm -rf /" }).success).toBe(false);
  });
});

describe("CommandSchema", () => {
  it("accepts a valid brightness command", () => {
    expect(
      CommandSchema.safeParse({ command: "set_brightness", brightnessPct: 40 }).success,
    ).toBe(true);
  });
  it("rejects out-of-range brightness", () => {
    expect(
      CommandSchema.safeParse({ command: "set_brightness", brightnessPct: 140 }).success,
    ).toBe(false);
  });
  it("rejects unknown commands", () => {
    expect(CommandSchema.safeParse({ command: "self_destruct" }).success).toBe(false);
  });
  it("rejects absurd temperatures at the schema boundary", () => {
    expect(
      CommandSchema.safeParse({ command: "set_temperature", temperature: 200 }).success,
    ).toBe(false);
  });
});

describe("temperature bounds per kind", () => {
  const sauna: Device = {
    id: "sauna__klafs_sauna",
    entityId: "virtual.sauna",
    kind: "sauna",
    label: "Sauna",
    room: "Sauna",
    floor: 5,
    group: "Climate & Comfort",
    category: "sauna_heater",
    visible: true,
    capabilities: ["on_off", "set_temperature"],
    requiresConfirmation: true,
  };
  const climate: Device = {
    ...sauna,
    id: "kitchen__a_c_heating",
    entityId: "climate.ac_heating_a_c_kitchen",
    kind: "climate",
    category: "climate_zone",
    requiresConfirmation: false,
  };

  it("allows 85C for the sauna but not for room climate", () => {
    expect(() =>
      assertCommandAllowed(sauna, { command: "set_temperature", temperature: 85 }),
    ).not.toThrow();
    expect(() =>
      assertCommandAllowed(climate, { command: "set_temperature", temperature: 85 }),
    ).toThrow(/out of range/);
  });

  it("allows 22C for room climate but not for the sauna", () => {
    expect(() =>
      assertCommandAllowed(climate, { command: "set_temperature", temperature: 22 }),
    ).not.toThrow();
    expect(() =>
      assertCommandAllowed(sauna, { command: "set_temperature", temperature: 22 }),
    ).toThrow(/out of range/);
  });

  it("routes sauna execution away from Home Assistant", () => {
    expect(() => buildServiceCall(sauna, { command: "turn_on" })).toThrow(
      /sauna adapter/,
    );
  });
});

describe("expectedStates (read-back verification)", () => {
  it("proves on/off and cover motion states", () => {
    expect(expectedStates({ command: "turn_on" })).toEqual(["on"]);
    expect(expectedStates({ command: "set_brightness", brightnessPct: 30 })).toEqual(["on"]);
    expect(expectedStates({ command: "turn_off" })).toEqual(["off"]);
    expect(expectedStates({ command: "open" })).toEqual(["open", "opening"]);
    expect(expectedStates({ command: "close" })).toEqual(["closed", "closing"]);
  });
  it("declines to verify what state comparison cannot prove", () => {
    expect(expectedStates({ command: "stop" })).toBeNull();
    expect(expectedStates({ command: "set_position", positionPct: 50 })).toBeNull();
    expect(expectedStates({ command: "set_temperature", temperature: 22 })).toBeNull();
  });
});

describe("CoolMaster command routing", () => {
  const zone: Device = { ...climate, coolmasterUnits: ["L1.111", "L1.114", "L1.115"] };
  const units = ["climate.l1_111", "climate.l1_114", "climate.l1_115"];

  it("writes setpoints to the zone's CoolMaster unit entities", () => {
    expect(buildServiceCall(zone, { command: "set_temperature", temperature: 23 })).toEqual({
      domain: "climate",
      service: "set_temperature",
      data: { entity_id: units, temperature: 23 },
    });
  });

  it("routes on/off to the CoolMaster units as well", () => {
    expect(buildServiceCall(zone, { command: "turn_on" })).toEqual({
      domain: "climate", service: "turn_on", data: { entity_id: units },
    });
    expect(buildServiceCall(zone, { command: "turn_off" })).toEqual({
      domain: "climate", service: "turn_off", data: { entity_id: units },
    });
  });

  it("falls back to the Control4 zone entity when no units are mapped", () => {
    expect(
      buildServiceCall(climate, { command: "set_temperature", temperature: 23 }).data,
    ).toEqual({ entity_id: climate.entityId, temperature: 23 });
    expect(buildServiceCall(climate, { command: "turn_on" }).data).toEqual({
      entity_id: climate.entityId,
    });
  });
});

describe("buildServiceCall", () => {
  it("maps turn_on for a light", () => {
    expect(buildServiceCall(dimmer, { command: "turn_on" })).toEqual({
      domain: "light",
      service: "turn_on",
      data: { entity_id: dimmer.entityId },
    });
  });
  it("maps brightness to light.turn_on with brightness_pct", () => {
    expect(
      buildServiceCall(dimmer, { command: "set_brightness", brightnessPct: 25 }),
    ).toEqual({
      domain: "light",
      service: "turn_on",
      data: { entity_id: dimmer.entityId, brightness_pct: 25 },
    });
  });
  it("maps cover commands", () => {
    expect(buildServiceCall(shade, { command: "stop" }).service).toBe("stop_cover");
    expect(
      buildServiceCall(shade, { command: "set_position", positionPct: 50 }).data,
    ).toEqual({ entity_id: shade.entityId, position: 50 });
  });
  it("refuses a command the device does not support", () => {
    expect(() => buildServiceCall(shade, { command: "turn_on" })).toThrow(
      /does not support/,
    );
    expect(() =>
      buildServiceCall(dimmer, { command: "set_position", positionPct: 10 }),
    ).toThrow(/does not support/);
  });
});
