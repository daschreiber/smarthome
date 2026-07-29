import { describe, expect, it } from "vitest";
import { buildDevices, type MapRow } from "../registry";

const rows: MapRow[] = [
  {
    entity_id: "light.knx_dimmer_daniel_study_lights",
    domain: "light",
    original_name: "KNX Dimmer Daniel Study lights",
    display_name: "Daniel Study lights",
    room: "Daniel's Study",
    floor: 5,
    category: "light_dimmer",
    group: "Lighting",
    visible: true,
  },
  {
    entity_id: "climate.ac_heating_a_c_kitchen",
    domain: "climate",
    original_name: "AC - Heating A/C Kitchen",
    display_name: "A/C & Heating",
    room: "Kitchen",
    floor: 6,
    category: "climate_zone",
    group: "Climate & Comfort",
    visible: true,
  },
  {
    entity_id: "vacuum.roborock_lounge",
    domain: "vacuum",
    original_name: "Lounge Roborock",
    display_name: "Lounge Roborock",
    room: "Lounge",
    floor: 6,
    category: "vacuum",
    group: "Appliances",
    visible: true,
  },
  {
    entity_id: "lock.front_door",
    domain: "lock",
    original_name: "Front Door",
    display_name: "Front door",
    room: "Entrance",
    floor: 6,
    category: "door_lock",
    group: "Security",
    visible: true,
  },
  {
    entity_id: "light.knx_switch_boiler_roof",
    domain: "light",
    original_name: "KNX Switch Boiler Roof",
    display_name: "Boiler Roof",
    room: "Utility Room",
    floor: 6,
    category: "infrastructure",
    group: "Utilities",
    visible: false,
  },
];

describe("buildDevices", () => {
  const devices = buildDevices(rows);

  it("produces stable, readable ids without exposing entity ids", () => {
    expect(devices[0].id).toBe("daniels_study__daniel_study_lights");
    expect(devices[1].id).toBe("kitchen__a_c_heating");
  });

  it("derives capabilities from domain and category", () => {
    expect(devices[0].capabilities).toContain("brightness");
    expect(devices[1].capabilities).toContain("set_temperature");
    expect(devices[2].capabilities).toEqual(["vacuum_control"]);
  });

  it("builds the vacuum as an ordinary room device", () => {
    expect(devices[2].id).toBe("lounge__lounge_roborock");
    expect(devices[2].kind).toBe("vacuum");
    expect(devices[2].floor).toBe(6);
  });

  it("forces the security tier onto lock rows regardless of the map", () => {
    expect(devices[3].kind).toBe("lock");
    expect(devices[3].capabilities).toEqual(["lock_unlock"]);
    expect(devices[3].requiresConfirmation).toBe(true);
  });

  it("keeps hidden entities in the registry but flagged", () => {
    expect(devices[4].visible).toBe(false);
  });

  it("de-duplicates colliding ids deterministically", () => {
    const dup = buildDevices([rows[0], { ...rows[0] }]);
    expect(dup[0].id).not.toBe(dup[1].id);
  });

  it("carries coolmaster units through to the device", () => {
    const [zone] = buildDevices([{ ...rows[1], coolmaster_units: ["L1.111", "L1.114"] }]);
    expect(zone.coolmasterUnits).toEqual(["L1.111", "L1.114"]);
    expect(devices[1].coolmasterUnits).toBeUndefined();
  });

  it("carries the pinned flag through to the device", () => {
    const [spots] = buildDevices([{ ...rows[0], pinned: true }]);
    expect(spots.pinned).toBe(true);
    expect(devices[0].pinned).toBeUndefined();
  });
});
