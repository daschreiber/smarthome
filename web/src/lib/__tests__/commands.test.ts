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
