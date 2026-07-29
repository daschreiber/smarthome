/**
 * The house wall clock, client-safe (no Node imports): one place that turns
 * an instant into local time parts in the app's timezone. Both the
 * scheduler's due-check (lib/automations.ts) and the browser's next-fire
 * hints (lib/nextfire.ts) read the clock through this, so their notions of
 * "now" cannot drift apart.
 */

export interface WallClock {
  hhmm: string; // "HH:MM", 24h
  minutes: number; // minutes since midnight
  day: number; // 0=Sunday
  date: string; // YYYY-MM-DD
}

export const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function wallClock(d = new Date(), tz?: string): WallClock {
  const timeZone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // en-GB can render midnight as "24:00"; normalize.
  const hour = get("hour") === "24" ? "00" : get("hour");
  const minute = get("minute");
  return {
    hhmm: `${hour}:${minute}`,
    minutes: Number(hour) * 60 + Number(minute),
    day: DAYS_SHORT.indexOf(get("weekday")),
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}
