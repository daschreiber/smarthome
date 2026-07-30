import { buildServiceCall, type Command, type ServiceCall } from "./commands";
import { audit } from "./audit";
import { callService, getStates } from "./ha";
import type { Device } from "./registry";

/**
 * KNX light commands get dropped, and this house has said so twice already:
 * the installer's own changeover macro flips its relay **twice** "(KNX
 * reliability)" (lib/changeover), and holdUntil re-lights automation lights
 * that come back off (lib/scheduler). Until now the interactive path had no
 * such belt — one telegram, one hope.
 *
 * Owner symptom that made that a real defect (2026-07-30, Daniel's Study):
 * the study's dimmers — Study Spots and the two strips — obey **off** and
 * **dim** reliably, but a turn-on from cold lands maybe one tap in two.
 * "If I try a few times the strip comes on but the spots still don't."
 * The plain KNX *switch* channels in the same room (desk light, closet) were
 * never affected — it is the dimmer channels that lose the on.
 *
 * So a light command is treated as an INTENT, not a telegram: send it, watch
 * the read-back, and send it again while the light still disagrees. Two
 * details matter.
 *
 * 1. The retry ESCALATES for dimmers rather than just repeating. A bare
 *    `light.turn_on` reaches these Control4-fronted KNX dimmers as "ramp to
 *    full" with no level named; an explicit brightness is the shape the
 *    slider sends, and the slider is the control the owner reports as
 *    reliable. Same intent, different telegram — worth more than a rerun of
 *    the one that just vanished.
 * 2. It gives up. The hold loop's lesson (lib/scheduler): a re-assert that
 *    never stands down fights the person at the wall switch. Three attempts,
 *    then the command is recorded unverified and the card says so instead of
 *    showing a light that isn't lit.
 */

/** Total sends per command, including the first one. */
export const LIGHT_ATTEMPTS = 3;

/** How long a send gets to prove itself before the next one goes out. Control4
 *  publishes KNX status ~3.7s behind reality (COMMISSIONING_LOG 2026-07-16),
 *  so this is deliberately longer than a poll cycle: it must outlast feedback
 *  lag, or every command would re-assert against its own stale read. */
export const REASSERT_AFTER_MS = 4200;

/** Verification window for a retriable light command — three attempts at
 *  REASSERT_AFTER_MS apart, plus a last feedback cycle to land. */
export const LIGHT_VERIFY_MS = 16_000;

/** Only lights, and only the commands whose outcome a state read can prove. */
export function lightRetriable(device: Device, cmd: Command): boolean {
  return (
    device.kind === "light" &&
    (cmd.command === "turn_on" ||
      cmd.command === "turn_off" ||
      cmd.command === "set_brightness")
  );
}

/**
 * The call to send on attempt `attempt` (0 = the original). Dimmable lights
 * escalate a bare turn_on into an explicit full-brightness turn_on: Home
 * Assistant already ramps these dimmers to 100 when no level is given, so
 * this changes the telegram's shape without changing what was asked for.
 */
export function reassertCall(device: Device, cmd: Command, attempt: number): ServiceCall {
  const base = buildServiceCall(device, cmd);
  if (attempt === 0) return base;
  if (cmd.command !== "turn_on" || !device.capabilities.includes("brightness")) return base;
  return { ...base, data: { ...base.data, brightness_pct: 100 } };
}

/**
 * Commands that were sent, retried, and still never showed up in the light's
 * own state. The UI polls this through /api/home so a card can stop claiming
 * a light is on when the house disagrees — without it the optimistic overlay
 * holds "on" for its full window and the owner's next tap sends turn_OFF,
 * which is exactly what "I tried a few times and nothing happened" is made
 * of. In-memory on purpose (single service, same as changeoverStatus).
 */
interface UnverifiedCommand {
  command: string;
  ts: string;
}

const unverified = new Map<string, UnverifiedCommand>();

/** A mark older than this is history, not news: the card stops flagging it. */
export const UNVERIFIED_TTL_MS = 90_000;

