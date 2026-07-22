import { describe, expect, it } from "vitest";
import {
  READING_LIGHTS, TV_LIFT_ENTITY, evaluateSleepwatch, inWindow,
  shadeEntities, watchedLightEntities, type SleepwatchState,
} from "../sleepwatch";

/**
 * The sleep watcher's contract: between 22:00 and 08:00 a dark, closed,
 * TV-stowed Master Bedroom starts the noise; 08:00 / a light / a shade
 * stops it; reading lights and the TV lift never stop it; manual off
 * latches for the night. States come from the repo's real entity map.
 */

const IDLE: SleepwatchState = { enabled: true, active: false, latched: false };

/** All conditions met: watched lights off, shades closed, lift stowed. */
function bedtimeStates(overrides: Record<string, string> = {}): Map<string, { state: string }> {
  const m = new Map<string, { state: string }>();
  for (const id of watchedLightEntities()) m.set(id, { state: "off" });
  for (const id of READING_LIGHTS) m.set(id, { state: "off" });
  for (const id of shadeEntities()) m.set(id, { state: "closed" });
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

  it("finds the three MBR shades", () => {
    expect(shadeEntities().sort()).toEqual([
      "cover.master_bedroom_master_bedroom_balcony_left",
      "cover.master_bedroom_master_bedroom_balcony_right",
      "cover.master_bedroom_master_bedroom_window",
    ]);
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
  it("starts the noise when the room looks asleep after 22:00", () => {
    const d = evaluateSleepwatch({ hhmm: "22:30", states: bedtimeStates(), playing: false, st: IDLE });
    expect(d.action).toBe("start");
    expect(d.next.active).toBe(true);
  });

  it("a reading light on does not block arming", () => {
    const [reading] = [...READING_LIGHTS];
    const d = evaluateSleepwatch({
      hhmm: "23:00", states: bedtimeStates({ [reading]: "on" }), playing: false, st: IDLE,
    });
    expect(d.action).toBe("start");
  });

  it("any other light on blocks arming", () => {
    const [light] = watchedLightEntities();
    const d = evaluateSleepwatch({
      hhmm: "23:00", states: bedtimeStates({ [light]: "on" }), playing: false, st: IDLE,
    });
    expect(d.action).toBeNull();
  });

  it("an open shade blocks arming", () => {
    const [shade] = shadeEntities();
    const d = evaluateSleepwatch({
      hhmm: "23:00", states: bedtimeStates({ [shade]: "open" }), playing: false, st: IDLE,
    });
    expect(d.action).toBeNull();
  });

  it("TV lift not stowed blocks arming", () => {
    const d = evaluateSleepwatch({
      hhmm: "23:00", states: bedtimeStates({ [TV_LIFT_ENTITY]: "on" }), playing: false, st: IDLE,
    });
    expect(d.action).toBeNull();
  });

  it("unknown/unavailable states never start the noise", () => {
    const states = bedtimeStates();
    states.delete(shadeEntities()[0]); // entity missing entirely
    const d = evaluateSleepwatch({ hhmm: "23:00", states, playing: false, st: IDLE });
    expect(d.action).toBeNull();
  });

  it("does not start outside the window even if the room is dark", () => {
    const d = evaluateSleepwatch({ hhmm: "14:00", states: bedtimeStates(), playing: false, st: IDLE });
    expect(d.action).toBeNull();
  });
});

describe("stopping", () => {
  const ACTIVE: SleepwatchState = { enabled: true, active: true, latched: false };

  it("stops at 08:00", () => {
    const d = evaluateSleepwatch({ hhmm: "08:00", states: bedtimeStates(), playing: true, st: ACTIVE });
    expect(d.action).toBe("stop");
    expect(d.next.active).toBe(false);
  });

  it("stops when a watched light comes on", () => {
    const [light] = watchedLightEntities();
    const d = evaluateSleepwatch({
      hhmm: "03:00", states: bedtimeStates({ [light]: "on" }), playing: true, st: ACTIVE,
    });
    expect(d.action).toBe("stop");
  });

  it("stops when a shade opens", () => {
    const [shade] = shadeEntities();
    const d = evaluateSleepwatch({
      hhmm: "06:30", states: bedtimeStates({ [shade]: "opening" }), playing: true, st: ACTIVE,
    });
    expect(d.action).toBe("stop");
  });

  it("a reading light at 3am does NOT stop the noise", () => {
    const [reading] = [...READING_LIGHTS];
    const d = evaluateSleepwatch({
      hhmm: "03:00", states: bedtimeStates({ [reading]: "on" }), playing: true, st: ACTIVE,
    });
    expect(d.action).toBeNull();
    expect(d.next.active).toBe(true);
  });

  it("the TV lift moving does NOT stop the noise", () => {
    const d = evaluateSleepwatch({
      hhmm: "23:30", states: bedtimeStates({ [TV_LIFT_ENTITY]: "on" }), playing: true, st: ACTIVE,
    });
    expect(d.action).toBeNull();
    expect(d.next.active).toBe(true);
  });

  it("an entity dropping to unavailable does NOT stop the noise", () => {
    const [light] = watchedLightEntities();
    const d = evaluateSleepwatch({
      hhmm: "02:00", states: bedtimeStates({ [light]: "unavailable" }), playing: true, st: ACTIVE,
    });
    expect(d.action).toBeNull();
  });

  it("never sends stop for noise it didn't start or adopt", () => {
    const d = evaluateSleepwatch({ hhmm: "09:00", states: bedtimeStates(), playing: true, st: IDLE });
    expect(d.action).toBeNull();
  });
});

describe("latch and adoption", () => {
  it("manual off while the room still looks asleep latches for the night", () => {
    const active: SleepwatchState = { enabled: true, active: true, latched: false };
    const d1 = evaluateSleepwatch({ hhmm: "23:30", states: bedtimeStates(), playing: false, st: active });
    expect(d1.action).toBeNull();
    expect(d1.next).toMatchObject({ active: false, latched: true });
    // ...and stays down on the next tick.
    const d2 = evaluateSleepwatch({ hhmm: "23:31", states: bedtimeStates(), playing: false, st: d1.next });
    expect(d2.action).toBeNull();
  });

  it("a cancel condition clears the latch so the next bedtime arms fresh", () => {
    const latched: SleepwatchState = { enabled: true, active: false, latched: true };
    const [shade] = shadeEntities();
    const d1 = evaluateSleepwatch({
      hhmm: "23:40", states: bedtimeStates({ [shade]: "open" }), playing: false, st: latched,
    });
    expect(d1.next.latched).toBe(false);
    const d2 = evaluateSleepwatch({ hhmm: "23:45", states: bedtimeStates(), playing: false, st: d1.next });
    expect(d2.action).toBe("start");
  });

  it("adopts noise already playing at a met bedtime, so 08:00 still stops it", () => {
    const d1 = evaluateSleepwatch({ hhmm: "22:10", states: bedtimeStates(), playing: true, st: IDLE });
    expect(d1.action).toBeNull();
    expect(d1.next.active).toBe(true);
    const d2 = evaluateSleepwatch({ hhmm: "08:00", states: bedtimeStates(), playing: true, st: d1.next });
    expect(d2.action).toBe("stop");
  });
});
