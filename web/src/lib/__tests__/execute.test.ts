import { describe, expect, it } from "vitest";
import { SYSTEM_COMMANDS, executeSystemCommand, roomLights, systemDevices } from "../execute";
import { registry } from "../registry";

describe("systemDevices", () => {
  it("lighting is real lights only — no scene switches, fans, vents, or towel rails", () => {
    const lights = systemDevices("lighting");
    expect(lights.length).toBeGreaterThan(50);
    for (const d of lights) {
      expect(d.kind).toBe("light");
      expect(d.group).toBe("Lighting");
      expect(d.category).not.toBe("scene_switch");
    }
  });

  it("climate is A/C zones only — never the sauna", () => {
    const zones = systemDevices("climate");
    expect(zones.length).toBeGreaterThan(5);
    for (const d of zones) expect(d.kind).toBe("climate");
    expect(zones.some((d) => d.kind === "sauna" || d.category === "sauna_heater")).toBe(false);
  });

  it("shades are all covers", () => {
    const shades = systemDevices("shades");
    expect(shades.length).toBeGreaterThan(5);
    for (const d of shades) expect(d.kind).toBe("cover");
  });
});

describe("roomLights", () => {
  it("sweeps only group Lighting — never fans, vents, towel rails, or heating", () => {
    const rooms = new Set(registry().devices.map((d) => d.room));
    for (const room of rooms) {
      for (const d of roomLights(room)) {
        expect(d.group, `${d.id} must not be in a lights fan-out`).toBe("Lighting");
        expect(d.kind).toBe("light");
      }
    }
    // Sanity: the boundary excludes real comfort devices that ride the light
    // domain (Master Bathroom has a towel rail and a vent).
    const bathSweep = roomLights("Master Bathroom").map((d) => d.category);
    expect(bathSweep).not.toContain("towel_rail");
    expect(bathSweep).not.toContain("ventilation");
    expect(bathSweep.length).toBeGreaterThan(0);
  });
});

describe("executeSystemCommand", () => {
  it("rejects commands that don't belong to the system", async () => {
    await expect(executeSystemCommand("lighting", "open")).rejects.toThrow();
    await expect(executeSystemCommand("climate", "close")).rejects.toThrow();
    await expect(executeSystemCommand("shades", "turn_off")).rejects.toThrow();
  });

  it("reports no matching devices for an unknown room instead of throwing", async () => {
    const result = await executeSystemCommand("lighting", "turn_off", ["No Such Room"]);
    expect(result.total).toBe(0);
    expect(result.failed).toHaveLength(1);
  });

  it("declares only simple, reversible commands per system", () => {
    expect(SYSTEM_COMMANDS.lighting).toEqual(["turn_on", "turn_off"]);
    expect(SYSTEM_COMMANDS.climate).toEqual(["turn_on", "turn_off"]);
    expect(SYSTEM_COMMANDS.shades).toEqual(["open", "close", "stop"]);
  });
});
