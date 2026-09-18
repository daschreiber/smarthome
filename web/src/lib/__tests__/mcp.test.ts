import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * The MCP server is exercised the way an agent uses it: a real MCP client
 * over an in-memory transport, tools/list and tools/call — with Home
 * Assistant and the sauna service mocked underneath the shared executor.
 */

// The sauna joins the registry only when its service is configured; set
// before the registry is first built (lazy), so the confirm rule is testable.
process.env.SAUNA_BASE_URL = "http://sauna.test";
process.env.SAUNA_API_TOKEN = "t";

const LOUNGE_COVE = "light.knx_dimmer_lounge_cove";
const LOUNGE_SPOTS = "light.knx_dimmer_lounge_spots";
const FRONT_DOOR = "lock.front_front_door";

type Fixture = { entity_id: string; state: string; attributes: Record<string, unknown>; last_updated: string; last_changed: string };
const st = (entity_id: string, state: string, attributes: Record<string, unknown> = {}): Fixture =>
  ({ entity_id, state, attributes, last_updated: "2026-09-18T10:00:00Z", last_changed: "2026-09-18T10:00:00Z" });

const fixtures = new Map<string, Fixture>([
  [LOUNGE_COVE, st(LOUNGE_COVE, "on", { brightness: 128 })],
  [LOUNGE_SPOTS, st(LOUNGE_SPOTS, "unavailable")],
  [FRONT_DOOR, st(FRONT_DOOR, "locked")],
]);

vi.mock("../ha", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ha")>();
  return {
    ...actual,
    callService: vi.fn(async () => {}),
    getStates: vi.fn(async () => [...fixtures.values()]),
    // Entities outside the fixture read "unknown" (commandable), never
    // null (gone from HA), so only the fixture decides reachability.
    getState: vi.fn(async (id: string) => fixtures.get(id) ?? st(id, "unknown")),
  };
});
vi.mock("../audit", () => ({ audit: vi.fn() }));
vi.mock("../sauna", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sauna")>();
  return {
    ...actual,
    saunaStart: vi.fn(async () => ({ message: "started", verified: true, stopAt: null })),
    saunaStop: vi.fn(async () => ({ message: "stopped", verified: true })),
    saunaStatus: vi.fn(async () => ({ poweredOn: false, connected: true, currentTemperature: 22, selectedTemperature: 80 })),
  };
});

import { callService } from "../ha";
import { audit } from "../audit";
import { saunaStart } from "../sauna";
import { authenticateMcp, compactDevice, createHouseMcpServer, resolveRoom, type McpCaller } from "../mcp";
import { getDevice, registry } from "../registry";
import { createScene } from "../scenes";

const calls = vi.mocked(callService);
const audits = vi.mocked(audit);

const deviceIdFor = (entityId: string) => registry().devices.find((d) => d.entityId === entityId)!.id;

async function connect(caller: McpCaller = { user: "mcp", role: "guest" }): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createHouseMcpServer(caller).connect(serverSide);
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(clientSide);
  return client;
}

type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result;
}
const text = (r: Result) => r.content.map((c) => c.text ?? "").join("");
const json = (r: Result) => JSON.parse(text(r));

beforeEach(() => {
  calls.mockClear();
  audits.mockClear();
  vi.mocked(saunaStart).mockClear();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
  process.env.SCENES_PATH = path.join(dir, "scenes.json");
  delete process.env.MCP_TOKEN;
  delete process.env.APP_KEY;
});

/** Minimal stand-in for what authenticateMcp reads off a request. */
function req(opts: { bearer?: string; appKey?: string } = {}): NextRequest {
  return {
    cookies: { get: () => undefined },
    headers: {
      get: (name: string) => {
        const n = name.toLowerCase();
        if (n === "authorization") return opts.bearer !== undefined ? `Bearer ${opts.bearer}` : null;
        if (n === "x-app-key") return opts.appKey ?? null;
        return null;
      },
    },
  } as unknown as NextRequest;
}

describe("authenticateMcp", () => {
  it("the MCP token answers as the guest principal 'mcp'", () => {
    process.env.MCP_TOKEN = "secret-token";
    expect(authenticateMcp(req({ bearer: "secret-token" }))).toEqual({ user: "mcp", role: "guest" });
  });

  it("a wrong or unconfigured bearer is refused and never falls through", () => {
    process.env.MCP_TOKEN = "secret-token";
    process.env.APP_KEY = "k";
    expect(authenticateMcp(req({ bearer: "nope", appKey: "k" }))).toBeNull();
    delete process.env.MCP_TOKEN;
    expect(authenticateMcp(req({ bearer: "secret-token", appKey: "k" }))).toBeNull();
  });

  it("without a bearer, the app's own auth applies", () => {
    process.env.APP_KEY = "k";
    expect(authenticateMcp(req({ appKey: "k" }))).toEqual({ user: "app-key", role: "admin" });
    expect(authenticateMcp(req({ appKey: "wrong" }))).toBeNull();
  });
});

