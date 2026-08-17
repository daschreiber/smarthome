import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  noiseConfigured,
  noiseMediaEntity,
  noiseMediaSource,
  noiseStatus,
  noiseStatusFresh,
  noiseStoppedAtMs,
  noiseStreamUrl,
  noiseTurnOff,
  noiseTurnOn,
  resetNoiseStoppedAt,
  setNoiseType,
  setNoiseVolume,
} from "../whitenoise";
import { callService, getState } from "../ha";

vi.mock("../ha", () => ({
  callService: vi.fn(async () => undefined),
  getState: vi.fn(async () => null),
}));

/**
 * Pins the wire contract with the white-noise machine
 * (daschreiber/whitenoise app/api.py, verified 2026-07-17): Bearer token
 * auth, GET /api/status and POST /api/noise/{type} | /api/volume/{level},
 * all answering {noise_type, volume, listeners}; errors as {detail}.
 *
 * Via-HA mode (verified against the Green 2026-07-22): control rides HA's
 * rest_command.whitenoise_set_noise / whitenoise_set_volume, status is
 * mirrored in sensor.white_noise_status's attributes.
 */

const calls: Array<{ url: string; method?: string; auth?: string | null }> = [];
let response: Record<string, unknown> = {};
let status = 200;

beforeEach(() => {
  process.env.WHITENOISE_BASE_URL = "https://noise.example/";
  process.env.WHITENOISE_TOKEN = "tok9";
  delete process.env.WHITENOISE_VIA_HA;
  delete process.env.WHITENOISE_STREAM_URL;
  calls.length = 0;
  status = 200;
  resetNoiseStoppedAt();
  vi.mocked(callService).mockClear();
  vi.mocked(getState).mockClear();
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

  it("media source is null unless configured (Control4 select_source mode)", () => {
    expect(noiseMediaSource()).toBeNull();
    process.env.WHITENOISE_MEDIA_SOURCE = "White Noise";
    expect(noiseMediaSource()).toBe("White Noise");
    delete process.env.WHITENOISE_MEDIA_SOURCE;
  });

  it("prepends https:// to a scheme-less base URL (the bare-host paste trap)", async () => {
    // Railway shows the domain without a scheme; a bare host used to make
    // fetch() throw "Failed to parse URL". It must be normalized for both the
    // API calls and the stream URL handed to the speakers.
    process.env.WHITENOISE_BASE_URL = "whitenoise-production.up.railway.app";
    response = { noise_type: "white", volume: 30, listeners: 0 };
    await noiseStatus();
    expect(calls[0].url).toBe("https://whitenoise-production.up.railway.app/api/status");
    expect(noiseStreamUrl()).toBe("https://whitenoise-production.up.railway.app/stream?token=tok9");
  });
});

describe("via-HA mode (LAN add-on behind Home Assistant)", () => {
  const sensor = (attrs: Record<string, unknown>) => ({
    entity_id: "sensor.white_noise_status",
    state: String(attrs.listeners ?? 0),
    attributes: attrs,
    last_updated: "",
    last_changed: "",
  });

  beforeEach(() => {
    process.env.WHITENOISE_VIA_HA = "1";
    delete process.env.WHITENOISE_BASE_URL;
    delete process.env.WHITENOISE_TOKEN;
    vi.mocked(getState).mockResolvedValue(sensor({ noise_type: "pink", volume: 72, listeners: 1 }));
  });

  it("counts as configured without base URL and token", () => {
    expect(noiseConfigured()).toBe(true);
  });

  it("reads status from the HA sensor's attributes, no direct fetch", async () => {
    const s = await noiseStatus();
    expect(s).toEqual({ noiseType: "pink", volume: 72, listeners: 1 });
    expect(vi.mocked(getState)).toHaveBeenCalledWith("sensor.white_noise_status");
    expect(calls).toHaveLength(0); // never talks to the noise server itself
  });

  it("fresh status forces an update_entity before reading", async () => {
    await noiseStatusFresh();
    expect(vi.mocked(callService)).toHaveBeenCalledWith("homeassistant", "update_entity", {
      entity_id: "sensor.white_noise_status",
    });
  });

  it("sound changes ride the rest_commands and clamp volume", async () => {
    await setNoiseType("brown");
    expect(vi.mocked(callService)).toHaveBeenCalledWith("rest_command", "whitenoise_set_noise", {
      noise_type: "brown",
    });
    await setNoiseVolume(155);
    expect(vi.mocked(callService)).toHaveBeenCalledWith("rest_command", "whitenoise_set_volume", {
      volume: 100,
    });
  });

  it("WHITENOISE_STREAM_URL overrides the built stream URL (LAN plain HTTP)", () => {
    process.env.WHITENOISE_STREAM_URL = "http://10.0.0.69:8099/stream?token=abc";
    expect(noiseStreamUrl()).toBe("http://10.0.0.69:8099/stream?token=abc");
  });

  it("fails loudly when the sensor is missing (rest sensor not configured)", async () => {
    vi.mocked(getState).mockResolvedValue(null);
    await expect(noiseStatus()).rejects.toThrow(/not found/);
  });
});

describe("the commanded-stop mark (the sleep watcher's human/interference line)", () => {
  it("turn_off marks the stop; turn_on supersedes it (off-then-on leaves no stale mark)", async () => {
    expect(noiseStoppedAtMs()).toBeNull();
    await noiseTurnOff();
    expect(noiseStoppedAtMs()).not.toBeNull();
    // The Codex PR #100 scenario: on again before the next watcher tick —
    // a later uncommanded death must read as interference, not this off.
    await noiseTurnOn();
    expect(noiseStoppedAtMs()).toBeNull();
  });

  it("a stop that failed to send marks nothing", async () => {
    vi.mocked(callService).mockRejectedValueOnce(new Error("HA down"));
    await expect(noiseTurnOff()).rejects.toThrow("HA down");
    expect(noiseStoppedAtMs()).toBeNull();
  });
});
