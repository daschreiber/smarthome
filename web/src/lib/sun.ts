import { getStates } from "./ha";
import type { SunEvents } from "./automations";

/**
 * Sunset/sunrise times come from Home Assistant's sun.sun entity
 * (next_setting / next_rising, computed from the home's coordinates) —
 * no astronomy code here. Instants are cached in-process:
 *
 * - A short fetch TTL keeps the scheduler from polling HA every tick.
 * - Recently seen instants are RETAINED after they pass, because once an
 *   event occurs HA's next_* flips to tomorrow while "+30 min after
 *   sunset" steps still need today's instant. A restart inside that
 *   window loses the retained instant — same class as the documented
 *   "missed firings are skipped".
 */

const FETCH_TTL_MS = 5 * 60_000;
const KEEP = 4;

let fetchedAt = 0;
const seen: SunEvents = { sunrise: [], sunset: [] };

function remember(arr: number[], v: unknown): void {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(t) || arr.includes(t)) return;
  arr.push(t);
  arr.sort((a, b) => a - b);
  while (arr.length > KEEP) arr.shift();
}

/** Known sun event instants (epoch ms), refreshed from HA at most once per TTL. */
export async function sunEvents(): Promise<SunEvents> {
  if (Date.now() - fetchedAt > FETCH_TTL_MS) {
    try {
      const sun = (await getStates()).find((s) => s.entity_id === "sun.sun");
      if (sun) {
        remember(seen.sunrise, sun.attributes.next_rising);
        remember(seen.sunset, sun.attributes.next_setting);
        fetchedAt = Date.now();
      }
    } catch (err) {
      // Keep whatever we already know; a sun step simply won't fire if we
      // never learned its instant (documented skip semantics).
      console.error("[sun] refresh failed:", err instanceof Error ? err.message : err);
    }
  }
  return seen;
}

/** Next upcoming event instants as ISO strings, for the UI's next-fire hints. */
export async function nextSun(): Promise<{ sunrise: string | null; sunset: string | null }> {
  const events = await sunEvents();
  const next = (arr: number[]) => {
    const t = arr.find((v) => v > Date.now());
    return t ? new Date(t).toISOString() : null;
  };
  return { sunrise: next(events.sunrise), sunset: next(events.sunset) };
}
