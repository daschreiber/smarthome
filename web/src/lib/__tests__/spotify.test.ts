import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The client is stateful (module-level token cache), so each test gets a
 *  fresh module via resetModules + dynamic import. */

let dir: string;
let calls: { method: string; url: string; body?: string }[];
let handlers: Record<string, { status: number; json?: unknown }>;

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ method: init?.method ?? "GET", url: u, body: init?.body?.toString() });
      const hit = Object.entries(handlers).find(([prefix]) => u.startsWith(prefix));
      const res = hit ? hit[1] : { status: 404, json: {} };
      return {
        ok: res.status < 400,
        status: res.status,
        json: async () => res.json ?? {},
      } as Response;
    }),
  );
}

async function loadSpotify() {
  vi.resetModules();
  return await import("../spotify");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "spotify-test-"));
  process.env.SPOTIFY_CLIENT_ID = "cid";
  process.env.SPOTIFY_CLIENT_SECRET = "secret";
  process.env.SPOTIFY_TOKEN_PATH = path.join(dir, "token.json");
  delete process.env.SPOTIFY_DEFAULT_CONTEXT;
  fs.writeFileSync(process.env.SPOTIFY_TOKEN_PATH, JSON.stringify({ refresh_token: "r1" }));
  calls = [];
  handlers = {
    "https://accounts.spotify.com/api/token": {
      status: 200,
      json: { access_token: "a1", expires_in: 3600 },
    },
    "https://api.spotify.com/v1/me/player/devices": {
      status: 200,
      json: { devices: [{ id: "dev-kitchen", name: "Spotify C4 Kitchen", is_active: false }] },
    },
  };
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("roomDeviceName", () => {
  it("maps app rooms to the Core's Connect naming", async () => {
    const s = await loadSpotify();
    expect(s.roomDeviceName("Kitchen")).toBe("Spotify C4 Kitchen");
    expect(s.roomDeviceName("Balcony (6th)")).toBe("Spotify C4 Balcony");
    expect(s.roomDeviceName("Master Bedroom")).toBe("Spotify C4 MBR");
    expect(s.roomDeviceName("Sauna")).toBeNull();
  });
});

describe("playInRoom", () => {
  it("resumes playback on the room's device", async () => {
    handlers["https://api.spotify.com/v1/me/player/play"] = { status: 204 };
    const s = await loadSpotify();
    await expect(s.playInRoom("Kitchen")).resolves.toBe("Spotify C4 Kitchen");
    const play = calls.find((c) => c.url.includes("/me/player/play"));
    expect(play?.url).toContain("device_id=dev-kitchen");
    expect(play?.body).toBeUndefined(); // bare resume, no forced context
  });

  it("falls back to the configured default context when resume fails", async () => {
    process.env.SPOTIFY_DEFAULT_CONTEXT = "spotify:playlist:pl1";
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const u = String(url);
        calls.push({ method: init?.method ?? "GET", url: u, body: init?.body?.toString() });
        if (u.startsWith("https://accounts.spotify.com")) {
          return { ok: true, status: 200, json: async () => ({ access_token: "a1", expires_in: 3600 }) } as Response;
        }
        if (u.includes("/me/player/devices")) {
          return { ok: true, status: 200, json: async () => ({ devices: [{ id: "dev-kitchen", name: "Spotify C4 Kitchen", is_active: false }] }) } as Response;
        }
        // First play (bare resume) refused; second (with context) accepted.
        attempts += 1;
        return attempts === 1
          ? ({ ok: false, status: 404, json: async () => ({ error: { message: "No active device" } }) } as Response)
          : ({ ok: true, status: 204, json: async () => ({}) } as Response);
      }),
    );
    const s = await loadSpotify();
    await expect(s.playInRoom("Kitchen")).resolves.toBe("Spotify C4 Kitchen");
    const withContext = calls.filter((c) => c.url.includes("/me/player/play")).at(-1);
    expect(withContext?.body).toContain("spotify:playlist:pl1");
  });

  it("reports an invisible device instead of playing somewhere else", async () => {
    handlers["https://api.spotify.com/v1/me/player/devices"] = { status: 200, json: { devices: [] } };
    const s = await loadSpotify();
    await expect(s.playInRoom("Kitchen")).rejects.toThrow(/not visible/);
  });

  it("refuses rooms with no mapped endpoint", async () => {
    const s = await loadSpotify();
    await expect(s.playInRoom("Gym")).rejects.toThrow(/no Spotify endpoint/);
  });
});
