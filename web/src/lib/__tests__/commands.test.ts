import { describe, expect, it } from "vitest";
import { CommandSchema, buildServiceCall } from "../commands";
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
  it("rejects unsafe temperatures", () => {
    expect(
      CommandSchema.safeParse({ command: "set_temperature", temperature: 45 }).success,
    ).toBe(false);
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
