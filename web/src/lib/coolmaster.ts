import type { Device } from "./registry";

/**
 * Climate setpoints bypass Control4. The Control4->CoolAutomation proxy
 * accepts climate.set_temperature but never applies it, and it never reports
 * a target temperature back (null when off, a bogus 0 when running) — see the
 * 2026-07-17 commissioning-log entry. The CoolMaster bridge is the device
 * that actually commands the indoor units, and Home Assistant's native
 * `coolmaster` integration exposes each unit as its own climate entity with
 * working setpoint read/write. Zones map to their unit ids in the entity map
 * (`coolmaster_units`); until the owner adds that integration in HA, these
 * entities are absent and the app degrades to today's behavior (unknown
 * setpoint, writes reported as "sent", never "confirmed").
 */

/** "L1.106" -> "climate.l1_106" (the coolmaster integration names entities by unit id). */
export function coolmasterEntityId(unit: string): string {
  return `climate.${unit.toLowerCase().replace(/\./g, "_")}`;
}

/** Entities to write a zone's setpoint to; open-plan zones drive several units. */
export function setpointEntityIds(device: Device): string[] | null {
  if (device.kind !== "climate" || !device.coolmasterUnits?.length) return null;
  return device.coolmasterUnits.map(coolmasterEntityId);
}
