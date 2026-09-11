import { describe, expect, it } from "vitest";
import {
  EVE_LEAD_MINUTES, FALLBACK_SUNSET_MINUTES, addDays, dayRoleResolver, effectiveDay, hebrewDate,
  roleLabel, upcomingYomTov, weekdayOf, yomTovOn,
} from "../yomtov";

/**
 * Holidays follow Shabbat by weekday substitution: a holy day reports
 * Saturday, the day before it Friday, and an ordinary week maps to itself.
 * The calendar is Israel's (one-day chagim), read from Intl's Hebrew
 * calendar — these dates are checked against a printed luach for 5787.
 */

describe("Hebrew calendar", () => {
  it("reads a civil date as its daytime Hebrew date", () => {
    expect(hebrewDate("2026-09-13")).toEqual({ day: 2, month: "Tishri", year: 5787 });
    expect(hebrewDate("2027-04-22")).toEqual({ day: 15, month: "Nisan", year: 5787 });
  });

  it("names the Israeli Yom Tov days of 5787 and nothing else", () => {
    expect(upcomingYomTov("2026-09-01", 380).map((y) => `${y.date} ${y.name}`)).toEqual([
      "2026-09-12 Rosh Hashanah I",
      "2026-09-13 Rosh Hashanah II",
      "2026-09-21 Yom Kippur",
      "2026-09-26 Sukkot",
      "2026-10-03 Shemini Atzeret",
      "2027-04-22 Pesach",
      "2027-04-28 Seventh day of Pesach",
      "2027-06-11 Shavuot",
    ]);
  });

  it("treats chol ha-moed, Purim and Chanukah as ordinary days", () => {
    expect(yomTovOn("2026-09-28")).toBeNull(); // chol ha-moed Sukkot
    expect(yomTovOn("2027-03-23")).toBeNull(); // Purim
    expect(yomTovOn("2026-12-05")).toBeNull(); // Chanukah
  });

  it("date arithmetic is exact across month ends", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(weekdayOf("2026-09-13")).toBe(0);
    expect(weekdayOf("2026-09-12")).toBe(6);
  });
});

const never = () => false;
const yomTov = (d: string) => yomTovOn(d) !== null;
const SUNSET = 18 * 60 + 40; // 18:40 — mid-September in Jerusalem

describe("effectiveDay — an ordinary week is itself", () => {
  it("maps every civil weekday to itself at every hour", () => {
    // Week of 2026-08-30 (Sun) … 2026-09-05 (Sat): no holidays.
    for (let i = 0; i < 7; i++) {
      const date = addDays("2026-08-30", i);
      for (const minutes of [0, 9 * 60, SUNSET - 90, SUNSET, 23 * 60]) {
        expect(effectiveDay({ date, day: i, minutes, isHoly: yomTov, sunsetMinutes: SUNSET })).toBe(i);
      }
    }
  });
});

describe("effectiveDay — Rosh Hashanah 5787 (Sat 12 + Sun 13 Sep 2026)", () => {
  const at = (date: string, minutes: number) =>
    effectiveDay({ date, day: weekdayOf(date), minutes, isHoly: yomTov, sunsetMinutes: SUNSET });

  it("Friday stays Friday: it already precedes a holy day", () => {
    expect(at("2026-09-11", 10 * 60)).toBe(5);
    expect(at("2026-09-11", SUNSET)).toBe(5);
  });

  it("Shabbat is Saturday by day, then Friday evening into the second day", () => {
    expect(at("2026-09-12", 9 * 60)).toBe(6);
    expect(at("2026-09-12", SUNSET - EVE_LEAD_MINUTES - 1)).toBe(6);
    expect(at("2026-09-12", SUNSET - EVE_LEAD_MINUTES)).toBe(5);
    expect(at("2026-09-12", SUNSET + 30)).toBe(5); // "Shabbat is over" steps must not fire
    expect(at("2026-09-12", 23 * 60 + 59)).toBe(5);
  });

  it("Sunday runs as Saturday all day, including the evening", () => {
    expect(at("2026-09-13", 9 * 60)).toBe(6);
    expect(at("2026-09-13", SUNSET + 45)).toBe(6); // the post-holiday offs replay here
    expect(at("2026-09-13", 23 * 60)).toBe(6);
  });

  it("Monday is an ordinary Monday", () => {
    expect(at("2026-09-14", 9 * 60)).toBe(1);
  });
});

