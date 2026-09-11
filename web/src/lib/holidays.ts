import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "./store";
import { addDays, effectiveDay, upcomingYomTov, weekdayOf, yomTovOn, type YomTov } from "./yomtov";
import type { SunEvents } from "./automations";
import { nowParts } from "./automations";

/**
 * Which holy days the schedule follows (see lib/yomtov.ts for the rules).
 * Every Israeli Yom Tov counts by default — the feature works without
 * attention. The owner can switch an individual holiday off (Yom Kippur,
 * say: the strictures match Shabbat but a sauna cycling during the fast
 * is odd) or add a date by hand for anything the calendar doesn't cover.
 * Past entries are pruned on load so the file never grows.
 */

export interface HolidayState {
  /** Yom Tov dates (YYYY-MM-DD) the owner switched off. */
  skipped: string[];
  /** Owner-added holy dates (YYYY-MM-DD). */
  manual: string[];
}

export interface HolidayRow extends YomTov {
  enabled: boolean;
  manual: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The state file: HOLIDAYS_PATH, else the Railway volume when it is
 *  mounted (a switched-off holiday must survive a deploy), else the
 *  working directory — the liftwatch pattern, no new env var to set. */
function storePath(): string {
  if (process.env.HOLIDAYS_PATH) return process.env.HOLIDAYS_PATH;
  if (fs.existsSync("/data")) return "/data/holidays.json";
  return path.join(process.cwd(), "holidays.json");
}

export function loadHolidays(today = nowParts().date): HolidayState {
  let raw: Partial<HolidayState>;
  try {
    raw = readJsonFile<Partial<HolidayState>>(storePath(), {});
  } catch (err) {
    // A broken file must not strand the holidays: fall back to "all on".
    console.error("[holidays] state unreadable, using defaults:", err instanceof Error ? err.message : err);
    raw = {};
  }
  const keep = (arr: unknown) =>
    (Array.isArray(arr) ? arr : []).filter((d): d is string => typeof d === "string" && DATE_RE.test(d) && d >= today);
  return { skipped: [...new Set(keep(raw.skipped))].sort(), manual: [...new Set(keep(raw.manual))].sort() };
}

function save(st: HolidayState): void {
  writeJsonFile(storePath(), st);
}

/** Is this date a holy day beyond Saturdays (an enabled Yom Tov, or owner-added)? */
export function isHolyDate(date: string, st = loadHolidays()): boolean {
  if (st.manual.includes(date)) return true;
  return yomTovOn(date) !== null && !st.skipped.includes(date);
}

/**
 * Follow (or stop following) a date as a holy day. A calendar Yom Tov is
 * toggled through the skipped list; any other date through the manual
 * list. Saturdays are refused: they are holy already.
 */
export function setHolyDate(date: string, enabled: boolean, today = nowParts().date): HolidayState {
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date))) throw new Error("date must be YYYY-MM-DD");
  if (date < today) throw new Error("that date has passed");
  if (weekdayOf(date) === 6) throw new Error("Saturday is a holy day already");
  const st = loadHolidays(today);
  const without = (arr: string[]) => arr.filter((d) => d !== date);
  if (yomTovOn(date)) {
    st.skipped = enabled ? without(st.skipped) : [...without(st.skipped), date].sort();
  } else {
    st.manual = enabled ? [...without(st.manual), date].sort() : without(st.manual);
  }
  save(st);
  return st;
}

/** The coming year's holidays with their switch state, plus owner-added dates, date order. */
export function holidayRows(today = nowParts().date, days = 366): HolidayRow[] {
  const st = loadHolidays(today);
  const rows: HolidayRow[] = upcomingYomTov(today, days).map((y) => ({
    ...y, enabled: !st.skipped.includes(y.date), manual: false,
  }));
  for (const date of st.manual) {
    if (!rows.some((r) => r.date === date)) rows.push({ date, name: "Added by hand", enabled: true, manual: true });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/** Holy dates (beyond Saturdays) in the next `days` days — what the UI's next-fire hints need. */
export function holyDatesAhead(today = nowParts().date, days = 14): string[] {
  const st = loadHolidays(today);
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(today, i);
    if (isHolyDate(d, st)) out.push(d);
  }
  return out;
}

/** Today's sunset as minutes on the house clock, from HA's known instants; null if unknown. */
export function sunsetMinutesOn(date: string, sun: SunEvents | undefined): number | null {
  for (const t of sun?.sunset ?? []) {
    const p = nowParts(new Date(t));
    if (p.date === date) return Number(p.hhmm.slice(0, 2)) * 60 + Number(p.hhmm.slice(3, 5));
  }
  return null;
}

/**
 * Does the schedule need today's sunset to decide the weekday? Only on a
 * holy day that runs into another — the scheduler consults HA's sun
 * entity on those days even when no sun-triggered step exists.
 */
export function needsSunsetToday(date: string, st = loadHolidays(date)): boolean {
  const holy = (d: string) => weekdayOf(d) === 6 || isHolyDate(d, st);
  return holy(date) && holy(addDays(date, 1));
}

/** The weekday the scheduler should behave as right now (see lib/yomtov.ts). */
export function effectiveDayNow(now: ReturnType<typeof nowParts>, sun: SunEvents | undefined): number {
  const st = loadHolidays(now.date);
  const minutes = Number(now.hhmm.slice(0, 2)) * 60 + Number(now.hhmm.slice(3, 5));
  return effectiveDay({
    date: now.date, day: now.day, minutes,
    isHoly: (d) => isHolyDate(d, st),
    sunsetMinutes: sunsetMinutesOn(now.date, sun),
  });
}
