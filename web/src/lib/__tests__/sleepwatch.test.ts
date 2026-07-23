import { describe, expect, it } from "vitest";
import {
  MAX_RETRIES, READING_LIGHTS, RETRY_WINDOW_MS, TV_LIFT_ENTITY,
  evaluateSleepwatch, inWindow, watchedLightEntities, type SleepwatchState,
} from "../sleepwatch";

/**
 * The sleep watcher's contract: between 22:00 and 08:00 a dark, TV-stowed
 * Master Bedroom starts the noise; 08:00 / a light stops it; reading lights
 * and the TV lift never stop it; manual off latches for the night, but a
 * stream that dies right after our own start is retried (the C4 goodnight
 * sweep). Shades are deliberately no condition — the C4 covers report
 * "open" forever (position feedback stuck ~1%), which is what kept the
 * watcher from ever arming on the first real night.
 */

const IDLE: SleepwatchState = { enabled: true, active: false, latched: false };
const NOW = 1_700_000_000_000;

/** All conditions met: watched lights off, lift stowed. Shades are absent
 *  on purpose — the watcher must not care what covers report. */
function bedtimeStates(overrides: Record<string, string> = {}): Map<string, { state: string }> {
  const m = new Map<string, { state: string }>();
  for (const id of watchedLightEntities()) m.set(id, { state: "off" });
  for (const id of READING_LIGHTS) m.set(id, { state: "off" });
  // The C4 covers' stuck-open reality, in every test by default:
  m.set("cover.master_bedroom_master_bedroom_balcony_left", { state: "open" });
  m.set("cover.master_bedroom_master_bedroom_balcony_right", { state: "open" });
  m.set("cover.master_bedroom_master_bedroom_window", { state: "open" });
  m.set(TV_LIFT_ENTITY, { state: "off" });
  for (const [id, state] of Object.entries(overrides)) m.set(id, { state });
  return m;
}

describe("entity derivation", () => {
  it("watches every real MBR light except the two reading lights", () => {
    const watched = watchedLightEntities();
    expect(watched.length).toBeGreaterThanOrEqual(5);
    for (const id of READING_LIGHTS) expect(watched).not.toContain(id);
    expect(watched).toContain("light.knx_dimmer_master_bedroom_lights");
    // The TV lift rides the light domain but is Utilities, not Lighting.
    expect(watched).not.toContain(TV_LIFT_ENTITY);
  });
});

describe("window", () => {
  it("crosses midnight: 22:00–08:00", () => {
    expect(inWindow("22:00")).toBe(true);
    expect(inWindow("23:59")).toBe(true);
    expect(inWindow("00:00")).toBe(true);
    expect(inWindow("07:59")).toBe(true);
    expect(inWindow("08:00")).toBe(false);
    expect(inWindow("12:00")).toBe(false);
    expect(inWindow("21:59")).toBe(false);
  });
});

describe("arming", () => {
  it("starts the noise when the room looks asleep after 22:00 — stuck-open covers and all", () => {
    const d = evaluateSleepwatch({ hhmm: "22:30", nowMs: NOW, states: bedtimeStates(), playing: false, st: IDLE });
    expect(d.action).toBe("start");
    expect(d.next).toMatchObject({ active: true, startedAtMs: NOW, retries: 0 });
  });

  it("a reading light on does not block arming", () => {
    const [reading] = [...READING_LIGHTS];
    const d = evaluateSleepwatch({
      hhmm: "23:00", nowMs: NOW, states: bedtimeStates({ [reading]: "on" }), playing: false, st: IDLE,
    });
    expect(d.action).toBe("start");
  });

  it("any other light on blocks arming", () => {
    const [light] = watchedLightEntities();
    const d = evaluateSleepwatch({
      hhmm: "23:00", nowMs: NOW, states: bedtimeStates({ [light]: "on" }), playing: false, st: IDLE,
    });
    expect(d.action).toBeNull();
  });

  it("TV lift not stowed blocks arming", () => {
    const d = evaluateSleepwatch({
      hhmm: "23:00", nowMs: NOW, states: bedtimeStates({ [TV_LIFT_ENTITY]: "on" }), playing: false, st: IDLE,
    });
    expect(d.action).toBeNull();
  });

  it("unknown/unavailable states never start the noise", () => {
    const states = bedtimeStates();
    states.delete(watchedLightEntities()[0]); // entity missing entirely
    const d = evaluateSleepwatch({ hhmm: "23:00", nowMs: NOW, states, playing: false, st: IDLE });
    expect(d.action).toBeNull();
  });

  it("does not start outside the window even if the room is dark", () => {
    const d = evaluateSleepwatch({ hhmm: "14:00", nowMs: NOW, states: bedtimeStates(), playing: false, st: IDLE });
    expect(d.action).toBeNull();
  });
});