describe("resolveRoom", () => {
  it("canonical names, synonyms, and unique fragments resolve; ambiguity names the candidates", () => {
    expect(resolveRoom("lounge")).toEqual({ room: "Lounge" });
    expect(resolveRoom("living room")).toEqual({ room: "Lounge" });
    expect(resolveRoom("MBR")).toEqual({ room: "Master Bedroom" });
    expect(resolveRoom("kitch")).toEqual({ room: "Kitchen" });
    const balcony = resolveRoom("balcony");
    expect("error" in balcony && balcony.error).toMatch(/several rooms/);
    const nope = resolveRoom("attic");
    expect("error" in nope && nope.error).toMatch(/unknown room/);
  });
});

describe("the tool surface", () => {
  it("offers reads and controls — nothing programmable, nothing security-tier", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["activate_scene", "control_device", "get_home_state", "list_rooms", "list_scenes", "set_room_lights"]);
  });

  it("list_rooms knows the house and its synonyms", async () => {
    const client = await connect();
    const { rooms } = json(await call(client, "list_rooms"));
    const lounge = rooms.find((r: { room: string }) => r.room === "Lounge");
    expect(lounge.floor).toBe(6);
    expect(lounge.kinds.light).toBeGreaterThan(3);
    expect(lounge.aliases).toContain("living room");
    expect(rooms.map((r: { room: string }) => r.room)).toContain("Kitchen");
  });
});

