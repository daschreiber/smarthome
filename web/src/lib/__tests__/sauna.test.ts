import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saunaSetTemperature, saunaStart, saunaStatus } from "../sauna";

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
  vi.stubGlobal("fetch", async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify(response), { status: 200 });
  });
});

afterEach(() => vi.unstubAllGlobals());

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
});