describe("effectiveDay — other shapes", () => {
  const at = (date: string, minutes: number) =>
    effectiveDay({ date, day: weekdayOf(date), minutes, isHoly: yomTov, sunsetMinutes: SUNSET });

  it("a weekday Yom Tov: the day before is Friday, the day is Saturday (Yom Kippur, Mon 21 Sep)", () => {
    expect(at("2026-09-20", 9 * 60)).toBe(5); // Sunday runs as Friday
    expect(at("2026-09-20", SUNSET + 10)).toBe(5);
    expect(at("2026-09-21", 12 * 60)).toBe(6);
    expect(at("2026-09-21", SUNSET + 45)).toBe(6);
    expect(at("2026-09-22", 9 * 60)).toBe(2);
  });

  it("a Friday Yom Tov flows into Shabbat (Shavuot, Fri 11 Jun 2027)", () => {
    expect(at("2027-06-10", 12 * 60)).toBe(5); // Thursday runs as Friday
    expect(at("2027-06-11", 12 * 60)).toBe(6); // Friday runs as Saturday by day
    expect(at("2027-06-11", SUNSET)).toBe(5); // … then Friday evening into Shabbat
    expect(at("2027-06-12", 12 * 60)).toBe(6);
    expect(at("2027-06-12", SUNSET + 45)).toBe(6);
  });

  it("a Saturday Yom Tov is just a Saturday (Sukkot, Sat 26 Sep)", () => {
    expect(at("2026-09-25", 12 * 60)).toBe(5);
    expect(at("2026-09-26", 12 * 60)).toBe(6);
    expect(at("2026-09-26", SUNSET + 45)).toBe(6);
    expect(at("2026-09-27", 12 * 60)).toBe(0);
  });

  it("a disabled holiday is an ordinary day again", () => {
    const skipYomKippur = (d: string) => d !== "2026-09-21" && yomTov(d);
    expect(effectiveDay({ date: "2026-09-20", day: 0, minutes: 600, isHoly: skipYomKippur, sunsetMinutes: SUNSET })).toBe(0);
    expect(effectiveDay({ date: "2026-09-21", day: 1, minutes: 600, isHoly: skipYomKippur, sunsetMinutes: SUNSET })).toBe(1);
  });

  it("an owner-added date behaves like a Yom Tov", () => {
    const manual = (d: string) => d === "2026-10-14"; // a Wednesday
    expect(effectiveDay({ date: "2026-10-13", day: 2, minutes: 600, isHoly: manual, sunsetMinutes: SUNSET })).toBe(5);
    expect(effectiveDay({ date: "2026-10-14", day: 3, minutes: 600, isHoly: manual, sunsetMinutes: SUNSET })).toBe(6);
  });

  it("with no sunset known, the double-day flip assumes an early sunset (the safe error)", () => {
    const flip = FALLBACK_SUNSET_MINUTES - EVE_LEAD_MINUTES;
    expect(effectiveDay({ date: "2026-09-12", day: 6, minutes: flip - 1, isHoly: yomTov })).toBe(6);
    expect(effectiveDay({ date: "2026-09-12", day: 6, minutes: flip, isHoly: yomTov, sunsetMinutes: null })).toBe(5);
    expect(flip).toBeLessThan(16 * 60 + 35 - EVE_LEAD_MINUTES); // earlier than any Israeli sunset's flip
  });

  it("no holidays at all: Friday/Saturday still come from the calendar weekday", () => {
    expect(effectiveDay({ date: "2026-09-04", day: 5, minutes: 600, isHoly: never })).toBe(5);
    expect(effectiveDay({ date: "2026-09-05", day: 6, minutes: 600, isHoly: never })).toBe(6);
  });
});

describe("dayRoleResolver + roleLabel", () => {
  it("walks forward from now with the same rules", () => {
    const dayAt = dayRoleResolver({ date: "2026-09-10", day: 4 }, yomTov, SUNSET); // Thursday
    expect(dayAt(0, 600)).toBe(4);
    expect(dayAt(1, 600)).toBe(5);
    expect(dayAt(2, 600)).toBe(6);
    expect(dayAt(2, SUNSET)).toBe(5);
    expect(dayAt(3, 600)).toBe(6);
    expect(dayAt(4, 600)).toBe(1);
  });

  it("labels only a substituted day", () => {
    expect(roleLabel(6, 0)).toBe("runs as Saturday");
    expect(roleLabel(5, 6)).toBe("runs as Friday");
    expect(roleLabel(6, 6)).toBeNull();
    expect(roleLabel(2, 2)).toBeNull();
  });
});
