import { callService } from "./ha";

/**
 * Eight Sleep adapter. The Pod joins through Home Assistant like the sauna
 * and the future Yale locks (IMPLEMENTATION_SPEC Phase F pattern) — but via
 * a community HACS integration (lukas-clarke/eight_sleep), because Eight
 * Sleep killed the API the official core integration used. Cloud-only, no
 * local path exists for the Pod at all.
 *
 * Unlike the sauna (whose entity is pure fiction) the bed's entities DO
 * exist in HA; what's special is the COMMAND surface: temperature and side
 * on/off go through the integration's own `eight_sleep.*` services, not
 * standard domain services — so kind "bed" is executed here, never by
 * buildServiceCall.
 *
 * Configuration is env-driven and per side, so one-side setups work and
 * nothing appears until the integration is actually installed
 * (docs/EIGHT_SLEEP_SETUP.md is the on-site runbook):
 *
 * - EIGHTSLEEP_LEFT_TARGET_ENTITY    the side's bed-temperature entity —
 *                                    the entity the eight_sleep services
 *                                    target (from Developer Tools → States)
 * - EIGHTSLEEP_LEFT_PRESENCE_ENTITY  optional binary_sensor.*_bed_presence;
 *                                    feeds the Sleep sense watcher
 * - EIGHTSLEEP_LEFT_LABEL            optional display name ("Daniel's side")
 * - …and the same three with RIGHT.
 *
 * The service names below match lukas-clarke/eight_sleep as of 2025; they
 * are constants in ONE place so a rename upstream is a one-line fix. The
 * warmth scale is Eight Sleep's own unit-less -100 (coolest) … +100
 * (warmest) — deliberately NOT mapped to °C; the app shows it as warmth.
 */

export const EIGHT_DOMAIN = "eight_sleep";
export const SVC_HEAT_SET = "heat_set";
export const SVC_SIDE_ON = "side_on";
export const SVC_SIDE_OFF = "side_off";
export const SVC_AWAY_START = "away_mode_start";
export const SVC_AWAY_STOP = "away_mode_stop";

export type BedSideName = "left" | "right";

export interface BedSide {
  side: BedSideName;
  label: string;
  /** The eight_sleep entity its services target (the side's temp entity). */
  targetEntity: string;
  /** binary_sensor bed presence for this side, when configured. */
  presenceEntity?: string;
}

function sideFromEnv(side: BedSideName): BedSide | null {
  const P = side.toUpperCase();
  const targetEntity = process.env[`EIGHTSLEEP_${P}_TARGET_ENTITY`];
  if (!targetEntity) return null;
  return {
    side,
    label: process.env[`EIGHTSLEEP_${P}_LABEL`] || `Bed — ${side} side`,
    targetEntity,
    presenceEntity: process.env[`EIGHTSLEEP_${P}_PRESENCE_ENTITY`] || undefined,
  };
}

/** Read env at call time (not module init) so tests and redeploys see truth. */
export function bedSides(): BedSide[] {
  return (["left", "right"] as const)
    .map(sideFromEnv)
    .filter((s): s is BedSide => s !== null);
}

export function bedConfigured(): boolean {
  return bedSides().length > 0;
}

/** Stable app device id per side (the browser never sees entity ids). */
export function bedDeviceId(side: BedSideName): string {
  return `master_bedroom__bed_${side}`;
}

export function bedSideForDeviceId(deviceId: string): BedSide | undefined {
  return bedSides().find((s) => bedDeviceId(s.side) === deviceId);
}

/** Presence entities across configured sides — the Sleep sense inputs. */
export function bedPresenceEntities(): string[] {
  return bedSides()
    .map((s) => s.presenceEntity)
    .filter((e): e is string => !!e);
}

export interface BedCall {
  domain: string;
  service: string;
  data: Record<string, unknown>;
}

/** Pure (side, intent) -> service call, so tests pin the exact wire shape. */
export function bedCallFor(
  s: BedSide,
  intent: { kind: "on" } | { kind: "off" } | { kind: "level"; level: number } | { kind: "away"; away: boolean },
): BedCall {
  const target = { entity_id: s.targetEntity };
  switch (intent.kind) {
    case "on":
      return { domain: EIGHT_DOMAIN, service: SVC_SIDE_ON, data: target };
    case "off":
      return { domain: EIGHT_DOMAIN, service: SVC_SIDE_OFF, data: target };
    case "level": {
      const level = Math.round(intent.level);
      if (level < -100 || level > 100) throw new Error("bed warmth must be -100..100");
      // sleep_stage "current" = change what the bed is doing right now,
      // not the stored bedtime/early/late profile levels.
      return {
        domain: EIGHT_DOMAIN,
        service: SVC_HEAT_SET,
        data: { ...target, target: level, sleep_stage: "current" },
      };
    }
    case "away":
      return {
        domain: EIGHT_DOMAIN,
        service: intent.away ? SVC_AWAY_START : SVC_AWAY_STOP,
        data: target,
      };
  }
}

export async function bedSideOn(s: BedSide): Promise<void> {
  const c = bedCallFor(s, { kind: "on" });
  await callService(c.domain, c.service, c.data);
}

export async function bedSideOff(s: BedSide): Promise<void> {
  const c = bedCallFor(s, { kind: "off" });
  await callService(c.domain, c.service, c.data);
}

export async function bedSetLevel(s: BedSide, level: number): Promise<void> {
  const c = bedCallFor(s, { kind: "level", level });
  await callService(c.domain, c.service, c.data);
}

/**
 * Flip Eight Sleep's own away mode on every configured side — called from
 * the house Away mode switch. Best-effort by design: a cloud hiccup must
 * never block the house flag, so failures are returned, not thrown.
 */
export async function bedSetAwayAll(away: boolean): Promise<{ failures: string[] }> {
  const failures: string[] = [];
  for (const s of bedSides()) {
    try {
      const c = bedCallFor(s, { kind: "away", away });
      await callService(c.domain, c.service, c.data);
    } catch (err) {
      failures.push(`${s.side}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { failures };
}
