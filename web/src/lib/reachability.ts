import { unitEntityIds } from "./coolmaster";
import type { Device } from "./registry";

/**
 * "Unavailable is not off" — the power-outage lesson (2026-08-12). When Home
 * Assistant loses an integration (the Control4 link, after the outage), its
 * entities read "unavailable", HA still answers 200 to service calls against
 * them, and nothing physically happens. The app's job is to refuse loudly and
 * say what's dead, not to flash success over it — Apple Home managed to say
 * "No Response" while our own cards claimed "all lights off" and took taps.
 *
 * This module is the one place that decides what "unreachable" means, shared
 * by the interactive command routes. Deliberately NOT wired into scenes,
 * automations, or the scheduler: those paths command blind on purpose (the
 * hold loop re-asserts when entities come back; a scene applied during a
 * blip should still land on whatever is reachable).
 */

/** A state read shaped like lib/ha's HaState, or null (entity not in HA at
 *  all — a config entry that failed setup deletes its entities), or
 *  undefined (the read itself failed — no verdict). */
export type StateRead = { state: string } | null | undefined;

/**
 * The entities whose availability decides whether a command can land.
 * Climate zones command their CoolMaster units, never the Control4 zone
 * entity (lib/commands climateTarget) — so a zone stays commandable while
 * Control4 is down, which is exactly the outage the A/C survived.
 */
export function commandEntityIds(device: Device): string[] {
  if (device.kind === "climate") return unitEntityIds(device) ?? [device.entityId];
  return [device.entityId];
}

/**
 * Only positive evidence blocks a command (the knxLights rule, inverted):
 * "unavailable" and entity-gone are HA saying "I cannot reach this device".
 * "unknown" passes — it's the transient state after an HA restart before the
 * first poll, and blocking it would brick every light for a minute each
 * reboot. A failed read (undefined) also passes: better to attempt a command
 * that may work than to refuse on our own connectivity hiccup.
 */
export function entityUnreachable(read: StateRead): boolean {
  return read === null || read?.state === "unavailable";
}

/**
 * A device is unreachable only when EVERY entity its command targets is —
 * a two-unit climate zone with one live unit still deserves the command.
 */
export function deviceUnreachable(device: Device, readFor: (id: string) => StateRead): boolean {
  return commandEntityIds(device).every((id) => entityUnreachable(readFor(id)));
}
