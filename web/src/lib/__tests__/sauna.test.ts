import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateSaunaCache, saunaScheduleStatus, saunaSetTemperature, saunaStart, saunaStatus, saunaStop, saunaStopIn } from "../sauna";

/**
 * Pins the wire contract with the KLAFS sauna app (daschreiber/Sauna,
 * api/index.py /api/quick/*), verified against that repo on 2026-07-17:
 * token rides as a ?token= query param, temperature uses ?temp=,
 * failures arrive as HTTP 200 bodies with error/warning fields.
 */

const calls: string[] = [];
let response: Record<string, unknown> = {};

beforeEach(() => {
  process.env.SAUNA_BASE_URL = "https://sauna.example";
  process.env.SAUNA_API_TOKEN = "tok123";
  calls.length = 0;
  invalidateSaunaCache();
  vi.stubGlobal("fetch", async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify(response), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sauna adapter wire contract", () => {
  it("status maps the quick/status fields", async () => {
    response = {
      success: true, isPoweredOn: true, isConnected: true,
      currentTemperature: 62, selectedTemperature: 85, isReadyForUse: false,
    };
    const s = await saunaStatus();
    expect(s).toEqual({
      poweredOn: true, connected: true, currentTemperature: 62,
      selectedTemperature: 85, readyForUse: false,
    });
    expect(calls[0]).toContain("https://sauna.example/api/quick/status?");
    expect(calls[0]).toContain("token=tok123");
  });

  it("set temperature sends the temp query param", async () => {
    response = { success: true, temperature: 90 };
    await saunaSetTemperature(90);
    expect(calls[0]).toContain("/api/quick/temperature?");
    expect(calls[0]).toContain("temp=90");
  });

  it("start surfaces success:false warnings as errors", async () => {
    response = { success: false, warning: "heater did not ignite", command_sent: true };
    await expect(saunaStart()).rejects.toThrow(/heater did not ignite/);
  });

  it("a gateway timeout during start is 'sent', not failed — the watchdog owns it", async () => {
    vi.stubGlobal("fetch", async () => new Response("FUNCTION_INVOCATION_TIMEOUT", { status: 504 }));
    const r = await saunaStart();
    expect(r.verified).toBe(false);
    expect(r.message).toMatch(/watchdog/);
  });

  it("start reports verified=false when the app answers 'armed, pending ignition'", async () => {
    response = { success: true, verified: false, message: "Sauna armed - heating starts by 12:40" };
    const r = await saunaStart();
    expect(r.verified).toBe(false);
    expect(r.message).toMatch(/armed/);
  });

  it("an error body counts as failure even with HTTP 200", async () => {
    response = { error: "Login failed" };
    await expect(saunaStatus()).rejects.toThrow(/Login failed/);
  });

  it("start rides temp and stop_after on the query string and returns stop_at", async () => {
    response = { success: true, verified: true, message: "Sauna starting at 90°C", stop_at: "14:30" };
    const r = await saunaStart({ temp: 90, stopAfterMinutes: 120 });
    expect(calls[0]).toContain("temp=90");
    expect(calls[0]).toContain("stop_after=120");
    expect(r.stopAt).toBe("14:30");
  });

  it("stop-in schedules the auto-stop and surfaces stop_at", async () => {
    response = { success: true, stop_at: "15:45", schedule_id: "abc" };
    const r = await saunaStopIn(60);
    expect(calls[0]).toContain("/api/quick/stop-in?");
    expect(calls[0]).toContain("minutes=60");
    expect(r.stopAt).toBe("15:45");
  });

  it("schedule-status degrades to null when the endpoint is missing (older sauna app)", async () => {
    vi.stubGlobal("fetch", async () => new Response("Not Found", { status: 404 }));
    expect(await saunaScheduleStatus()).toEqual({ stopAt: null });
  });
});

/**
 * The read cache exists because of a real outage: the dashboard's 3s poll
 * turned into two sauna-app calls each, and the sauna app's Redis quota
 * (500k requests/month) ran out — nobody could sign in there and KLAFS
 * locked the account under the login storm. Reads must be served from
 * memory for 30s; commands must drop the cache so the card is honest.
 */
describe("sauna read cache", () => {
  it("serves status from memory within 30s and refetches after", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
    response = { success: true, isPoweredOn: false, currentTemperature: 22 };
    await saunaStatus();
    await saunaStatus();
    await saunaStatus();
    expect(calls.filter((c) => c.includes("/api/quick/status")).length).toBe(1);

    vi.setSystemTime(new Date("2026-09-19T12:00:31Z"));
    response = { success: true, isPoweredOn: true, currentTemperature: 60 };
    const s = await saunaStatus();
    expect(s.poweredOn).toBe(true);
    expect(calls.filter((c) => c.includes("/api/quick/status")).length).toBe(2);
  });

  it("coalesces concurrent status reads into one request", async () => {
    response = { success: true, isPoweredOn: false, currentTemperature: 22 };
    await Promise.all([saunaStatus(), saunaStatus(), saunaStatus()]);
    expect(calls.length).toBe(1);
  });

  it("caches schedule-status for a minute", async () => {
    response = { stop_at: "14:30" };
    await saunaScheduleStatus();
    await saunaScheduleStatus();
    expect(calls.filter((c) => c.includes("/api/quick/schedule-status")).length).toBe(1);
  });

  it("remembers a failure briefly instead of re-polling a down sauna app every 3s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
    response = { error: "Storage unavailable" };
    await expect(saunaStatus()).rejects.toThrow(/Storage unavailable/);
    await expect(saunaStatus()).rejects.toThrow(/Storage unavailable/);
    expect(calls.length).toBe(1);

    vi.setSystemTime(new Date("2026-09-19T12:00:16Z"));
    response = { success: true, isPoweredOn: false };
    await saunaStatus();
    expect(calls.length).toBe(2);
  });

  it("commands drop the cache so the next read is live", async () => {
    response = { success: true, isPoweredOn: false, currentTemperature: 22 };
    await saunaStatus();
    response = { success: true, message: "stopped" };
    await saunaStop();
    response = { success: true, isPoweredOn: true, currentTemperature: 22 };
    const s = await saunaStatus();
    expect(s.poweredOn).toBe(true);
    expect(calls.filter((c) => c.includes("/api/quick/status")).length).toBe(2);
  });
});
