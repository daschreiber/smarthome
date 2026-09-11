/**
 * Client-safe "when does this fire next" math for the Automations screen.
 * Mirrors the scheduler's matching rules (lib/automations.ts) without
 * importing that module — it reads the store from disk and can't ship to
 * the browser. The wall clock itself is shared (lib/houseclock.ts).
 */
import { DAYS_SHORT, wallClock } from "./houseclock";

export interface StepTiming {
  time?: string; // HH:MM (absent for sun-triggered steps)
  sun?: "sunset" | "sunrise";
  sunOffsetMinutes?: number;
  days?: number[]; // 0=Sunday; empty/absent = every day
  date?: string; // YYYY-MM-DD one-shot
  lastFired?: string;
}

/** Next upcoming sun event instants (ISO), as served by /api/automations. */
export interface NextSunIso { sunrise: string | null; sunset: string | null }

export interface HouseNow {
  minutes: number; // minutes since midnight on the house wall clock
  day: number; // 0=Sunday
  date: string; // YYYY-MM-DD
}

export function houseNow(tz?: string, d = new Date()): HouseNow {
  const { minutes, day, date } = wallClock(d, tz);
  return { minutes, day, date };
}

export interface NextFire {
  dayOffset: number;
  time: string;
  date?: string; // set for one-shot steps
}

function toMinutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/**
 * Resolve a sun-triggered step to a concrete HH:MM for next-fire display,
 * using the next event instant plus the step's offset. Later occurrences
 * (weekday-restricted steps) reuse the same clock time — sunset drifts a
 * minute or two per day, fine for a hint; the scheduler fires on the real
 * instant. Returns null when the sun times are unknown.
 */
export function resolveStepTime(step: StepTiming, sun: NextSunIso | null, tz?: string): StepTiming | null {
  if (!step.sun) return step;
  const iso = sun?.[step.sun];
  if (!iso) return null;
  const at = Date.parse(iso) + (step.sunOffsetMinutes ?? 0) * 60_000;
  const p = houseNow(tz, new Date(at));
  const hhmm = `${String(Math.floor(p.minutes / 60)).padStart(2, "0")}:${String(p.minutes % 60).padStart(2, "0")}`;
  return { ...step, sun: undefined, time: hhmm };
}

/**
 * The weekday to match `dayOffset` days from now at `minutes` — defaults to
 * the civil weekday; the Automations screen passes lib/yomtov's resolver so
 * the hints follow the same holiday substitution the scheduler applies.
 */
export type DayAt = (dayOffset: number, minutes: number) => number;

export function nextStepFire(step: StepTiming, now: HouseNow, dayAt?: DayAt): NextFire | null {
  if (!step.time) return null; // unresolved sun step — no concrete hint
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
  // A plain week repeats within 7 days; with holiday substitution a
  // weekday can be borrowed for a while (Tishrei: two holy days, then Yom
  // Kippur's eve, all inside three weeks), so look further ahead.
  const horizon = dayAt ? 28 : 7;
  for (let dayOffset = 0; dayOffset <= horizon; dayOffset++) {
    const day = dayAt ? dayAt(dayOffset, t) : (now.day + dayOffset) % 7;
    if (step.days && step.days.length > 0 && !step.days.includes(day)) continue;
    if (dayOffset === 0 && t <= now.minutes) continue;
    return { dayOffset, time: step.time };
  }
  return null;
}

/** Soonest upcoming fire across an automation's steps, or null if none. */
export function nextAutomationFire(steps: StepTiming[], now: HouseNow, dayAt?: DayAt): NextFire | null {
  let best: NextFire | null = null;
  for (const s of steps) {
    const nf = nextStepFire(s, now, dayAt);
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
  const weekday = DAYS_SHORT[(now.day + nf.dayOffset) % 7];
  // Beyond a week a bare weekday is ambiguous (a weekly step displaced by
  // holidays): say which one.
  if (nf.dayOffset > 7) {
    const d = new Date(Date.parse(now.date) + nf.dayOffset * 86_400_000);
    return `${weekday} ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${nf.time}`;
  }
  return `${weekday} ${nf.time}`;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