describe("get_home_state", () => {
  it("returns live state, compacted, and never the door locks", async () => {
    const client = await connect();
    const home = json(await call(client, "get_home_state"));
    const cove = home.devices.find((d: { id: string }) => d.id === deviceIdFor(LOUNGE_COVE));
    expect(cove).toMatchObject({ label: "Lounge Cove", room: "Lounge", state: "on", brightnessPct: 50 });
    expect(cove).not.toHaveProperty("unreachable");
    expect(cove).not.toHaveProperty("hvacMode");
    const spots = home.devices.find((d: { id: string }) => d.id === deviceIdFor(LOUNGE_SPOTS));
    expect(spots).toMatchObject({ state: "unavailable", available: false, unreachable: true });
    expect(home.devices.some((d: { kind: string }) => d.kind === "lock")).toBe(false);
    expect(home.devices.some((d: { id: string }) => d.id === deviceIdFor(FRONT_DOOR))).toBe(false);
    expect(home.houseTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("advertises only ids control_device accepts — never the display-only placeholders", async () => {
    // The bed and white noise are unconfigured here, so the snapshot carries
    // their placeholder cards; they are not registry devices.
    const client = await connect();
    const home = json(await call(client, "get_home_state"));
    const ids: string[] = home.devices.map((d: { id: string }) => d.id);
    expect(ids).not.toContain("master_bedroom__bed");
    expect(ids).not.toContain("master_bedroom__white_noise");
    for (const id of ids) expect(getDevice(id), id).toBeDefined();
    for (const id of ids) expect(getDevice(id)!.visible, id).toBe(true);
  });

  it("filters by room, through a synonym", async () => {
    const client = await connect();
    const home = json(await call(client, "get_home_state", { room: "living room" }));
    expect(home.room).toBe("Lounge");
    expect(home.devices.length).toBeGreaterThan(3);
    for (const d of home.devices) expect(d.room).toBe("Lounge");
  });

  it("an unknown room is an error that lists the rooms", async () => {
    const client = await connect();
    const r = await call(client, "get_home_state", { room: "attic" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Lounge/);
  });
});

describe("control_device", () => {
  it("turns a light on through the shared executor and audits it under the caller", async () => {
    const client = await connect();
    const id = deviceIdFor(LOUNGE_COVE);
    const r = json(await call(client, "control_device", { deviceId: id, command: "set_brightness", value: 40 }));
    expect(r.status).toBe("sent");
    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls.mock.calls[0].slice(0, 3)).toEqual(["light", "turn_on", { entity_id: LOUNGE_COVE, brightness_pct: 40 }]);
    expect(audits).toHaveBeenCalledTimes(1);
    expect(audits.mock.calls[0][0]).toMatchObject({
      user: "mcp", deviceId: id, command: "set_brightness", ok: true, args: { brightnessPct: 40, via: "mcp" },
    });
  });

  it("refuses an unavailable device instead of reporting 'sent' over it", async () => {
    const client = await connect();
    const r = await call(client, "control_device", { deviceId: deviceIdFor(LOUNGE_SPOTS), command: "turn_on" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not responding/);
    expect(calls).not.toHaveBeenCalled();
    expect(audits.mock.calls[0][0]).toMatchObject({ ok: false, user: "mcp" });
  });

  it("the door lock is not a device here, by its id or otherwise", async () => {
    const client = await connect();
    const r = await call(client, "control_device", { deviceId: deviceIdFor(FRONT_DOOR), command: "turn_on" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/unknown device/);
    expect(calls).not.toHaveBeenCalled();
  });

  it("validates like the command layer: missing values, unsupported commands, out-of-range setpoints", async () => {
    const client = await connect();
    const cove = deviceIdFor(LOUNGE_COVE);
    const noValue = await call(client, "control_device", { deviceId: cove, command: "set_brightness" });
    expect(noValue.isError).toBe(true);
    expect(text(noValue)).toMatch(/needs a value/);
    expect(text(noValue)).toMatch(/Accepted: turn_on, turn_off; set_brightness/);
    const wrongKind = await call(client, "control_device", { deviceId: cove, command: "open" });
    expect(wrongKind.isError).toBe(true);
    expect(text(wrongKind)).toMatch(/does not support open/);
    const zone = deviceIdFor("climate.ac_heating_a_c_daniel_s_study");
    const tooHot = await call(client, "control_device", { deviceId: zone, command: "set_temperature", value: 35 });
    expect(tooHot.isError).toBe(true);
    expect(text(tooHot)).toMatch(/out of range 10-32/);
    expect(calls).not.toHaveBeenCalled();
    // Schema-level rejection (an unknown command) is the protocol's error, not ours.
    const unknown = await call(client, "control_device", { deviceId: cove, command: "explode" });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/Input validation error/);
  });

  it("the sauna heater waits for the person's explicit confirmation", async () => {
    const client = await connect();
    const refused = await call(client, "control_device", { deviceId: "sauna__klafs_sauna", command: "turn_on" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/confirm: true/);
    expect(saunaStart).not.toHaveBeenCalled();
    const went = json(await call(client, "control_device", { deviceId: "sauna__klafs_sauna", command: "turn_on", confirm: true }));
    expect(went.status).toBe("sent");
    expect(saunaStart).toHaveBeenCalledTimes(1);
    expect(calls).not.toHaveBeenCalled(); // never Home Assistant
  });
});

describe("set_room_lights", () => {
  it("sweeps the room's real lights and nothing else", async () => {
    const client = await connect();
    const r = json(await call(client, "set_room_lights", { room: "living room", state: "off" }));
    expect(r.room).toBe("Lounge");
    expect(r.status).toBe("sent");
    expect(r.lights.length).toBeGreaterThan(3);
    expect(calls).toHaveBeenCalledTimes(r.lights.length);
    for (const c of calls.mock.calls) expect([c[0], c[1]]).toEqual(["light", "turn_off"]);
    expect(audits.mock.calls[0][0]).toMatchObject({ user: "mcp", command: "lights_off", ok: true, args: { room: "Lounge" } });
  });

  it("rejects a room it cannot resolve", async () => {
    const client = await connect();
    const r = await call(client, "set_room_lights", { room: "balcony", state: "on" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/several rooms/);
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("scenes", () => {
  it("lists saved scenes and applies one by id", async () => {
    const scene = createScene("Cozy", "Lounge", "daniel", [
      { deviceId: deviceIdFor(LOUNGE_COVE), command: { command: "set_brightness", brightnessPct: 20 } },
    ]);
    const client = await connect();
    const listed = json(await call(client, "list_scenes"));
    expect(listed.scenes).toEqual([{ id: scene.id, name: "Cozy", room: "Lounge", devices: 1, includesSauna: false }]);
    const applied = json(await call(client, "activate_scene", { sceneId: scene.id }));
    expect(applied.status).toBe("sent");
    expect(calls.mock.calls[0].slice(0, 3)).toEqual(["light", "turn_on", { entity_id: LOUNGE_COVE, brightness_pct: 20 }]);
    expect(audits.mock.calls[0][0]).toMatchObject({ user: "mcp", command: "apply_scene", entityId: `scene.${scene.id}` });
  });

  it("an unknown scene is an error, not a silent no-op", async () => {
    const client = await connect();
    const r = await call(client, "activate_scene", { sceneId: "nope" });
    expect(r.isError).toBe(true);
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("compactDevice", () => {
  it("drops nulls and the false-by-default flags", () => {
    const out = compactDevice({
      id: "x", label: "X", room: "Den", floor: 5, group: "Lighting", kind: "light", category: "light_dimmer",
      capabilities: ["on_off"], requiresConfirmation: false, state: "off", available: true, unreachable: false,
      brightnessPct: null, currentTemperature: null, targetTemperature: null, hvacMode: null, lastUpdated: null, note: null,
    } as unknown as Parameters<typeof compactDevice>[0]);
    expect(out).toEqual({ id: "x", label: "X", room: "Den", floor: 5, kind: "light", category: "light_dimmer", capabilities: ["on_off"], state: "off", available: true });
  });
});
