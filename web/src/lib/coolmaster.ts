import type { Device } from "./registry";

/**
 * Climate commands bypass Control4 entirely. The Control4->CoolAutomation
 * proxy accepts climate.set_temperature but never applies it, and it never
 * reports a target temperature back (null when off, a bogus 0 when running) —
 * see the 2026-07-17 commissioning-log entries. The CoolMaster bridge is the
 * device that actually commands the indoor units, and Home Assistant's native
 * `coolmaster` integration exposes each unit as its own climate entity with
 * working on/off and setpoint read/write. Zones map to their unit ids in the
 * entity map (`coolmaster_units`); zone STATE is still read from the Control4
 * entity, which reflects the bridge within ~4s and keeps multi-unit zones
 * grouped. If the coolmaster integration were ever removed from HA, commands
 * would target absent entities — the mapping only exists because the owner
 * added it (2026-07-17).
 */

/** "L1.106" -> "climate.l1_106" (the coolmaster integration names entities by unit id). */
export function coolmasterEntityId(unit: string): string {
  return `climate.${unit.toLowerCase().replace(/\./g, "_")}`;
}

/** Entities a zone's climate commands target; open-plan zones drive several units. */
export function unitEntityIds(device: Device): string[] | null {
  if (device.kind !== "climate" || !device.coolmasterUnits?.length) return null;
  return device.coolmasterUnits.map(coolmasterEntityId);
}
