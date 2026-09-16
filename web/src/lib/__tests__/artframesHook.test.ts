import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DUPLICATE_WINDOW_MS,
  duplicatePress,
  hookConfigured,
  hookKeyMatches,
  parsePress,
  pressUser,
  resetPressMemory,
  sceneSwitchFor,
} from "../artframesHook";
import { MORNING_SCENE_SWITCH, NIGHT_SCENE_SWITCH } from "../artframes";

/**
 * The contract for a press relayed by Home Assistant: only the hook key
 * (or a signed-in programmer, checked in the route) gets in, only "night"
 * and "morning" mean anything, the press maps onto the same scene switch
 * the app's own buttons use, and one press never sweeps twice.
 */

describe("hook key", () => {
  const saved = process.env.HA_HOOK_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.HA_HOOK_KEY;
    else process.env.HA_HOOK_KEY = saved;
  });

  it("is off until HA_HOOK_KEY is set, and then matches only the exact key", () => {
    delete process.env.HA_HOOK_KEY;
    expect(hookConfigured()).toBe(false);
    expect(hookKeyMatches("anything")).toBe(false);
    process.env.HA_HOOK_KEY = "s3cret-key";
    expect(hookConfigured()).toBe(true);
    expect(hookKeyMatches("s3cret-key")).toBe(true);
    expect(hookKeyMatches("s3cret-key ")).toBe(false);
    expect(hookKeyMatches("S3CRET-KEY")).toBe(false);
    expect(hookKeyMatches("")).toBe(false);
    expect(hookKeyMatches(null)).toBe(false);
    expect(hookKeyMatches(undefined)).toBe(false);
  });
});

describe("parsePress", () => {
  it("accepts night and morning, nothing else", () => {
    expect(parsePress("night")).toBe("night");
    expect(parsePress("morning")).toBe("morning");
    expect(parsePress("Night")).toBeNull();
    expect(parsePress("exit")).toBeNull();
    expect(parsePress(1)).toBeNull();
    expect(parsePress(undefined)).toBeNull();
  });
});

describe("pressUser", () => {
  it("names the keypad HA reports, and falls back to 'keypad' for anything odd", () => {
    expect(pressUser("1.1.24")).toBe("ha:1.1.24");
    expect(pressUser("keypad")).toBe("ha:keypad");
    expect(pressUser(undefined)).toBe("ha:keypad");
    expect(pressUser("a b")).toBe("ha:keypad");
    expect(pressUser("x".repeat(41))).toBe("ha:keypad");
    expect(pressUser({ evil: true })).toBe("ha:keypad");
  });
});

describe("sceneSwitchFor", () => {
  it("resolves onto the same scene-switch devices the app's own buttons press", () => {
    const night = sceneSwitchFor("night");
    const morning = sceneSwitchFor("morning");
    expect(night?.entityId).toBe(NIGHT_SCENE_SWITCH);
    expect(night?.category).toBe("scene_switch");
    expect(morning?.entityId).toBe(MORNING_SCENE_SWITCH);
    expect(morning?.id).toBe("whole_house__all_house_morning");
  });
});

describe("duplicatePress", () => {
  beforeEach(() => resetPressMemory());

  it("lets a press through, then swallows a repeat inside the window", () => {
    expect(duplicatePress("night", 1_000)).toBe(false);
    expect(duplicatePress("night", 1_000 + DUPLICATE_WINDOW_MS - 1)).toBe(true);
    expect(duplicatePress("night", 1_000 + DUPLICATE_WINDOW_MS)).toBe(false);
  });

  it("keeps Night and Morning apart — a Morning right after a Night is a real press", () => {
    expect(duplicatePress("night", 5_000)).toBe(false);
    expect(duplicatePress("morning", 5_500)).toBe(false);
    expect(duplicatePress("night", 6_000)).toBe(true);
  });

  it("a swallowed repeat does not extend the window", () => {
    expect(duplicatePress("morning", 0)).toBe(false);
    expect(duplicatePress("morning", 9_000)).toBe(true);
    // 10 s after the FIRST press, not after the repeat.
    expect(duplicatePress("morning", 10_000)).toBe(false);
  });
});