export function noteUnverified(deviceId: string, command: string): void {
  unverified.set(deviceId, { command, ts: new Date().toISOString() });
}

export function clearUnverified(deviceId: string): void {
  unverified.delete(deviceId);
}

/** The state a light command is trying to produce. */
export function wantedState(command: string): "on" | "off" {
  return command === "turn_off" ? "off" : "on";
}

/**
 * `liveState` retires a mark the house has since overtaken: a light that got
 * there in the end — a late telegram, or someone at the wall switch — is not
 * a light that ignored you, and the card should stop saying so.
 */
export function unverifiedFor(
  deviceId: string,
  liveState?: string,
  now = Date.now(),
): UnverifiedCommand | null {
  const u = unverified.get(deviceId);
  if (!u) return null;
  if (now - Date.parse(u.ts) > UNVERIFIED_TTL_MS || liveState === wantedState(u.command)) {
    unverified.delete(deviceId);
    return null;
  }
  return u;
}

/** Test seam only. */
export function resetUnverified(): void {
  unverified.clear();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The room-sweep counterpart to the single-device verification in the command
 * route: "Room lights on" fans one request across a room's fixtures, and each
 * of those telegrams can go missing on its own. Runs in the background after
 * the route has already answered — the caller must not await it.
 *
 * Only POSITIVE evidence moves a light out of the pending set (the hold
 * loop's rule, lib/scheduler): an entity reading unavailable is not proof of
 * anything, in either direction.
 */
export async function verifyLightSweep(
  targets: Device[],
  cmd: Command,
  user: string,
  room: string | null,
): Promise<void> {
  const lights = targets.filter((d) => lightRetriable(d, cmd));
  if (lights.length === 0) return;
  const want = cmd.command === "turn_off" ? "off" : "on";
  const started = Date.now();
  const deadline = started + LIGHT_VERIFY_MS;
  const attempts = new Map(lights.map((d) => [d.id, 1]));
  const lastSent = new Map(lights.map((d) => [d.id, started]));
  let waiting = [...lights];

  for (;;) {
    await sleep(900);
    const states = new Map(
      (await getStates().catch(() => [])).map((s) => [s.entity_id, s.state]),
    );
    waiting = waiting.filter((d) => states.get(d.entityId) !== want);
    if (waiting.length === 0 || Date.now() >= deadline) break;
    for (const d of waiting) {
      // Re-send only where the light positively contradicts the command; a
      // missing or unavailable read gets waited out, not shouted at.
      const seen = states.get(d.entityId);
      if (seen == null || seen === "unavailable" || seen === "unknown") continue;
      const n = attempts.get(d.id)!;
      if (n >= LIGHT_ATTEMPTS || Date.now() - lastSent.get(d.id)! < REASSERT_AFTER_MS) continue;
      const call = reassertCall(d, cmd, n);
      await callService(call.domain, call.service, call.data).catch(() => {});
      attempts.set(d.id, n + 1);
      lastSent.set(d.id, Date.now());
    }
  }

  const stuck = new Set(waiting.map((d) => d.id));
  for (const d of lights) {
    if (stuck.has(d.id)) noteUnverified(d.id, cmd.command);
    else clearUnverified(d.id);
  }
  const retried = [...attempts.entries()].filter(([, n]) => n > 1);
  if (stuck.size === 0 && retried.length === 0) return; // nothing worth a line
  audit({
    ts: new Date().toISOString(),
    user,
    deviceId: room ? `system:lighting:${room}` : "system:lighting",
    entityId: "system.lighting",
    command: `${cmd.command}_verify`,
    args: {
      targets: lights.length,
      reasserted: Object.fromEntries(retried.map(([id, n]) => [id, n - 1])),
      unverified: [...stuck],
    },
    ok: stuck.size === 0,
    durationMs: Date.now() - started,
    error: stuck.size ? `never reported ${want}: ${[...stuck].join(", ")}` : undefined,
  });
}
