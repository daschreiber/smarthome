import { createHash, timingSafeEqual } from "node:crypto";
import { MORNING_SCENE_SWITCH, NIGHT_SCENE_SWITCH, type Press } from "./artframes";
import { registry, type Device } from "./registry";

/**
 * Night and Morning pressed anywhere but the app, relayed by Home Assistant.
 *
 * The picture Frames follow a PRESS of the Night or Morning scene switch
 * (lib/artframes), and until 2026-09-16 the only presses the app could see
 * were its own — a card tap or an automation step. The owner presses the
 * wall keypad; the household also has Alexa, Siri / Apple Home and HA's own
 * dashboard. None of those go through the app:
 *
 * - The wall keypad is a KNX telegram to the scene group address, which
 *   Control4 acts on. Home Assistant's KNX integration can be told to
 *   report it as a `knx_event` (it sees native keypads fine; the blind
 *   spot in knx/README.md is Control4-ORIGINATED traffic).
 * - Alexa, Siri / Apple Home and the dashboard call `light.turn_on` on the
 *   switch through HA's service bus, which fires a `call_service` event —
 *   as does the app's own press, which is why the follower drops a repeat
 *   of the same press inside a short window (lib/artframes `recordPress`).
 *
 * An HA automation on both events (ha/artframes_keypad.yaml) calls
 * `POST /api/artframes` with `{ press: "night" | "morning", source }`, and
 * the app runs the same follower it runs for its own presses: the same
 * Frame list, the same "spare a set being watched" rule, the same wake
 * path.
 *
 * Authentication: HA presents `HA_HOOK_KEY` in an `x-hook-key` header. It
 * is a separate secret from `APP_KEY` (which acts as admin) on purpose —
 * a copy of the Green's configuration.yaml must not be a copy of the
 * house's keys. The header buys exactly one thing: a Night or Morning
 * sweep of the Frames, which the keypad on the wall already does.
 */

export function hookConfigured(): boolean {
  return !!process.env.HA_HOOK_KEY;
}

/** Constant-time comparison of the presented key with HA_HOOK_KEY; false
 *  when either is missing. Hashing first equalises lengths so the compare
 *  never leaks how long the real key is. */
export function hookKeyMatches(given: string | null | undefined): boolean {
  const key = process.env.HA_HOOK_KEY;
  if (!key || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(key).digest();
  return timingSafeEqual(a, b);
}

export function parsePress(value: unknown): Press | null {
  return value === "night" || value === "morning" ? value : null;
}

/** Who pressed, for the audit line: `ha:<source>`, where source is what
 *  the automation passes (the keypad's KNX address, `voice-or-ui` for a
 *  service call; "keypad" by default). Anything but a short token is
 *  dropped rather than written to the log. */
export function pressUser(source: unknown): string {
  const s = typeof source === "string" && /^[A-Za-z0-9._:-]{1,40}$/.test(source) ? source : "keypad";
  return `ha:${s}`;
}

/** The scene switch the press stands for — the follower keys on it. */
export function sceneSwitchFor(press: Press): Device | undefined {
  const entityId = press === "night" ? NIGHT_SCENE_SWITCH : MORNING_SCENE_SWITCH;
  return registry().devices.find((d) => d.entityId === entityId);
}
