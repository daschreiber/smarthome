import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noiseMediaEntity, noiseStatus, noiseStreamUrl, setNoiseType, setNoiseVolume } from "../whitenoise";

/**
 * Pins the wire contract with the white-noise machine
 * (daschreiber/whitenoise app/api.py, verified 2026-07-17): Bearer token
 * auth, GET /api/status and POST /api/noise/{type} | /api/volume/{level},
 * all answering {noise_type, volume, listeners}; errors as {detail}.
 */

const calls: Array<{ url: string; method?: string; auth?: string | null }> = [];
let response: Record<string, unknown> = {};
let status = 200;

beforeEach(() => {
  process.env.WHITENOISE_BASE_URL = "https://noise.example/";
  process.env.WHITENOISE_TOKEN = "tok9";
  calls.length = 0;
  status = 200;
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      auth: new Headers(init?.headers).get("authorization"),
    });
    return new Response(JSON.stringify(response), { status });
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("white-noise adapter wire contract", () => {
  it("status maps the snake_case fields and authenticates via Bearer", async () => {
    response = { noise_type: "brown", volume: 40, listeners: 1 };
    const s = await noiseStatus();
    expect(s).toEqual({ noiseType: "brown", volume: 40, listeners: 1 });
    expect(calls[0].url).toBe("https://noise.example/api/status");
    expect(calls[0].auth).toBe("Bearer tok9");
  });

  it("noise type and volume use the path-parameter POST endpoints", async () => {
    response = { noise_type: "pink", volume: 55, listeners: 0 };
    await setNoiseType("pink");
    expect(calls[0]).toMatchObject({ url: "https://noise.example/api/noise/pink", method: "POST" });
    await setNoiseVolume(55.4);
    expect(calls[1]).toMatchObject({ url: "https://noise.example/api/volume/55", method: "POST" });
  });

  it("surfaces the API's error detail", async () => {
    response = { detail: "invalid noise type" };
    status = 400;
    await expect(setNoiseType("white")).rejects.toThrow(/invalid noise type/);
  });

  it("builds the token-bearing stream URL and defaults the media entity", () => {
    expect(noiseStreamUrl()).toBe("https://noise.example/stream?token=tok9");
    expect(noiseMediaEntity()).toBe("media_player.master_bedroom");
    process.env.WHITENOISE_MEDIA_ENTITY = "media_player.bedroom_zone";
    expect(noiseMediaEntity()).toBe("media_player.bedroom_zone");
    delete process.env.WHITENOISE_MEDIA_ENTITY;
  });
});
