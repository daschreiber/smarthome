import crypto from "node:crypto";
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
import { createAutomation, listAutomations } from "../automations";
import { createTimer, listTimers } from "../timers";
import { exchangeCode, issueCode, registerClient, validateAuthorizeRequest, type ValidAuthorize } from "../oauth";
import { addUser } from "../users";

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
  process.env.AUTOMATIONS_PATH = path.join(dir, "automations.json");
  process.env.TIMERS_PATH = path.join(dir, "timers.json");
  process.env.OAUTH_PATH = path.join(dir, "oauth.json");
  process.env.USERS_PATH = path.join(dir, "users.json");
  process.env.APP_BASE_URL = "https://house.test";
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

  it("an OAuth access token answers as the person who consented, with their role", async () => {
    addUser("ruth@example.com", "password1", "member");
    const reg = registerClient({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    if (!reg.ok) throw new Error(reg.description);
    const verifier = "v".repeat(43);
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const v = validateAuthorizeRequest({
      client_id: reg.client.client_id, redirect_uri: reg.client.redirect_uris[0], response_type: "code",
      code_challenge: challenge, code_challenge_method: "S256",
    }) as ValidAuthorize;
    const code = issueCode(v, "ruth@example.com");
    const ex = exchangeCode({ code, client_id: reg.client.client_id, redirect_uri: v.redirect_uri, code_verifier: verifier });
    if (!ex.ok) throw new Error(ex.description);
    expect(authenticateMcp(req({ bearer: ex.tokens.access_token }))).toEqual({ user: "ruth@example.com", role: "member" });
    expect(authenticateMcp(req({ bearer: ex.tokens.refresh_token }))).toBeNull();
    // The shared token, when set, still answers as the guest — and neither road leaks into the other.
    process.env.MCP_TOKEN = "shared";
    expect(authenticateMcp(req({ bearer: "shared" }))).toEqual({ user: "mcp", role: "guest" });
    expect(authenticateMcp(req({ bearer: ex.tokens.access_token }))).toEqual({ user: "ruth@example.com", role: "member" });

    // And the audit line carries the person, not "mcp".
    const client = await connect({ user: "ruth@example.com", role: "member" });
    await call(client, "control_device", { deviceId: deviceIdFor(LOUNGE_COVE), command: "turn_off" });
    expect(audits.mock.calls[0][0]).toMatchObject({ user: "ruth@example.com", command: "turn_off" });
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
    expect(names).toEqual([
      "activate_scene", "control_device", "create_automation", "create_timer", "delete_automation", "delete_timer",
      "get_home_state", "list_automations", "list_rooms", "list_scenes", "list_timers", "set_automation_enabled",
      "set_room_lights", "update_automation",
    ]);
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

describe("automations", () => {
  it("creates a clock-and-sun schedule from the agent's shape, resolving rooms through synonyms", async () => {
    const client = await connect();
    const cove = deviceIdFor(LOUNGE_COVE);
    const r = json(await call(client, "create_automation", {
      name: "Evening lounge",
      steps: [
        { time: "16:00", days: [1, 2, 3, 4, 5], actions: [{ type: "room", room: "living room", command: "lights_on" }] },
        { sun: "sunset", sunOffsetMinutes: -15, actions: [{ type: "device", deviceId: cove, command: "set_brightness", value: 30 }] },
        { time: "23:00", date: "2026-12-24", actions: [{ type: "room", room: "Lounge", command: "lights_off" }] },
      ],
    }));
    expect(r.ok).toBe(true);
    expect(r.automation).toMatchObject({ id: "evening_lounge", enabled: true, createdBy: "mcp", editable: true, activeWhen: "always" });
    const stored = listAutomations()[0];
    expect(stored.steps).toEqual([
      { time: "16:00", days: [1, 2, 3, 4, 5], actions: [{ type: "room", room: "Lounge", command: "lights_on" }] },
      { sun: "sunset", sunOffsetMinutes: -15, actions: [{ type: "device", deviceId: cove, command: { command: "set_brightness", brightnessPct: 30 } }] },
      { time: "23:00", date: "2026-12-24", actions: [{ type: "room", room: "Lounge", command: "lights_off" }] },
    ]);
    expect(audits.mock.calls[0][0]).toMatchObject({ user: "mcp", command: "create_automation", entityId: "automation.evening_lounge", ok: true });
    const listed = json(await call(client, "list_automations"));
    expect(listed.automations).toHaveLength(1);
    expect(listed.houseTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("refuses what the app refuses: no trigger, two triggers, bad times, unknown rooms, the lock, the sauna, unknown scenes", async () => {
    const client = await connect();
    const cove = deviceIdFor(LOUNGE_COVE);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ actions: [{ type: "device", deviceId: cove, command: "turn_on", value: null }] }, /exactly one trigger/],
      [{ time: "07:00", sun: "sunrise", actions: [{ type: "device", deviceId: cove, command: "turn_on", value: null }] }, /exactly one trigger/],
      [{ time: "25:00", actions: [{ type: "device", deviceId: cove, command: "turn_on", value: null }] }, /HH:MM/],
      [{ time: "07:00", actions: [{ type: "room", room: "attic", command: "lights_on" }] }, /unknown room/],
      [{ time: "07:00", actions: [{ type: "device", deviceId: deviceIdFor(FRONT_DOOR), command: "turn_on", value: null }] }, /unknown device/],
      [{ time: "07:00", actions: [{ type: "device", deviceId: "sauna__klafs_sauna", command: "turn_on", value: null }] }, /safety-sensitive/],
      [{ time: "07:00", actions: [{ type: "device", deviceId: cove, command: "open", value: null }] }, /does not support open/],
      [{ time: "07:00", actions: [{ type: "scene", sceneId: "nope" }] }, /unknown scene/],
    ];
    for (const [step, want] of cases) {
      const r = await call(client, "create_automation", { name: "Bad", steps: [step] });
      expect(r.isError, JSON.stringify(step)).toBe(true);
      expect(text(r), JSON.stringify(step)).toMatch(want);
    }
    expect(listAutomations()).toHaveLength(0);
  });

  it("edits and deletes only its own; pauses anyone's", async () => {
    const theirs = createAutomation({ name: "Theirs", steps: [{ time: "08:00", actions: [{ type: "room", room: "Lounge", command: "lights_on" }] }] }, "daniel");
    const client = await connect();
    const mine = json(await call(client, "create_automation", {
      name: "Mine", steps: [{ time: "09:00", actions: [{ type: "room", room: "Lounge", command: "lights_off" }] }],
    })).automation;
    const listed = json(await call(client, "list_automations")).automations;
    expect(listed.map((a: { id: string; editable: boolean }) => [a.id, a.editable])).toEqual([[theirs.id, false], [mine.id, true]]);

    const denied = await call(client, "delete_automation", { id: theirs.id });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/created by daniel/);
    const deniedEdit = await call(client, "update_automation", { id: theirs.id, name: "X", steps: [{ time: "10:00", actions: [{ type: "room", room: "Lounge", command: "lights_on" }] }] });
    expect(deniedEdit.isError).toBe(true);

    const paused = json(await call(client, "set_automation_enabled", { id: theirs.id, enabled: false }));
    expect(paused).toMatchObject({ ok: true, enabled: false });
    expect(listAutomations().find((a) => a.id === theirs.id)!.enabled).toBe(false);

    const edited = json(await call(client, "update_automation", { id: mine.id, name: "Mine v2", steps: [{ sun: "sunrise", actions: [{ type: "room", room: "Lounge", command: "lights_off" }] }] }));
    expect(edited.automation).toMatchObject({ id: mine.id, name: "Mine v2", steps: [{ sun: "sunrise", actions: [{ type: "room", room: "Lounge", command: "lights_off" }] }] });

    const gone = json(await call(client, "delete_automation", { id: mine.id }));
    expect(gone.ok).toBe(true);
    expect(listAutomations().map((a) => a.id)).toEqual([theirs.id]);
  });
});

describe("timers", () => {
  it("creates, lists, and deletes an auto-off timer; refuses the bed, the lock, and other people's", async () => {
    const client = await connect();
    const cove = deviceIdFor(LOUNGE_COVE);
    const made = json(await call(client, "create_timer", { deviceId: cove, afterMinutes: 30 }));
    expect(made.timer).toMatchObject({ deviceId: cove, device: "Lounge Cove", room: "Lounge", afterMinutes: 30 });
    expect(audits.mock.calls[0][0]).toMatchObject({ user: "mcp", command: "create_timer", deviceId: cove, args: { afterMinutes: 30, via: "mcp" } });

    const again = await call(client, "create_timer", { deviceId: cove, afterMinutes: 10 });
    expect(again.isError).toBe(true);
    expect(text(again)).toMatch(/already has a timer/);
    const lock = await call(client, "create_timer", { deviceId: deviceIdFor(FRONT_DOOR), afterMinutes: 10 });
    expect(text(lock)).toMatch(/unknown device/);
    const sauna = await call(client, "create_timer", { deviceId: "sauna__klafs_sauna", afterMinutes: 10 });
    expect(text(sauna)).toMatch(/manages its own runtime/);

    const theirs = createTimer(deviceIdFor(LOUNGE_SPOTS), 5, "daniel");
    const listed = json(await call(client, "list_timers")).timers;
    expect(listed.map((t: { id: string; editable: boolean }) => [t.id, t.editable])).toEqual([[made.timer.id, true], [theirs.id, false]]);

    const denied = await call(client, "delete_timer", { id: theirs.id });
    expect(denied.isError).toBe(true);
    const gone = json(await call(client, "delete_timer", { id: made.timer.id }));
    expect(gone.ok).toBe(true);
    expect(listTimers().map((t) => t.id)).toEqual([theirs.id]);
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
