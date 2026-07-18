/**
 * Client-safe "when does this fire next" math for the Automations screen.
 * Mirrors the scheduler's matching rules (lib/automations.ts) without
 * importing that module — it reads the store from disk and can't ship to
 * the browser.
 */

export interface StepTiming {
  time: string; // HH:MM
  days?: number[]; // 0=Sunday; empty/absent = every day
  date?: string; // YYYY-MM-DD one-shot
  lastFired?: string;
}

export interface HouseNow {
  minutes: number; // minutes since midnight on the house wall clock
  day: number; // 0=Sunday
  date: string; // YYYY-MM-DD
}

const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function houseNow(tz?: string, d = new Date()): HouseNow {
  const timeZone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // en-GB can render midnight as "24:00"; normalize.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    minutes: Number(hour) * 60 + Number(get("minute")),
    day: DAYS_SHORT.indexOf(get("weekday")),
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

export interface NextFire {
  dayOffset: number;
  time: string;
  date?: string; // set for one-shot steps
}

function toMinutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

export function nextStepFire(step: StepTiming, now: HouseNow): NextFire | null {
  const t = toMinutes(step.time);
  if (step.date) {
    if (step.lastFired || step.date < now.date) return null;
    if (step.date === now.date) {
      return t > now.minutes ? { dayOffset: 0, time: step.time, date: step.date } : null;
    }
    // Both are date-only strings, so Date.parse lands on UTC midnight and the
    // difference is an exact whole number of days.
    const dayOffset = Math.round((Date.parse(step.date) - Date.parse(now.date)) / 86_400_000);
    return { dayOffset, time: step.time, date: step.date };
  }
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const day = (now.day + dayOffset) % 7;
    if (step.days && step.days.length > 0 && !step.days.includes(day)) continue;
    if (dayOffset === 0 && t <= now.minutes) continue;
    return { dayOffset, time: step.time };
  }
  return null;
}

/** Soonest upcoming fire across an automation's steps, or null if none. */
export function nextAutomationFire(steps: StepTiming[], now: HouseNow): NextFire | null {
  let best: NextFire | null = null;
  for (const s of steps) {
    const nf = nextStepFire(s, now);
    if (!nf) continue;
    if (
      !best ||
      nf.dayOffset < best.dayOffset ||
      (nf.dayOffset === best.dayOffset && toMinutes(nf.time) < toMinutes(best.time))
    ) {
      best = nf;
    }
  }
  return best;
}

/** Sortable key: sooner fires first. */
export function fireSortKey(nf: NextFire): number {
  return nf.dayOffset * 1440 + toMinutes(nf.time);
}

export function nextFireLabel(nf: NextFire, now: HouseNow): string {
  if (nf.dayOffset === 0) return `today ${nf.time}`;
  if (nf.dayOffset === 1) return `tomorrow ${nf.time}`;
  if (nf.date && nf.dayOffset > 6) return `${nf.date} ${nf.time}`;
  return `${DAYS_SHORT[(now.day + nf.dayOffset) % 7]} ${nf.time}`;
}
