import { describe, expect, it } from "vitest";
import {
  CLOSET_LIGHTS, MAX_RETRIES, READING_LIGHTS, RETRY_WINDOW_MS, TV_LIFT_ENTITY,
  coverEntities, evaluateSleepwatch, inWindow, watchedLightEntities,
  type SleepwatchState,
} from "../sleepwatch";

/**
 * The sleep watcher's contract: between 22:00 and 08:00 a dark, TV-stowed
 * Master Bedroom starts the noise. There is NO morning clock — the noise
 * stops when the room wakes: a watched light comes on, or a shade's report
 * MOVES toward open (an edge, never the absolute state — the C4 covers
 * report "open" forever, position feedback stuck ~1%, which is what kept
 * the watcher from ever arming on the first real night). Reading lights
 * and the TV lift never stop it; manual off latches for the night, but a
 * stream that dies right after our own start is retried (the C4 goodnight
 * sweep) — unless the stop was COMMANDED through lib/whitenoise. A shade
 * opening ends the whole night (`morning`), not just the session — the
 * 2026-08-13 morning taught that re-arming before 08:00 relights the noise
 * over an awake room.
 */

const IDLE: SleepwatchState = { enabled: true, active: false, latched: false };
const NOW = 1_700_000_000_000;

type Reading = { state: string; position?: number | null };

/** All conditions met: watched lights off, lift stowed. Covers default to
 *  the C4 stuck-open reality so every test exercises it. */
function bedtimeStates(
  overrides: Record<string, string | Reading> = {},
): Map<string, Reading> {
  const m = new Map<string, Reading>();
  for (const id of watchedLightEntities()) m.set(id, { state: "off" });
  for (const id of READING_LIGHTS) m.set(id, { state: "off" });
  for (const id of CLOSET_LIGHTS) m.set(id, { state: "off" });
  for (const id of coverEntities()) m.set(id, { state: "open", position: 1 });
  m.set(TV_LIFT_ENTITY, { state: "off" });
  for (const [id, v] of Object.entries(overrides)) {
    m.set(id, typeof v === "string" ? { state: v } : v);
  }
  return m;
}

describe("entity derivation", () => {
  it("watches every real MBR light except the reading and closet pairs", () => {
    const watched = watchedLightEntities();
    expect(watched.length).toBeGreaterThanOrEqual(4);
    for (const id of READING_LIGHTS) expect(watched).not.toContain(id);
    for (const id of CLOSET_LIGHTS) expect(watched).not.toContain(id);
    expect(watched).toContain("light.knx_dimmer_master_bedroom_lights");
    // The TV lift rides the light domain but is Utilities, not Lighting.
    expect(watched).not.toContain(TV_LIFT_ENTITY);
  });

  it("finds the three MBR shades for movement watching", () => {
    expect(coverEntities().sort()).toEqual([
      "cover.mbr_balcony_left_blinds_knx",
      "cover.mbr_balcony_right_blinds_knx",
      "cover.mbr_window_blinds_knx",
    ]);
  });
});

