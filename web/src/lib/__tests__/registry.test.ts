import { describe, expect, it } from "vitest";
import { buildDevices, reconcileEntityIds, type MapRow } from "../registry";

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

  it("carries the lock's battery sensor through to the device", () => {
    const [lock] = buildDevices([{ ...rows[3], battery_entity: "sensor.front_door_battery" }]);
    expect(lock.batteryEntity).toBe("sensor.front_door_battery");
    expect(devices[3].batteryEntity).toBeUndefined();
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

  it("carries entity aliases through to the device", () => {
    const [tv] = buildDevices([aliasedRow]);
    expect(tv.id).toBe("dining__dining_left");
    expect(tv.entityAliases).toEqual(["media_player.left_32"]);
    expect(devices[0].entityAliases).toBeUndefined();
  });

  it("carries retry_power through to the device", () => {
    const [tv] = buildDevices([frameRow]);
    expect(tv.entityId).toBe("media_player.left_32_qe32ls03cbuxil");
    expect(tv.retryPower).toBe(true);
    expect(devices[0].retryPower).toBeUndefined();
  });

  it("carries a wake entity through to the device", () => {
    const [tv] = buildDevices([{ ...frameRow, wake_entity: "media_player.st_dining_left" }]);
    expect(tv.wakeEntityId).toBe("media_player.st_dining_left");
    const [plain] = buildDevices([frameRow]);
    expect(plain.wakeEntityId).toBeUndefined();
  });
});

// A Dining Frame as the map has it since 2026-09-10: the Samsung TV
// integration's own entity id, and power commands flagged for re-sending.
const frameRow: MapRow = {
  entity_id: "media_player.left_32_qe32ls03cbuxil",
  domain: "media_player",
  original_name: "Dining Left",
  display_name: "Dining Left",
  room: "Dining",
  floor: 6,
  category: "media",
  group: "Media",
  visible: true,
  retry_power: true,
};

// The alias mechanism's fixture: the same screen as it was first mapped on
// 2026-09-09, from a screenshot that showed the device renamed "Dining
// Left" from "Left 32" but not whether the entity id followed. (It hadn't
// — neither id existed; see the 2026-09-10 commissioning entry.) No map
// row uses aliases today; the mechanism stays for the next screenshot.
const aliasedRow: MapRow = {
  ...frameRow,
  entity_id: "media_player.dining_left",
  retry_power: undefined,
  entity_aliases: ["media_player.left_32"],
};

describe("reconcileEntityIds", () => {
  it("keeps the mapped id when HA has it", () => {
    const devices = buildDevices([aliasedRow]);
    const switched = reconcileEntityIds(devices, (id) => id === "media_player.dining_left");
    expect(switched).toEqual([]);
    expect(devices[0].entityId).toBe("media_player.dining_left");
  });

  it("settles onto the alias HA actually has, keeping the old id as an alias", () => {
    const devices = buildDevices([aliasedRow]);
    const switched = reconcileEntityIds(devices, (id) => id === "media_player.left_32");
    expect(switched).toEqual(["dining__dining_left: media_player.dining_left -> media_player.left_32"]);
    expect(devices[0].entityId).toBe("media_player.left_32");
    expect(devices[0].entityAliases).toEqual(["media_player.dining_left"]);
    // A later rename the other way switches back.
    reconcileEntityIds(devices, (id) => id === "media_player.dining_left");
    expect(devices[0].entityId).toBe("media_player.dining_left");
    expect(devices[0].entityAliases).toEqual(["media_player.left_32"]);
  });

  it("leaves a device alone when HA has neither id (outage, not a rename)", () => {
    const devices = buildDevices([aliasedRow, rows[0]]);
    expect(reconcileEntityIds(devices, () => false)).toEqual([]);
    expect(devices[0].entityId).toBe("media_player.dining_left");
    expect(devices[1].entityId).toBe(rows[0].entity_id);
  });
});
