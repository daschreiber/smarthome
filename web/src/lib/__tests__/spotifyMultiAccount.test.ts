import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The per-user half of the Spotify integration: two household accounts
 * playing in two rooms at once, which the single house login could never do
 * (Spotify allows one session per account, not per house).
 *
 * The client is stateful (module-level token caches), so each test gets a
 * fresh module via resetModules + dynamic import.
 */

let dir: string;
let calls: Array<{ method: string; url: string; auth: string; body?: string }>;

/** Sessions keyed by access token, so each account sees its own player. */
let sessions: Record<string, unknown>;
/** Devices keyed by access token. */
let devices: Record<string, Array<{ id: string; name: string; is_active: boolean }>>;

const C4_DEVICES = [
  { id: "dev-kitchen", name: "Spotify C4 Kitchen", is_active: false },
  { id: "dev-lounge", name: "Spotify C4 Lounge", is_active: false },
];

function session(track: string, deviceName: string) {
  return {
    is_playing: true,
    item: { name: track, artists: [{ name: "Someone" }], album: { images: [{ url: "a.jpg", width: 64 }] } },
    device: { name: deviceName },
  };
}

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = headers.Authorization ?? "";
      const body = init?.body?.toString();
      calls.push({ method: init?.method ?? "GET", url: u, auth, body });
      const ok = (json: unknown, status = 200) =>
        ({ ok: status < 400, status, json: async () => json }) as Response;

      if (u.startsWith("https://accounts.spotify.com/api/token")) {
        // Each refresh token mints its own access token, which is how the
        // rest of the mock tells the accounts apart.
        const refresh = new URLSearchParams(body ?? "").get("refresh_token") ?? "";
        return ok({ access_token: `access-${refresh}`, expires_in: 3600 });
      }
      const token = auth.replace("Bearer ", "");
      if (u.includes("/me/player/devices")) return ok({ devices: devices[token] ?? C4_DEVICES });
      if (u.includes("/me/player/play")) return ok({}, 204);
      if (u.endsWith("/v1/me/player")) {
        if (init?.method === "PUT") return ok({}, 204);
        const s = sessions[token];
        return s ? ok(s) : ok(null, 204);
      }
      if (u.endsWith("/v1/me")) return ok({ display_name: "Someone", product: "premium" });
      return ok({}, 404);
    }),
  );
}

async function load() {
  vi.resetModules();
  return {
    spotify: await import("../spotify"),
    accounts: await import("../spotifyAccounts"),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "spotify-multi-"));
  process.env.SPOTIFY_CLIENT_ID = "cid";
  process.env.SPOTIFY_CLIENT_SECRET = "secret";
  process.env.SPOTIFY_TOKEN_PATH = path.join(dir, "token.json");
  process.env.SPOTIFY_LINKS_PATH = path.join(dir, "links.json");
  delete process.env.SPOTIFY_DEFAULT_CONTEXT;
  fs.writeFileSync(process.env.SPOTIFY_TOKEN_PATH, JSON.stringify({ refresh_token: "r-house" }));
  calls = [];
  sessions = {};
  devices = {};
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("account resolution", () => {
  it("plays as the user's own account once they've linked one", async () => {
    const { accounts } = await load();
    expect(accounts.accountFor("ruth@example.com")).toBe("house");
    accounts.saveLink({ user: "ruth@example.com", refreshToken: "r-ruth", displayName: "Ruth", premium: true });
    expect(accounts.accountFor("ruth@example.com")).toBe("user:ruth@example.com");
    // Everyone else still falls back to the house account.
    expect(accounts.accountFor("guest@example.com")).toBe("house");
  });

  it("falls back to nothing at all when no account is linked", async () => {
    fs.rmSync(process.env.SPOTIFY_TOKEN_PATH!);
    const { accounts } = await load();
    expect(accounts.accountFor("ruth@example.com")).toBeNull();
  });

  it("holds Spotify's five-account ceiling and says how to clear it", async () => {
    const { accounts } = await load();
    for (let i = 0; i < accounts.MAX_LINKED_USERS; i += 1) {
      accounts.saveLink({ user: `u${i}@example.com`, refreshToken: `r${i}`, displayName: `U${i}`, premium: true });
    }
    expect(() =>
      accounts.saveLink({ user: "late@example.com", refreshToken: "rx", displayName: "Late", premium: true }),
    ).toThrow(/unlink first|disconnect/i);
    // Re-linking someone who already has a slot is always allowed.
    expect(() =>
      accounts.saveLink({ user: "u0@example.com", refreshToken: "new", displayName: "U0", premium: true }),
    ).not.toThrow();
    expect(accounts.getLink("u0@example.com")?.refreshToken).toBe("new");
  });

  it("labels an account by its Spotify display name", async () => {
    const { accounts } = await load();
    accounts.saveLink({ user: "ruth@example.com", refreshToken: "r-ruth", displayName: "Ruth", premium: true });
    expect(accounts.accountLabel(accounts.userKey("ruth@example.com"))).toBe("Ruth's Spotify");
    expect(accounts.accountLabel("house")).toBe("the house Spotify");
  });
});

