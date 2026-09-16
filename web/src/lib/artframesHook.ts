import { createHash, timingSafeEqual } from "node:crypto";
import { MORNING_SCENE_SWITCH, NIGHT_SCENE_SWITCH } from "./artframes";
import { registry, type Device } from "./registry";

/**
 * The wall keypad's Night and Morning, relayed by Home Assistant.
 *
 * The picture Frames follow a PRESS of the Night or Morning scene switch
 * (lib/artframes), and until 2026-09-16 the only presses the app could see
 * were its own — a card tap or an automation step. The owner presses the
 * wall keypad. That press is a KNX telegram to the scene group address,
 * which Control4 acts on and Home Assistant's KNX integration can be told
 * to report as a `knx_event` (it sees native keypads fine; the blind spot
 * in knx/README.md is Control4-ORIGINATED traffic, which is exactly what
 * the app's own presses are — so a press from the app is never also seen
 * here, and nothing sweeps twice). An HA automation on that event calls
 * `POST /api/artframes` with `{ press: "night" | "morning" }`, and the
 * app runs the same follower it runs for its own presses: the same Frame
 * list, the same "spare a set being watched" rule, the same wake path.
 *
 * Authentication: HA presents `HA_HOOK_KEY` in an `x-hook-key` header. It
 * is a separate secret from `APP_KEY` (which acts as admin) on purpose —
 * a copy of the Green's configuration.yaml must not be a copy of the
 * house's keys. The header buys exactly one thing: a Night or Morning
 * sweep of the Frames, which the keypad on the wall already does.
 *
 * Two telegrams for one press (the keypads' direction-memory quirk, a
 * bounced contact, an automation that re-fires on reload) must not run
 * the sweep twice: a repeat of the same press inside a short window is
 * answered as a duplicate and does nothing.
 */

export type Press = "night" | "morning";

/** A second copy of the same press inside this window is ignored. */
export const DUPLICATE_WINDOW_MS = 10_000;

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
 *  the automation passes (the keypad's KNX address, "keypad" by default).
 *  Anything but a short token is dropped rather than written to the log. */
export function pressUser(source: unknown): string {
  const s = typeof source === "string" && /^[A-Za-z0-9._:-]{1,40}$/.test(source) ? source : "keypad";
  return `ha:${s}`;
}

/** The scene switch the press stands for — the follower keys on it. */
export function sceneSwitchFor(press: Press): Device | undefined {
  const entityId = press === "night" ? NIGHT_SCENE_SWITCH : MORNING_SCENE_SWITCH;
  return registry().devices.find((d) => d.entityId === entityId);
}

const lastPress = new Map<Press, number>();

/** Record this press; true when the same press already ran inside the
 *  duplicate window (the caller then does nothing). */
export function duplicatePress(press: Press, now = Date.now()): boolean {
  const prev = lastPress.get(press);
  if (prev != null && now - prev < DUPLICATE_WINDOW_MS) return true;
  lastPress.set(press, now);
  return false;
}

/** Tests only. */
export function resetPressMemory(): void {
  lastPress.clear();
}