describe("window (arming only)", () => {
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

  it("a closet light on does not block arming", () => {
    const [closet] = [...CLOSET_LIGHTS];
    const d = evaluateSleepwatch({
      hhmm: "23:00", nowMs: NOW, states: bedtimeStates({ [closet]: "on" }), playing: false, st: IDLE,
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

describe("away mode — nobody is sleeping here", () => {
  const ACTIVE: SleepwatchState = { enabled: true, active: true, latched: false, startedAtMs: NOW - 3_600_000 };

  it("never arms while away, however asleep the room looks", () => {
    const d = evaluateSleepwatch({
      hhmm: "23:00", nowMs: NOW, states: bedtimeStates(), playing: false, st: IDLE, away: true,
    });
    expect(d.action).toBeNull();
    expect(d.next.active).toBe(false);
  });

  it("stops a session the watcher owns when away flips on mid-stream", () => {
    const d = evaluateSleepwatch({
      hhmm: "23:30", nowMs: NOW, states: bedtimeStates(), playing: true, st: ACTIVE, away: true,
    });
    expect(d.action).toBe("stop");
    expect(d.next).toMatchObject({ active: false, latched: false });
  });

  it("an unreadable status does not skip the away stop (turn_off is idempotent)", () => {
    const d = evaluateSleepwatch({
      hhmm: "23:30", nowMs: NOW, states: bedtimeStates(), playing: null, st: ACTIVE, away: true,
    });
    expect(d.action).toBe("stop");
  });

  it("leaves noise someone else started alone — away is not a wake-up for it", () => {
    const d = evaluateSleepwatch({
      hhmm: "23:30", nowMs: NOW, states: bedtimeStates(), playing: true, st: IDLE, away: true,
    });
    expect(d.action).toBeNull();
    expect(d.next.active).toBe(false); // and it is never adopted
  });

  it("clears a latch so the first night back arms fresh", () => {
    const d = evaluateSleepwatch({
      hhmm: "23:00", nowMs: NOW, states: bedtimeStates(), playing: false,
      st: { enabled: true, active: false, latched: true }, away: true,
    });
    expect(d.action).toBeNull();
    expect(d.next.latched).toBe(false);
  });
});

describe("stopping — the room waking, never the clock", () => {
  const ACTIVE: SleepwatchState = { enabled: true, active: true, latched: false, startedAtMs: NOW - 3_600_000 };

  it("does NOT stop at 08:00 — plays on until the room wakes", () => {
    const d = evaluateSleepwatch({ hhmm: "08:00", nowMs: NOW, states: bedtimeStates(), playing: true, st: ACTIVE });
    expect(d.action).toBeNull();
    expect(d.next.active).toBe(true);
  });

  it("keeps playing mid-morning if nothing in the room changed", () => {
    const d = evaluateSleepwatch({ hhmm: "10:30", nowMs: NOW, states: bedtimeStates(), playing: true, st: ACTIVE });
    expect(d.action).toBeNull();
    expect(d.next.active).toBe(true);
  });

  it("stops when a watched light comes on — at night", () => {
    const [light] = watchedLightEntities();
    const d = evaluateSleepwatch({
      hhmm: "03:00", nowMs: NOW, states: bedtimeStates({ [light]: "on" }), playing: true, st: ACTIVE,
    });
    expect(d.action).toBe("stop");
  });

  it("stops when a watched light comes on — after the window too", () => {
    const [light] = watchedLightEntities();
    const d = evaluateSleepwatch({
      hhmm: "09:15", nowMs: NOW, states: bedtimeStates({ [light]: "on" }), playing: true, st: ACTIVE,
    });
    expect(d.action).toBe("stop");
    expect(d.next).toMatchObject({ active: false, latched: false });
  });

  it("a reading light at 3am does NOT stop the noise", () => {
    const [reading] = [...READING_LIGHTS];
    const d = evaluateSleepwatch({
      hhmm: "03:00", nowMs: NOW, states: bedtimeStates({ [reading]: "on" }), playing: true, st: ACTIVE,
    });
    expect(d.action).toBeNull();
    expect(d.next.active).toBe(true);
  });

  it("a closet light at 3am does NOT stop the noise", () => {
    const [closet] = [...CLOSET_LIGHTS];
    const d = evaluateSleepwatch({
      hhmm: "03:00", nowMs: NOW, states: bedtimeStates({ [closet]: "on" }), playing: true, st: ACTIVE,
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
    const [light] = watchedLightEntities();
    const d = evaluateSleepwatch({
      hhmm: "09:00", nowMs: NOW, states: bedtimeStates({ [light]: "on" }), playing: true, st: IDLE,
    });
    expect(d.action).toBeNull();
  });

  it("an unreadable status does NOT skip the wake-up stop (turn_off is idempotent)", () => {
    const [light] = watchedLightEntities();
    const d = evaluateSleepwatch({
      hhmm: "08:05", nowMs: NOW, states: bedtimeStates({ [light]: "on" }), playing: null, st: ACTIVE,
    });
    expect(d.action).toBe("stop");
  });
});

describe("stopping — shade movement is an edge, not a level", () => {
  const ACTIVE: SleepwatchState = { enabled: true, active: true, latched: false, startedAtMs: NOW - 3_600_000 };
  const [shade] = coverEntities();

  /** Run one tick to record the baseline snapshot, return the carried state. */
  function withBaseline(st: SleepwatchState, states: Map<string, Reading>): SleepwatchState {
    const d = evaluateSleepwatch({ hhmm: "05:00", nowMs: NOW, states, playing: true, st });
    expect(d.action).toBeNull();
    return d.next;
  }

  it("the stuck-open covers never stop the noise (level is no signal)", () => {
    const st1 = withBaseline(ACTIVE, bedtimeStates());
    const d = evaluateSleepwatch({ hhmm: "09:00", nowMs: NOW, states: bedtimeStates(), playing: true, st: st1 });
    expect(d.action).toBeNull();
    expect(d.next.active).toBe(true);
  });

  it("closed→open stops the noise, even long after the window", () => {
    const st1 = withBaseline(ACTIVE, bedtimeStates({ [shade]: { state: "closed", position: 1 } }));
    const d = evaluateSleepwatch({
      hhmm: "09:40", nowMs: NOW, states: bedtimeStates({ [shade]: { state: "opening", position: 1 } }),
      playing: true, st: st1,
    });
    expect(d.action).toBe("stop");
    expect(d.reason).toContain("shade opening");
  });

  it("a real position rise stops the noise", () => {
    const st1 = withBaseline(ACTIVE, bedtimeStates({ [shade]: { state: "open", position: 1 } }));
    const d = evaluateSleepwatch({
      hhmm: "07:20", nowMs: NOW, states: bedtimeStates({ [shade]: { state: "open", position: 40 } }),
      playing: true, st: st1,
    });
    expect(d.action).toBe("stop");
  });

  it("position jitter below the delta does not", () => {
    const st1 = withBaseline(ACTIVE, bedtimeStates({ [shade]: { state: "open", position: 1 } }));
    const d = evaluateSleepwatch({
      hhmm: "03:10", nowMs: NOW, states: bedtimeStates({ [shade]: { state: "open", position: 2 } }),
      playing: true, st: st1,
    });
    expect(d.action).toBeNull();
  });

  it("closing is not a wake-up", () => {
    const st1 = withBaseline(ACTIVE, bedtimeStates({ [shade]: { state: "open", position: 40 } }));
    const d = evaluateSleepwatch({
      hhmm: "23:10", nowMs: NOW, states: bedtimeStates({ [shade]: { state: "closing", position: 10 } }),
      playing: true, st: st1,
    });
    expect(d.action).toBeNull();
  });

  it("unavailable→open flapping (integration restart) is not movement", () => {
    const st1 = withBaseline(ACTIVE, bedtimeStates({ [shade]: { state: "unavailable", position: null } }));
    const d = evaluateSleepwatch({
      hhmm: "04:00", nowMs: NOW, states: bedtimeStates({ [shade]: { state: "open", position: 1 } }),
      playing: true, st: st1,
    });
    expect(d.action).toBeNull();
  });

  it("a shade opening replaces a manual latch with the morning flag", () => {
    const latched: SleepwatchState = { enabled: true, active: false, latched: true };
    const st1Decision = evaluateSleepwatch({
      hhmm: "23:00", nowMs: NOW, states: bedtimeStates({ [shade]: { state: "closed", position: 1 } }),
      playing: false, st: latched,
    });
    const d = evaluateSleepwatch({
      hhmm: "23:05", nowMs: NOW, states: bedtimeStates({ [shade]: { state: "open", position: 30 } }),
      playing: false, st: st1Decision.next,
    });
    expect(d.next).toMatchObject({ latched: false, morning: true });
  });
});

describe("morning — a shade opening ends the night (2026-08-13)", () => {
  const ACTIVE: SleepwatchState = { enabled: true, active: true, latched: false, startedAtMs: NOW - 8 * 3_600_000 };
  const [shade] = coverEntities();

  /** The reported morning: noise playing, blinds go up at 06:50. */
  function wake(): SleepwatchState {
    const baseline = evaluateSleepwatch({
      hhmm: "06:49", nowMs: NOW, states: bedtimeStates({ [shade]: { state: "closed", position: 1 } }),
      playing: true, st: ACTIVE,
    });
    const d = evaluateSleepwatch({
      hhmm: "06:50", nowMs: NOW, states: bedtimeStates({ [shade]: { state: "opening", position: 20 } }),
      playing: true, st: baseline.next,
    });
    expect(d.action).toBe("stop");
    expect(d.next).toMatchObject({ active: false, morning: true });
    return d.next;
  }

  it("does NOT re-arm 30s later over a dark room still inside the window", () => {
    const woke = wake();
    // The exact failure: 06:53, lights off, lift stowed, in window — the
    // old watcher read this as a fresh bedtime and relit the noise.
    const d = evaluateSleepwatch({ hhmm: "06:53", nowMs: NOW + 180_000, states: bedtimeStates(), playing: false, st: woke });
    expect(d.action).toBeNull();
    expect(d.reason).toContain("morning");
  });

  it("a light flicking on and off at 07:30 does not resurrect bedtime", () => {
    const woke = wake();
    const [light] = watchedLightEntities();
    const on = evaluateSleepwatch({
      hhmm: "07:30", nowMs: NOW + 2_400_000, states: bedtimeStates({ [light]: "on" }), playing: false, st: woke,
    });
    expect(on.next.morning).toBe(true); // the light cancel must not clear it
    const off = evaluateSleepwatch({ hhmm: "07:32", nowMs: NOW + 2_520_000, states: bedtimeStates(), playing: false, st: on.next });
    expect(off.action).toBeNull();
  });

  it("a light-only cancel still resets the night — noise resumes after a 2am bathroom trip", () => {
    const [light] = watchedLightEntities();
    const on = evaluateSleepwatch({
      hhmm: "02:00", nowMs: NOW, states: bedtimeStates({ [light]: "on" }), playing: true, st: ACTIVE,
    });
    expect(on.action).toBe("stop");
    expect(on.next.morning).toBeFalsy();
    const off = evaluateSleepwatch({ hhmm: "02:10", nowMs: NOW + 600_000, states: bedtimeStates(), playing: false, st: on.next });
    expect(off.action).toBe("start");
  });

  it("manually started noise during the morning is still adopted (the escape hatch)", () => {
    const woke = wake();
    const d = evaluateSleepwatch({ hhmm: "07:00", nowMs: NOW + 600_000, states: bedtimeStates(), playing: true, st: woke });
    expect(d.action).toBeNull();
    expect(d.next.active).toBe(true);
  });
});

describe("commanded stops are never interference (2026-08-13)", () => {
  const JUST_STARTED: SleepwatchState = { enabled: true, active: true, latched: false, startedAtMs: NOW - 40_000, retries: 0 };

  it("an app/scene/assistant stop within the grace window latches instead of retrying", () => {
    const d = evaluateSleepwatch({
      hhmm: "06:55", nowMs: NOW, states: bedtimeStates(), playing: false, st: JUST_STARTED,
      manualStopMs: NOW - 10_000, // stopped after our start
    });
    expect(d.action).toBeNull();
    expect(d.next).toMatchObject({ active: false, latched: true });
    expect(d.reason).toContain("command");
  });

  it("a stale mark from an earlier episode does not suppress the retry", () => {
    const d = evaluateSleepwatch({
      hhmm: "22:52", nowMs: NOW, states: bedtimeStates(), playing: false, st: JUST_STARTED,
      manualStopMs: NOW - 3_600_000, // yesterday's wake-stop, before our start
    });
    expect(d.action).toBe("start");
    expect(d.next.retries).toBe(1);
  });
});

describe("unknown status holds state", () => {
  it("mid-night unreadable status neither latches nor clears active", () => {
    const active: SleepwatchState = { enabled: true, active: true, latched: false, startedAtMs: NOW - 3_600_000 };
    const d = evaluateSleepwatch({ hhmm: "03:00", nowMs: NOW, states: bedtimeStates(), playing: null, st: active });
    expect(d.action).toBeNull();
    expect(d.next).toMatchObject({ active: true, latched: false, startedAtMs: active.startedAtMs });
  });

  it("never adopts on an unreadable status", () => {
    const d = evaluateSleepwatch({ hhmm: "23:00", nowMs: NOW, states: bedtimeStates(), playing: null, st: IDLE });
    expect(d.action).toBeNull();
    expect(d.next.active).toBe(false);
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

  it("adopts noise already playing at a met bedtime, so the wake-up stop applies", () => {
    const d1 = evaluateSleepwatch({ hhmm: "22:10", nowMs: NOW, states: bedtimeStates(), playing: true, st: IDLE });
    expect(d1.action).toBeNull();
    expect(d1.next.active).toBe(true);
    const [light] = watchedLightEntities();
    const d2 = evaluateSleepwatch({
      hhmm: "08:30", nowMs: NOW, states: bedtimeStates({ [light]: "on" }), playing: true, st: d1.next,
    });
    expect(d2.action).toBe("stop");
  });
});