describe("playing as different accounts", () => {
  it("sends each account's own token, so two rooms play at once", async () => {
    const { spotify, accounts } = await load();
    accounts.saveLink({ user: "ruth@example.com", refreshToken: "r-ruth", displayName: "Ruth", premium: true });

    await spotify.playInRoom("Lounge", "house");
    await spotify.playInRoom("Kitchen", accounts.userKey("ruth@example.com"));

    const plays = calls.filter((c) => c.url.includes("/me/player/play"));
    expect(plays).toHaveLength(2);
    expect(plays[0].url).toContain("device_id=dev-lounge");
    expect(plays[0].auth).toBe("Bearer access-r-house");
    expect(plays[1].url).toContain("device_id=dev-kitchen");
    expect(plays[1].auth).toBe("Bearer access-r-ruth");
  });

  it("reports every room with a session, and whose it is", async () => {
    const { spotify, accounts } = await load();
    accounts.saveLink({ user: "ruth@example.com", refreshToken: "r-ruth", displayName: "Ruth", premium: true });
    sessions["access-r-house"] = session("Hey Jude", "Spotify C4 Lounge");
    sessions["access-r-ruth"] = session("Levitating", "Spotify C4 Kitchen");

    const rooms = await spotify.roomSessions();
    expect(rooms.map((r) => [r.room, r.track, r.who])).toEqual([
      ["Lounge", "Hey Jude", "the house Spotify"],
      ["Kitchen", "Levitating", "Ruth's Spotify"],
    ]);
  });

  it("keeps one account's failure from hiding the others", async () => {
    const { spotify, accounts } = await load();
    accounts.saveLink({ user: "ruth@example.com", refreshToken: "r-ruth", displayName: "Ruth", premium: true });
    sessions["access-r-ruth"] = session("Levitating", "Spotify C4 Kitchen");
    // The house token has been revoked at Spotify.
    fs.writeFileSync(process.env.SPOTIFY_TOKEN_PATH!, JSON.stringify({ refresh_token: "" }));

    const rooms = await spotify.roomSessions();
    expect(rooms.map((r) => r.room)).toEqual(["Kitchen"]);
  });
});

describe("device resolution", () => {
  it("finds a zone the Core has renamed, instead of giving up", async () => {
    // Composer renames happen; the app shouldn't lose the room over one.
    devices["access-r-house"] = [{ id: "dev-terrace", name: "Terrace", is_active: false }];
    const { spotify } = await load();
    await expect(spotify.playInRoom("Terrace")).resolves.toBe("Terrace");
  });

  it("matches the Core's abbreviations for the master bedroom", async () => {
    devices["access-r-house"] = [{ id: "dev-mbr", name: "Spotify C4 MBR", is_active: false }];
    const { spotify } = await load();
    await expect(spotify.playInRoom("Master Bedroom")).resolves.toBe("Spotify C4 MBR");
  });

  it("names the devices Spotify CAN see when the room's isn't there", async () => {
    // This is the Terrace diagnosis: the error has to carry enough to act on.
    devices["access-r-house"] = [{ id: "dev-kitchen", name: "Spotify C4 Kitchen", is_active: false }];
    const { spotify } = await load();
    await expect(spotify.playInRoom("Terrace")).rejects.toThrow(
      /not visible.*Spotify can see: Spotify C4 Kitchen/s,
    );
  });

  it("says so plainly when the account sees no devices at all", async () => {
    devices["access-r-house"] = [];
    const { spotify } = await load();
    await expect(spotify.playInRoom("Terrace")).rejects.toThrow(/no Spotify devices at all/);
  });

  it("never claims a room for a device that isn't a matrix zone", async () => {
    const { spotify } = await load();
    // The Sonos and the Yamahas are real Connect devices in other rooms.
    expect(spotify.deviceRoom("Gym")).toBeNull();
    expect(spotify.deviceRoom("Spotify C4 Kitchen")).toBe("Kitchen");
  });
});

describe("hand-off", () => {
  it("transfers the account to the room's device without forcing play", async () => {
    const { spotify, accounts } = await load();
    accounts.saveLink({ user: "ruth@example.com", refreshToken: "r-ruth", displayName: "Ruth", premium: true });
    const device = await spotify.transferToRoom("Kitchen", accounts.userKey("ruth@example.com"));
    expect(device).toBe("Spotify C4 Kitchen");
    const transfer = calls.find((c) => c.method === "PUT" && c.url.endsWith("/v1/me/player"));
    expect(transfer?.auth).toBe("Bearer access-r-ruth");
    expect(JSON.parse(transfer!.body!)).toEqual({ device_ids: ["dev-kitchen"], play: false });
  });

  it("keeps the music going when it was already playing", async () => {
    const { spotify } = await load();
    await spotify.transferToRoom("Kitchen", "house", true);
    const transfer = calls.find((c) => c.method === "PUT" && c.url.endsWith("/v1/me/player"));
    expect(JSON.parse(transfer!.body!).play).toBe(true);
  });
});

describe("token rotation", () => {
  it("writes a rotated refresh token back to the right store", async () => {
    const { spotify, accounts } = await load();
    accounts.saveLink({ user: "ruth@example.com", refreshToken: "r-ruth", displayName: "Ruth", premium: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.startsWith("https://accounts.spotify.com")) {
          return { ok: true, status: 200, json: async () => ({ access_token: "a", expires_in: 3600, refresh_token: "rotated" }) } as Response;
        }
        if (u.includes("/me/player/devices")) {
          return { ok: true, status: 200, json: async () => ({ devices: C4_DEVICES }) } as Response;
        }
        return { ok: true, status: 204, json: async () => ({}) } as Response;
      }),
    );
    await spotify.playInRoom("Kitchen", accounts.userKey("ruth@example.com"));
    expect(accounts.getLink("ruth@example.com")?.refreshToken).toBe("rotated");
    // …and the house token is untouched by someone else's rotation.
    expect(accounts.houseRefreshToken()).toBe("r-house");
  });
});
