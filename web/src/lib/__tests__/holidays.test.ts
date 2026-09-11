import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  HOLY_DATES_AHEAD_DAYS, effectiveDayNow, holidayRows, holyDatesAhead, isHolyDate, loadHolidays,
  needsSunsetToday, setHolyDate, sunsetMinutesOn,
} from "../holidays";
import { createAutomation, dueSteps, type Automation } from "../automations";

/**
 * The holiday store: every Israeli Yom Tov follows Shabbat by default, an
 * individual one can be switched off, a date can be added by hand, and
 * past entries fall away. The scheduler-facing helpers turn that into the
 * weekday substitution the due-check sees.
 */

const TODAY = "2026-09-10"; // Thursday before Rosh Hashanah 5787

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "holidays-test-"));
  process.env.HOLIDAYS_PATH = path.join(dir, "holidays.json");
  process.env.AUTOMATIONS_PATH = path.join(dir, "automations.json");
  process.env.APP_TZ = "Asia/Jerusalem";
});

describe("holiday state", () => {
  it("defaults to every Yom Tov on except Yom Kippur, nothing added", () => {
    expect(loadHolidays(TODAY)).toEqual({ skipped: [], manual: [] });
    expect(isHolyDate("2026-09-13", loadHolidays(TODAY))).toBe(true);
    expect(isHolyDate("2026-09-14", loadHolidays(TODAY))).toBe(false);
    expect(isHolyDate("2026-09-21", loadHolidays(TODAY))).toBe(false); // Yom Kippur: the sauna stays quiet
    expect(holidayRows(TODAY).find((r) => r.date === "2026-09-21")).toMatchObject({ name: "Yom Kippur", enabled: false, manual: false });
  });

  it("switches a Yom Tov off and back on", () => {
    setHolyDate("2026-09-13", false, TODAY); // Rosh Hashanah II (Sukkot falls on a Saturday this year)
    expect(loadHolidays(TODAY).skipped).toEqual(["2026-09-13"]);
    expect(isHolyDate("2026-09-13", loadHolidays(TODAY))).toBe(false);
    expect(holidayRows(TODAY).find((r) => r.date === "2026-09-13")).toMatchObject({ name: "Rosh Hashanah II", enabled: false });
    setHolyDate("2026-09-13", true, TODAY);
    expect(loadHolidays(TODAY).skipped).toEqual([]);
  });

  it("switches Yom Kippur on and back off, keeping its name on the card", () => {
    setHolyDate("2026-09-21", true, TODAY);
    expect(loadHolidays(TODAY)).toEqual({ skipped: [], manual: ["2026-09-21"] });
    expect(isHolyDate("2026-09-21", loadHolidays(TODAY))).toBe(true);
    expect(holidayRows(TODAY).find((r) => r.date === "2026-09-21")).toMatchObject({ name: "Yom Kippur", enabled: true, manual: false });
    expect(holidayRows(TODAY).filter((r) => r.date === "2026-09-21")).toHaveLength(1);
    setHolyDate("2026-09-21", false, TODAY);
    expect(loadHolidays(TODAY)).toEqual({ skipped: [], manual: [] });
  });

  it("adds and removes a date by hand, listed among the calendar rows", () => {
    setHolyDate("2026-10-14", true, TODAY); // a Wednesday
    expect(isHolyDate("2026-10-14", loadHolidays(TODAY))).toBe(true);
    const rows = holidayRows(TODAY);
    const i = rows.findIndex((r) => r.date === "2026-10-14");
    expect(rows[i]).toMatchObject({ name: "Added by hand", enabled: true, manual: true });
    expect(rows[i - 1].date).toBe("2026-10-03"); // Shemini Atzeret keeps date order
    setHolyDate("2026-10-14", false, TODAY);
    expect(holidayRows(TODAY).some((r) => r.date === "2026-10-14")).toBe(false);
  });

  it("refuses Saturdays, past dates and malformed dates", () => {
    expect(() => setHolyDate("2026-09-19", true, TODAY)).toThrow(/Saturday/);
    expect(() => setHolyDate("2026-09-09", true, TODAY)).toThrow(/passed/);
    expect(() => setHolyDate("14/10/2026", true, TODAY)).toThrow(/YYYY-MM-DD/);
    expect(() => setHolyDate("2026-13-40", true, TODAY)).toThrow(/YYYY-MM-DD/);
    // Syntactically fine, but no such day: Date.parse would quietly make it 2 March.
    expect(() => setHolyDate("2026-02-30", true, TODAY)).toThrow(/real/);
    expect(() => setHolyDate("2026-11-31", true, TODAY)).toThrow(/real/);
    expect(loadHolidays(TODAY).manual).toEqual([]);
  });

  it("prunes past entries and ignores junk on load", () => {
    fs.writeFileSync(
      process.env.HOLIDAYS_PATH!,
      JSON.stringify({ skipped: ["2025-10-02", "2026-09-21", 7], manual: ["2026-01-01", "2026-10-14", "nope"] }),
    );
    expect(loadHolidays(TODAY)).toEqual({ skipped: ["2026-09-21"], manual: ["2026-10-14"] });
  });

  it("treats a corrupt file as defaults — a broken file must not strand the holidays", () => {
    fs.writeFileSync(process.env.HOLIDAYS_PATH!, "not json");
    expect(loadHolidays(TODAY)).toEqual({ skipped: [], manual: [] });
  });

  it("lists the holy dates within reach of the hints", () => {
    expect(holyDatesAhead(TODAY, 14)).toEqual(["2026-09-12", "2026-09-13"]);
    setHolyDate("2026-09-13", false, TODAY);
    setHolyDate("2026-09-21", true, TODAY);
    expect(holyDatesAhead(TODAY, 14)).toEqual(["2026-09-12", "2026-09-21"]);
  });

  it("serves past the hints' 28-day scan plus its one-day lookahead", () => {
    expect(HOLY_DATES_AHEAD_DAYS).toBeGreaterThanOrEqual(30);
    // From 10 Sep the default window must still see Shemini Atzeret on 3 Oct
    // (day 23) and Sukkot on 26 Sep — everything a 28-day scan can land on.
    expect(holyDatesAhead(TODAY)).toEqual(["2026-09-12", "2026-09-13", "2026-09-26", "2026-10-03"]);
  });
});