describe("stopping", () => {
  const ACTIVE: SleepwatchState = { enabled: true, active: true, latched: false, startedAtMs: NOW - 3_600_000 };

  it("stops at 08:00", () => {
    const d = evaluateSleepwatch({ hhmm: "08:00", nowMs: NOW, states: bedtimeStates(), playing: true, st: ACTIVE });
    expect(d.action).toBe("stop");
    expect(d.next.active).toBe(false);
  });

  it("stops when a watched light comes on", () => {
    const [light] = watchedLightEntities();
    const d = evaluateSleepwatch({
      hhmm: "03:00", nowMs: NOW, states: bedtimeStates({ [light]: "on" }), playing: true, st: ACTIVE,
    });
    expect(d.action).toBe("stop");
  });

  it("a reading light at 3am does NOT stop the noise", () => {
    const [reading] = [...READING_LIGHTS];
    const d = evaluateSleepwatch({
      hhmm: "03:00", nowMs: NOW, states: bedtimeStates({ [reading]: "on" }), playing: true, st: ACTIVE,
    });
    expect(d.action).toBeNull();
    expect(d.next.active).toBe(true);
  });

  it("the TV lift moving does NOT stop the noise", () => {
    const d = evaluateSleepwatch({
      hhmm: "23:30", nowMs: NOW, states: bedtimeStates({ [TV_LIFT_ENTITY]: "on" }), playing: true, st: ACTIVE,
    });
    expect(d.action).toBeNull();
    expect(d.next.active).toBe(true);
  });

  it("an entity dropping to unavailable does NOT stop the noise", () => {
    const [light] = watchedLightEntities();
    const d = evaluateSleepwatch({
      hhmm: "02:00", nowMs: NOW, states: bedtimeStates({ [light]: "unavailable" }), playing: true, st: ACTIVE,
    });
    expect(d.action).toBeNull();
  });

  it("never sends stop for noise it didn't start or adopt", () => {
    const d = evaluateSleepwatch({ hhmm: "09:00", nowMs: NOW, states: bedtimeStates(), playing: true, st: IDLE });
    expect(d.action).toBeNull();
  });
});

describe("early-death retry (the goodnight-sweep fight)", () => {
  it("retries when the stream dies within the grace window of our start", () => {
    const justStarted: SleepwatchState = { enabled: true, active: true, latched: false, startedAtMs: NOW - 40_000, retries: 0 };
    const d = evaluateSleepwatch({ hhmm: "22:52", nowMs: NOW, states: bedtimeStates(), playing: false, st: justStarted });
    expect(d.action).toBe("start");
    expect(d.next.retries).toBe(1);
  });

  it("gives up after MAX_RETRIES and latches", () => {
    const exhausted: SleepwatchState = { enabled: true, active: true, latched: false, startedAtMs: NOW - 40_000, retries: MAX_RETRIES };
    const d = evaluateSleepwatch({ hhmm: "22:53", nowMs: NOW, states: bedtimeStates(), playing: false, st: exhausted });
    expect(d.action).toBeNull();
    expect(d.next).toMatchObject({ active: false, latched: true });
  });

  it("a death past the grace window is a human choice — latch, no retry", () => {
    const longRunning: SleepwatchState = { enabled: true, active: true, latched: false, startedAtMs: NOW - RETRY_WINDOW_MS - 1000, retries: 0 };
    const d = evaluateSleepwatch({ hhmm: "01:00", nowMs: NOW, states: bedtimeStates(), playing: false, st: longRunning });
    expect(d.action).toBeNull();
    expect(d.next).toMatchObject({ active: false, latched: true });
  });

  it("adopted noise (no startedAtMs) stopping latches without retry", () => {
    const adopted: SleepwatchState = { enabled: true, active: true, latched: false, startedAtMs: null };
    const d = evaluateSleepwatch({ hhmm: "23:30", nowMs: NOW, states: bedtimeStates(), playing: false, st: adopted });
    expect(d.action).toBeNull();
    expect(d.next).toMatchObject({ active: false, latched: true });
  });
});

describe("latch and adoption", () => {
  it("a cancel condition clears the latch so the next bedtime arms fresh", () => {
    const latched: SleepwatchState = { enabled: true, active: false, latched: true };
    const [light] = watchedLightEntities();
    const d1 = evaluateSleepwatch({
      hhmm: "23:40", nowMs: NOW, states: bedtimeStates({ [light]: "on" }), playing: false, st: latched,
    });
    expect(d1.next.latched).toBe(false);
    const d2 = evaluateSleepwatch({ hhmm: "23:45", nowMs: NOW, states: bedtimeStates(), playing: false, st: d1.next });
    expect(d2.action).toBe("start");
  });

  it("adopts noise already playing at a met bedtime, so 08:00 still stops it", () => {
    const d1 = evaluateSleepwatch({ hhmm: "22:10", nowMs: NOW, states: bedtimeStates(), playing: true, st: IDLE });
    expect(d1.action).toBeNull();
    expect(d1.next.active).toBe(true);
    const d2 = evaluateSleepwatch({ hhmm: "08:00", nowMs: NOW, states: bedtimeStates(), playing: true, st: d1.next });
    expect(d2.action).toBe("stop");
  });
});
