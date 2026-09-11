/**
 * Jewish holidays as the schedule sees them, client-safe (no Node imports).
 *
 * The house keeps Shabbat, and its Friday/Saturday automations (lights on
 * at sunset, the sauna and gym on Saturday, the "Shabbat is over" offs)
 * are exactly what a Yom Tov needs on whatever weekday it falls. Rather
 * than copying automations onto holiday dates, the scheduler substitutes
 * the WEEKDAY: on a holy day it reports Saturday, on the day before it
 * reports Friday, and every `days`-restricted step follows without being
 * touched. Ordinary weeks reproduce the civil weekdays exactly.
 *
 * Holy days = every Saturday + the Israeli Yom Tov days (one day each,
 * the Israel calendar — no second day of the diaspora) + any date the
 * owner adds by hand. Chol ha-moed, Purim, Chanukah and fast days are
 * ordinary days. Dates come from the runtime's own Hebrew calendar
 * (Intl, full ICU in Node) — no library, no network, deterministic.
 */

export interface YomTov {
  date: string; // YYYY-MM-DD, civil date of the daytime
  name: string;
}

/** Israel's Yom Tov days, keyed "<Intl month name> <day>". */
const YOM_TOV: Record<string, string> = {
  "Tishri 1": "Rosh Hashanah I",
  "Tishri 2": "Rosh Hashanah II",
  "Tishri 10": "Yom Kippur",
  "Tishri 15": "Sukkot",
  "Tishri 22": "Shemini Atzeret",
  "Nisan 15": "Pesach",
  "Nisan 21": "Seventh day of Pesach",
  "Sivan 6": "Shavuot",
};

let hebrewFmt: Intl.DateTimeFormat | null = null;

/** Hebrew calendar date of a civil date (its daytime — the civil day boundary, not nightfall). */
export function hebrewDate(date: string): { day: number; month: string; year: number } {
  hebrewFmt ??= new Intl.DateTimeFormat("en-u-ca-hebrew", {
    timeZone: "UTC", day: "numeric", month: "long", year: "numeric",
  });
  // Date-only strings parse as UTC midnight; noon keeps clear of any edge.
  const parts = hebrewFmt.formatToParts(new Date(Date.parse(date) + 12 * 3_600_000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: Number(get("day")), month: get("month"), year: Number(get("year")) };
}

/** The Yom Tov on this civil date, if any. */
export function yomTovOn(date: string): YomTov | null {
  const h = hebrewDate(date);
  const name = YOM_TOV[`${h.month} ${h.day}`];
  return name ? { date, name } : null;
}

/**
 * YYYY-MM-DD plus n days (exact: date-only strings are UTC midnight).
 * Throws on an unparseable string; a nonexistent day (2026-02-30) is
 * normalized, so `addDays(d, 0) === d` doubles as an existence check.
 */
export function addDays(date: string, n: number): string {
  const t = Date.parse(date);
  if (Number.isNaN(t)) throw new Error(`not a date: ${date}`);
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

/** Civil weekday (0=Sunday) of a YYYY-MM-DD date. */
export function weekdayOf(date: string): number {
  return new Date(Date.parse(date)).getUTCDay();
}

/** Yom Tov days in [from, from + days), oldest first. */
export function upcomingYomTov(from: string, days = 366): YomTov[] {
  const out: YomTov[] = [];
  for (let i = 0; i < days; i++) {
    const yt = yomTovOn(addDays(from, i));
    if (yt) out.push(yt);
  }
  return out;
}

/**
 * On a holy day that runs straight into another (Rosh Hashanah's two days,
 * a Shabbat into a Sunday Yom Tov, a Friday Yom Tov into Shabbat) the
 * evening belongs to the NEXT holy day: the Friday-listed "lights on at
 * sunset" must fire and the Saturday-listed "Shabbat is over, lights off"
 * must not. The weekday flips to Friday this many minutes before sunset,
 * early enough to catch candle-lighting-time steps.
 */
export const EVE_LEAD_MINUTES = 60;

/**
 * When today's sunset is unknown (HA unreachable) the flip assumes this
 * sunset. Deliberately EARLY — earlier than any Israeli sunset (~16:35 in
 * December): flipping early costs a late-afternoon Saturday step; flipping
 * late fires "Shabbat is over" offs into a Yom Tov night nobody can undo
 * by hand.
 */
export const FALLBACK_SUNSET_MINUTES = 16 * 60 + 30;

export interface DayRoleInput {
  date: string; // YYYY-MM-DD, house clock
  day: number; // civil weekday, 0=Sunday
  minutes: number; // minutes since midnight, house clock
  /** Is this date a Yom Tov (enabled) or an owner-added holy date? Saturdays are handled here. */
  isHoly: (date: string) => boolean;
  /** Today's sunset, minutes since midnight on the house clock; null = unknown. */
  sunsetMinutes?: number | null;
}

/**
 * The weekday the schedule should behave as, right now.
 *
 * - Holy day: Saturday — except from EVE_LEAD before sunset when tomorrow
 *   is holy too, when it is already Friday evening.
 * - Ordinary day before a holy day: Friday, all day (erev chag is erev
 *   Shabbat: the same preparations, the same evening).
 * - Anything else: the civil weekday.
 *
 * With every Saturday counted holy, a plain week maps to itself: Friday
 * precedes a holy day → Friday; Saturday is holy and Sunday is not →
 * Saturday.
 */
export function effectiveDay(input: DayRoleInput): number {
  const holy = (date: string) => weekdayOf(date) === 6 || input.isHoly(date);
  const today = holy(input.date);
  const tomorrow = holy(addDays(input.date, 1));
  if (today) {
    if (!tomorrow) return 6;
    const flipAt = (input.sunsetMinutes ?? FALLBACK_SUNSET_MINUTES) - EVE_LEAD_MINUTES;
    return input.minutes >= flipAt ? 5 : 6;
  }
  return tomorrow ? 5 : input.day;
}

/**
 * A resolver for the next-fire hints: the effective weekday `dayOffset`
 * days from `now` at `minutes`, using one sunset time for every day
 * (sunset drifts a minute or two per day — fine for a hint; the scheduler
 * uses the real instant).
 */
export function dayRoleResolver(
  now: { date: string; day: number },
  isHoly: (date: string) => boolean,
  sunsetMinutes: number | null,
): (dayOffset: number, minutes: number) => number {
  return (dayOffset, minutes) =>
    effectiveDay({
      date: addDays(now.date, dayOffset), day: (now.day + dayOffset) % 7, minutes, isHoly, sunsetMinutes,
    });
}

/** Human label for a substituted day: "runs as Saturday". */
export function roleLabel(effective: number, civil: number): string | null {
  if (effective === civil) return null;
  return effective === 6 ? "runs as Saturday" : effective === 5 ? "runs as Friday" : null;
}