describe("scheduler helpers", () => {
  it("needs today's sunset only on a holy day that leads into another", () => {
    expect(needsSunsetToday("2026-09-11")).toBe(false); // Friday
    expect(needsSunsetToday("2026-09-12")).toBe(true); // Shabbat → Rosh Hashanah II
    expect(needsSunsetToday("2026-09-13")).toBe(false);
    expect(needsSunsetToday("2026-09-19")).toBe(false); // an ordinary Shabbat
    expect(needsSunsetToday("2027-06-11")).toBe(true); // Shavuot (Fri) → Shabbat
  });

  it("reads today's sunset off HA's known instants on the house clock", () => {
    const sun = { sunrise: [], sunset: [Date.parse("2026-09-11T15:41:00Z"), Date.parse("2026-09-12T15:40:00Z")] };
    expect(sunsetMinutesOn("2026-09-12", sun)).toBe(18 * 60 + 40);
    expect(sunsetMinutesOn("2026-09-13", sun)).toBeNull();
    expect(sunsetMinutesOn("2026-09-12", undefined)).toBeNull();
  });

  it("substitutes the weekday the scheduler matches on", () => {
    const sun = { sunrise: [], sunset: [Date.parse("2026-09-12T15:40:00Z")] };
    // Sunday 13 Sep, 09:00 — Rosh Hashanah II runs as Saturday.
    expect(effectiveDayNow({ hhmm: "09:00", day: 0, date: "2026-09-13" }, undefined)).toBe(6);
    // Shabbat 12 Sep: Saturday at noon, Friday from 17:40 (sunset 18:40 − 60).
    expect(effectiveDayNow({ hhmm: "12:00", day: 6, date: "2026-09-12" }, sun)).toBe(6);
    expect(effectiveDayNow({ hhmm: "17:40", day: 6, date: "2026-09-12" }, sun)).toBe(5);
    // Switched off, the day is itself again.
    setHolyDate("2026-09-13", false, "2026-09-10");
    expect(effectiveDayNow({ hhmm: "09:00", day: 0, date: "2026-09-13" }, undefined)).toBe(0);
  });

  it("end to end: Saturday-only and Friday-only steps fire on the holiday, Sunday-only ones do not", () => {
    createAutomation({ name: "Gym lights on", steps: [{ time: "09:00", days: [6], actions: [{ type: "room", room: "Gym", command: "lights_on" }] }] }, "t");
    createAutomation({ name: "Lights at sunset", steps: [{ time: "18:30", days: [5], actions: [{ type: "room", room: "Hall", command: "lights_on" }] }] }, "t");
    createAutomation({ name: "Shabbat over", steps: [{ time: "20:30", days: [6], actions: [{ type: "room", room: "Hall", command: "lights_off" }] }] }, "t");
    createAutomation({ name: "Sunday vacuum", steps: [{ time: "09:00", days: [0], actions: [{ type: "room", room: "Hall", command: "lights_off" }] }] }, "t");
    const names = (now: { hhmm: string; day: number; date: string }, sun?: { sunrise: number[]; sunset: number[] }) => {
      const items = JSON.parse(fs.readFileSync(process.env.AUTOMATIONS_PATH!, "utf8")) as Automation[];
      return dueSteps(items, { ...now, day: effectiveDayNow(now, sun) }, sun).map((d) => d.automation.name);
    };
    const sun = { sunrise: [], sunset: [Date.parse("2026-09-12T15:40:00Z")] };
    // Sunday 13 Sep (Rosh Hashanah II): Saturday's programme, not Sunday's.
    expect(names({ hhmm: "09:00", day: 0, date: "2026-09-13" })).toEqual(["Gym lights on"]);
    expect(names({ hhmm: "20:30", day: 0, date: "2026-09-13" })).toEqual(["Shabbat over"]);
    // Shabbat 12 Sep evening: Friday's lights come on; "Shabbat over" stays quiet.
    expect(names({ hhmm: "18:30", day: 6, date: "2026-09-12" }, sun)).toEqual(["Lights at sunset"]);
    expect(names({ hhmm: "20:30", day: 6, date: "2026-09-12" }, sun)).toEqual([]);
    // Yom Kippur is off by default, so its eve (Sun 20 Sep) is an ordinary Sunday.
    expect(names({ hhmm: "09:00", day: 0, date: "2026-09-20" })).toEqual(["Sunday vacuum"]);
    setHolyDate("2026-09-21", true, "2026-09-10");
    expect(names({ hhmm: "09:00", day: 0, date: "2026-09-20" })).toEqual([]); // now it runs as Friday
  });
});
