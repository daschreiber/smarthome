import { describe, expect, it } from "vitest";
import { commandEntityIds, deviceUnreachable, entityUnreachable } from "../reachability";
import type { Device } from "../registry";

const light: Device = {
  id: "den__center_spots",
  entityId: "light.den_center_spots",
  kind: "light",
  label: "Center Spots",
  room: "Den",
  floor: 5,
  group: "Lighting",
  category: "light_dimmer",
  visible: true,
  capabilities: ["on_off", "brightness"],
};

const zone: Device = {
  id: "den__a_c_heating",
  entityId: "climate.ac_heating_a_c_den",
  kind: "climate",
  label: "A/C & Heating",
  room: "Den",
  floor: 5,
  group: "Climate & Comfort",
  category: "climate_zone",
  visible: true,
  capabilities: ["set_temperature", "hvac_mode"],
  coolmasterUnits: ["L1.102", "L1.103"],
};

describe("commandEntityIds", () => {
  it("a light's command lands on its own entity", () => {
    expect(commandEntityIds(light)).toEqual(["light.den_center_spots"]);
  });
  it("a climate zone's commands land on its CoolMaster units, matching buildServiceCall", () => {
    expect(commandEntityIds(zone)).toEqual(["climate.l1_102", "climate.l1_103"]);
  });
  it("a zone with no units falls back to its own entity", () => {
    expect(commandEntityIds({ ...zone, coolmasterUnits: undefined })).toEqual([zone.entityId]);
  });
});

describe("entityUnreachable — only positive evidence blocks", () => {
  it("'unavailable' is HA saying it cannot reach the device", () => {
    expect(entityUnreachable({ state: "unavailable" })).toBe(true);
  });
  it("an entity gone from HA (failed config entry deletes its entities) is unreachable", () => {
    expect(entityUnreachable(null)).toBe(true);
  });
  it("'unknown' passes — the transient state after an HA restart is not an outage", () => {
    expect(entityUnreachable({ state: "unknown" })).toBe(false);
  });
  it("a failed read passes — refuse on the house's evidence, not our own hiccup", () => {
    expect(entityUnreachable(undefined)).toBe(false);
  });
  it("real states pass", () => {
    expect(entityUnreachable({ state: "off" })).toBe(false);
    expect(entityUnreachable({ state: "on" })).toBe(false);
  });
});

describe("deviceUnreachable", () => {
  const readsFrom = (m: Record<string, { state: string } | null>) => (id: string) =>
    id in m ? m[id] : undefined;

  it("an unavailable light is unreachable", () => {
    expect(deviceUnreachable(light, readsFrom({ [light.entityId]: { state: "unavailable" } }))).toBe(true);
  });
  it("the outage shape: light off in the map but its entity is gone", () => {
    expect(deviceUnreachable(light, readsFrom({ [light.entityId]: null }))).toBe(true);
  });
  it("a two-unit zone with one live unit still deserves the command", () => {
    expect(
      deviceUnreachable(
        zone,
        readsFrom({ "climate.l1_102": { state: "unavailable" }, "climate.l1_103": { state: "cool" } }),
      ),
    ).toBe(false);
  });
  it("a zone is unreachable only when every unit is", () => {
    expect(
      deviceUnreachable(
        zone,
        readsFrom({ "climate.l1_102": { state: "unavailable" }, "climate.l1_103": null }),
      ),
    ).toBe(true);
  });
  it("the Control4 zone entity being down does NOT block a zone that commands CoolMaster units", () => {
    // Exactly the 2026-08-12 outage: climate.* C4 entities unavailable,
    // CoolMaster bridge fine — A/C must keep working.
    expect(
      deviceUnreachable(
        zone,
        readsFrom({
          [zone.entityId]: { state: "unavailable" },
          "climate.l1_102": { state: "off" },
          "climate.l1_103": { state: "off" },
        }),
      ),
    ).toBe(false);
  });
});
