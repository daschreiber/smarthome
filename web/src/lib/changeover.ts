import { callService } from "./ha";
import { audit } from "./audit";

/**
 * Per-floor heat/cool changeover. Each floor's central VRF unit follows a
 * KNX changeover relay (AC\ HEAT 5TH / AC\HEAT 6TH, on = heating,
 * off = cooling); no room thermostat can leave the floor's mode until the
 * relay flips. The sequence replicates the installer's Control4 "AC 5th /
 * Heating 5th" macros verbatim (owner's screenshots, 2026-07-26): command a
 * sacrificial unit to the OPPOSITE of the target mode, settle 3s, flip the
 * relay, 7s, flip it again (KNX reliability), 3s, sacrificial unit off.
 * The opposite-mode step looks wrong but is what the installer field-tested —
 * copied as-is, not second-guessed.
 */

export type Floor = 5 | 6;
export type FloorMode = "heat" | "cool";

const FLOORS: Record<Floor, { relay: string; unit: string }> = {
  // Sacrificial units: floor 5 uses Rack UNIT 109 (CoolMaster L1.109),
  // floor 6 the Utility Room zone (L1.110) — same units the C4 macros drive.
  5: { relay: "light.knx_switch_ac_heat_5th", unit: "climate.l1_109" },
  6: { relay: "light.knx_switch_ac_heat_6th", unit: "climate.l1_110" },
};

const pending = new Map<Floor, FloorMode>();
const lastError = new Map<Floor, string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function relayEntityId(floor: Floor): string {
  return FLOORS[floor].relay;
}

/** Relay state → the floor's current mode (relay on = heating). */
export function modeFromRelayState(state: string | undefined): FloorMode | null {
  return state === "on" ? "heat" : state === "off" ? "cool" : null;
}

export function changeoverStatus(floor: Floor): {
  pending: FloorMode | null;
  lastError: string | null;
} {
  return { pending: pending.get(floor) ?? null, lastError: lastError.get(floor) ?? null };
}

/**
 * Kick off the ~13s changeover in the background (the server is long-lived;
 * the client sees progress via the relay state and `pending` in /api/home).
 * One changeover per floor at a time.
 */
export function startChangeover(
  floor: Floor,
  mode: FloorMode,
  user: string,
): { ok: true } | { ok: false; error: string } {
  if (pending.has(floor)) {
    return { ok: false, error: `floor ${floor} changeover already in progress` };
  }
  pending.set(floor, mode);
  lastError.delete(floor);
  void run(floor, mode, user);
  return { ok: true };
}

async function run(floor: Floor, mode: FloorMode, user: string): Promise<void> {
  const { relay, unit } = FLOORS[floor];
  const relayService = mode === "heat" ? "turn_on" : "turn_off";
  const started = Date.now();
  try {
    await callService("climate", "set_hvac_mode", {
      entity_id: unit,
      hvac_mode: mode === "heat" ? "cool" : "heat",
    });
    await sleep(3000);
    await callService("light", relayService, { entity_id: relay });
    await sleep(7000);
    await callService("light", relayService, { entity_id: relay });
    await sleep(3000);
    await callService("climate", "turn_off", { entity_id: unit });
    audit({
      ts: new Date().toISOString(), user, deviceId: `floor:${floor}`,
      entityId: relay, command: `changeover_${mode}`, args: { floor, mode },
      ok: true, durationMs: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastError.set(floor, message);
    audit({
      ts: new Date().toISOString(), user, deviceId: `floor:${floor}`,
      entityId: relay, command: `changeover_${mode}`, args: { floor, mode },
      ok: false, durationMs: Date.now() - started, error: message,
    });
  } finally {
    pending.delete(floor);
  }
}
