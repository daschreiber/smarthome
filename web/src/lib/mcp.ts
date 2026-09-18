import crypto from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NextRequest } from "next/server";
import { DEVICE_COMMANDS, loadAliases, toCommand } from "./assistant";
import { audit } from "./audit";
import { authenticate } from "./auth";
import { nowParts } from "./automations";
import { assertCommandAllowed, temperatureBounds, type Command } from "./commands";
import { applySceneById, executeAction, executeOnDevice, followArtFrames, roomLights } from "./execute";
import { getState } from "./ha";
import { homeSnapshot, type HomeDevice } from "./homeSnapshot";
import { commandEntityIds, deviceUnreachable } from "./reachability";
import { getDevice, registry, slug, type Device } from "./registry";
import { getScene, listScenes } from "./scenes";
import type { Role } from "./users";

/**
 * The house as an MCP server (Model Context Protocol) — the app's own
 * command layer offered to outside agents (Claude Code, Claude Desktop,
 * anything that speaks MCP over Streamable HTTP), served from
 * `POST /api/mcp`.
 *
 * This is the third caller of the command layer, after the UI and the
 * in-app assistant, and it gets exactly what they get: app device ids,
 * typed commands, per-kind bounds, the shared executor (lib/execute), and
 * an audit line per action. Nothing here talks to Home Assistant directly.
 *
 * Trust: an agent holding the MCP token is a GUEST of the house. It can
 * read state, command devices, and run scenes; it cannot program
 * (scenes/automations), operate the door locks (not even see them), or
 * read the activity log. The sauna heater still needs a human's explicit
 * go-ahead relayed as `confirm: true`. Locks stay out of the vocabulary
 * entirely, as they do for the assistant (lib/assistant buildSystemPrompt).
 */

export interface McpCaller {
  user: string;
  role: Role;
}

/** Set MCP_TOKEN to open the endpoint to token-bearing agents. */
export function mcpConfigured(): boolean {
  return Boolean(process.env.MCP_TOKEN);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Who is calling the MCP endpoint. `Authorization: Bearer <MCP_TOKEN>` is
 * the agent road and answers as the guest principal "mcp"; a presented
 * bearer that doesn't match (or with no MCP_TOKEN configured) is refused
 * outright — it never falls through to the cookie. Without a bearer, the
 * app's ordinary auth applies (a signed-in session, or x-app-key), so a
 * browser-side or app-key client works too, as itself.
 */
export function authenticateMcp(req: NextRequest): McpCaller | null {
  const header = (req.headers.get("authorization") ?? "").trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer) {
    const token = process.env.MCP_TOKEN;
    if (token && safeEqual(bearer[1].trim(), token)) return { user: "mcp", role: "guest" };
    return null;
  }
  const auth = authenticate(req);
  return auth.ok ? { user: auth.user, role: auth.role } : null;
}

/** Devices an agent may know about: visible, and never the security tier. */
function agentVisible(d: Device): boolean {
  return d.visible && d.kind !== "lock";
}

/**
 * The snapshot also carries display-only placeholder cards for features not
 * yet configured (bed, noise, vacuums, lock) that are NOT registry devices —
 * ids control_device would reject. The agent only ever sees ids it can
 * act on, so a snapshot row counts only when the registry has it (Codex
 * review, PR #131).
 */
function agentDevice(row: { id: string }): Device | undefined {
  const d = getDevice(row.id);
  return d && agentVisible(d) ? d : undefined;
}

/** Canonical room names, in entity-map order, from agent-visible devices. */
export function agentRooms(): string[] {
  return [...new Set(registry().devices.filter(agentVisible).map((d) => d.room).filter(Boolean))];
}

/**
 * Resolve what an agent called a room to a canonical room name: exact
 * (case-insensitive), then the owner's alias list (data/room_aliases.json),
 * then a unique substring match. Ambiguity is an error with the candidates
 * named, never a guess — the assistant's rule, applied here.
 */
export function resolveRoom(input: string): { room: string } | { error: string } {
  const rooms = agentRooms();
  const wanted = input.trim().toLowerCase();
  if (!wanted) return { error: "room is required" };
  const exact = rooms.find((r) => r.toLowerCase() === wanted);
  if (exact) return { room: exact };
  for (const [room, aliases] of Object.entries(loadAliases())) {
    if (rooms.includes(room) && aliases.some((a) => a.toLowerCase() === wanted)) return { room };
  }
  const partial = rooms.filter((r) => r.toLowerCase().includes(wanted));
  if (partial.length === 1) return { room: partial[0] };
  if (partial.length > 1) {
    return { error: `"${input}" matches several rooms: ${partial.join(", ")} — say which one` };
  }
  return { error: `unknown room "${input}"; rooms are: ${rooms.join(", ")}` };
}

/** The fields worth an agent's context, nulls dropped. */
const DEVICE_FIELDS = [
  "id", "label", "room", "floor", "kind", "category", "capabilities",
  "state", "available", "unreachable", "requiresConfirmation", "note",
  "brightnessPct", "currentTemperature", "targetTemperature", "hvacMode",
  "fanSpeed", "fanSpeedList", "batteryPct", "source", "sourceList",
  "mediaTitle", "volumePct", "bedPresence", "bedPresenceSince",
  "noiseType", "stopAt", "unverifiedAt", "lastUpdated",
] as const;

export function compactDevice(d: HomeDevice): Record<string, unknown> {
  const raw = d as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of DEVICE_FIELDS) {
    const v = raw[k];
    if (v === null || v === undefined) continue;
    if (k === "requiresConfirmation" && v === false) continue;
    if (k === "unreachable" && v === false) continue;
    out[k] = v;
  }
  return out;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One line of what a device accepts — the tool's vocabulary, per kind. */
function commandHint(d: Device): string {
  const hints: string[] = [];
  if (d.capabilities.includes("on_off") || d.capabilities.includes("hvac_mode")) hints.push("turn_on, turn_off");
  if (d.capabilities.includes("brightness")) hints.push("set_brightness (value 0-100)");
  if (d.capabilities.includes("open_close_stop")) hints.push("open, close, stop");
  if (d.capabilities.includes("position")) hints.push("set_position (value 0-100, 100 = open)");
  if (d.capabilities.includes("set_temperature")) {
    const { min, max } = temperatureBounds(d.kind);
    hints.push(`set_temperature (value ${min}-${max} °C)`);
  }
  if (d.capabilities.includes("volume")) hints.push("set_volume (value 0-100)");
  if (d.capabilities.includes("vacuum_control")) hints.push("start_cleaning, pause_cleaning, return_to_dock");
  if (d.capabilities.includes("bed_level")) hints.push("set_bed_level (value -100 coolest … +100 warmest)");
  return hints.join("; ");
}

const INSTRUCTIONS = `You are connected to a private smart home (Control4 + KNX behind Home Assistant, with a few extra devices) through its own app. Read state with get_home_state and act with control_device, set_room_lights and activate_scene. Only ids returned by these tools are valid: never invent a deviceId, sceneId or room. Values: brightness, shade position and volume are percent 0-100; temperatures are °C (rooms 10-32, sauna 40-100); bed warmth is Eight Sleep's -100…+100 scale, not degrees. "The lights in X" means set_room_lights, which sweeps real lights only (never fans, vents, towel rails or floor heating). The sauna heater is safety-sensitive: command it only when the person explicitly asked, tell them it will start or stop the heater, and pass confirm: true only after they agreed. Door locks, gates and alarms are not available here by policy. Commands answer "sent" the moment Home Assistant accepts them; read get_home_state a few seconds later to see the result. Every action is written to the house's audit log under this connection's name.`;

/**
 * Build a server for one caller. One per request in the stateless HTTP
 * route; the caller's identity rides into every audit line.
 */
export function createHouseMcpServer(caller: McpCaller): McpServer {
  const server = new McpServer(
    { name: "smarthome", version: "1.0.0", title: "The house" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "list_rooms",
    {
      title: "List rooms",
      description:
        "The rooms of the house by floor, with the kinds of device each one has. Start here to learn the vocabulary; use get_home_state for live state.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const byRoom = new Map<string, { room: string; floor: number | null; kinds: Record<string, number> }>();
      for (const d of registry().devices.filter(agentVisible)) {
        const entry = byRoom.get(d.room) ?? { room: d.room, floor: d.floor, kinds: {} };
        entry.kinds[d.kind] = (entry.kinds[d.kind] ?? 0) + 1;
        byRoom.set(d.room, entry);
      }
      const rooms = [...byRoom.values()].map((r) => ({ ...r, aliases: loadAliases()[r.room] ?? [] }));
      return ok({
        rooms,
        floors: { 5: "lower floor (Den, guest rooms, sauna, gym)", 6: "upper floor (Lounge, Kitchen, Master Bedroom)" },
      });
    },
  );

  server.registerTool(
    "get_home_state",
    {
      title: "Get home state",
      description:
        "Live state of every device the agent may see, joined from Home Assistant: on/off, brightness, temperatures and setpoints, shade state, media source and volume, vacuum battery, bed presence. Optional room filter (canonical name or a synonym). Also reports which rooms have warm floors and each floor's heat/cool mode. Each device's `id` is what control_device takes.",
      inputSchema: {
        room: z.string().min(1).max(64).optional().describe("Only this room. Canonical name or a synonym; omit for the whole house."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ room }) => {
      let wanted: string | null = null;
      if (room) {
        const r = resolveRoom(room);
        if ("error" in r) return fail(r.error);
        wanted = r.room;
      }
      try {
        const snap = await homeSnapshot(caller.role);
        const devices = snap.devices
          .filter((d) => agentDevice(d) && (!wanted || d.room === wanted))
          .map(compactDevice);
        const now = nowParts();
        return ok({
          houseTime: `${now.date} ${now.hhmm}`,
          ...(wanted ? { room: wanted } : {}),
          floorHeatingRooms: wanted ? snap.floorHeatingRooms.filter((r) => r === wanted) : snap.floorHeatingRooms,
          floorModes: snap.floorModes,
          devices,
        });
      } catch (err) {
        return fail(`Home Assistant is not answering: ${errorText(err)}`);
      }
    },
  );

  server.registerTool(
    "list_scenes",
    {
      title: "List scenes",
      description:
        "The saved scenes (captured room states) with their ids for activate_scene. A scene that includes the sauna applies without it here.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      ok({
        scenes: listScenes().map((s) => ({
          id: s.id,
          name: s.name,
          room: s.room,
          devices: s.states.length,
          includesSauna: s.states.some((st) => getDevice(st.deviceId)?.kind === "sauna"),
        })),
      }),
  );

  server.registerTool(
    "control_device",
    {
      title: "Control a device",
      description:
        "Send one command to one device by its id (from get_home_state). Commands: turn_on, turn_off, set_brightness, open, close, stop, set_position, set_temperature, set_volume, start_cleaning, pause_cleaning, return_to_dock, set_bed_level. `value` carries the number for the set_* commands (percent, °C, or the bed's -100…+100 scale). A device that `requiresConfirmation` (the sauna heater) is refused until you pass confirm: true, which you may do only after the person explicitly agreed. Answers \"sent\" when Home Assistant accepts the command; check get_home_state afterwards for the result.",
      inputSchema: {
        deviceId: z.string().min(1).max(120).describe("The device id from get_home_state."),
        command: z.enum(DEVICE_COMMANDS).describe("What to do."),
        value: z.number().optional().describe("For set_brightness / set_position / set_volume (0-100), set_temperature (°C), set_bed_level (-100…+100)."),
        confirm: z.boolean().optional().describe("Required true for a device that requiresConfirmation, after the person agreed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ deviceId, command, value, confirm }) => {
      const device = getDevice(deviceId);
      if (!device || !agentVisible(device)) {
        return fail(`unknown device "${deviceId}" — use the ids returned by get_home_state`);
      }
      if (device.requiresConfirmation && confirm !== true) {
        return fail(
          `${device.label} is safety-sensitive: ${command} will ${command === "turn_off" ? "stop" : "start or change"} the heater. Ask the person, then call again with confirm: true.`,
        );
      }
      let cmd: Command;
      try {
        cmd = toCommand({ type: "device", deviceId, command, value: value ?? null });
        assertCommandAllowed(device, cmd);
      } catch (err) {
        return fail(`${device.label}: ${errorText(err)}. Accepted: ${commandHint(device)}`);
      }
      const { command: name, ...args } = cmd;
      const started = Date.now();
      const line = (extra: Partial<Parameters<typeof audit>[0]>) =>
        audit({
          ts: new Date().toISOString(), user: caller.user, deviceId: device.id, entityId: device.entityId,
          command: name, args: { ...args, via: "mcp" }, ok: true, durationMs: Date.now() - started, ...extra,
        });
      try {
        // Unavailable is not off (lib/reachability): refuse loudly when Home
        // Assistant has lost the device, as the interactive route does,
        // instead of returning "sent" over a dead switch.
        if (device.kind !== "sauna" && device.kind !== "noise") {
          const reads = new Map(
            await Promise.all(
              commandEntityIds(device).map(async (id) => [id, await getState(id).catch(() => undefined)] as const),
            ),
          );
          if (deviceUnreachable(device, (id) => reads.get(id))) {
            const message = `${device.label} is not responding — Home Assistant reports it unavailable`;
            line({ ok: false, error: message });
            return fail(message);
          }
        }
        await executeOnDevice(device, cmd);
        void followArtFrames(device, cmd, caller.user);
        line({});
        return ok({
          status: "sent",
          device: { id: device.id, label: device.label, room: device.room },
          command: cmd,
          note: "Home Assistant accepted the command; read get_home_state in a few seconds to see the result.",
        });
      } catch (err) {
        const message = errorText(err);
        line({ ok: false, error: message });
        return fail(`${device.label}: ${message}`);
      }
    },
  );

  server.registerTool(
    "set_room_lights",
    {
      title: "Room lights on or off",
      description:
        "Switch every real light in a room on or off at once (canonical room name or a synonym). Fans, vents, towel rails and floor heating are never touched. Use control_device for one light or a brightness level.",
      inputSchema: {
        room: z.string().min(1).max(64).describe("The room."),
        state: z.enum(["on", "off"]).describe("on or off."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ room, state }) => {
      const r = resolveRoom(room);
      if ("error" in r) return fail(r.error);
      const lights = roomLights(r.room);
      if (lights.length === 0) return fail(`${r.room} has no lights the app controls`);
      const started = Date.now();
      const result = await executeAction({ type: "room", room: r.room, command: state === "on" ? "lights_on" : "lights_off" });
      audit({
        ts: new Date().toISOString(), user: caller.user, deviceId: "mcp", entityId: `room.${slug(r.room)}`,
        command: `lights_${state}`, args: { room: r.room, targets: result.total, failed: result.failed.length, via: "mcp" },
        ok: result.failed.length === 0, durationMs: Date.now() - started,
        error: result.failed.length ? result.failed.map((f) => `${f.target}: ${f.error}`).join("; ") : undefined,
      });
      return ok({
        status: result.failed.length === 0 ? "sent" : "partial",
        room: r.room,
        lights: lights.map((d) => d.id),
        failed: result.failed,
      });
    },
  );

  server.registerTool(
    "activate_scene",
    {
      title: "Activate a scene",
      description:
        "Apply a saved scene by id (from list_scenes). The sauna heater never fires from here even if the scene captured it.",
      inputSchema: {
        sceneId: z.string().min(1).max(120).describe("The scene id from list_scenes."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sceneId }) => {
      const scene = getScene(sceneId);
      if (!scene) return fail(`unknown scene "${sceneId}" — use the ids returned by list_scenes`);
      const started = Date.now();
      try {
        const result = await applySceneById(sceneId);
        audit({
          ts: new Date().toISOString(), user: caller.user, deviceId: "mcp", entityId: `scene.${sceneId}`,
          command: "apply_scene", args: { name: scene.name, targets: result.total, failed: result.failed.length, via: "mcp" },
          ok: result.failed.length === 0, durationMs: Date.now() - started,
          error: result.failed.length ? result.failed.map((f) => `${f.target}: ${f.error}`).join("; ") : undefined,
        });
        return ok({
          status: result.failed.length === 0 ? "sent" : "partial",
          scene: { id: scene.id, name: scene.name, room: scene.room },
          devices: result.total,
          failed: result.failed,
        });
      } catch (err) {
        const message = errorText(err);
        audit({
          ts: new Date().toISOString(), user: caller.user, deviceId: "mcp", entityId: `scene.${sceneId}`,
          command: "apply_scene", args: { name: scene.name, via: "mcp" }, ok: false, durationMs: Date.now() - started, error: message,
        });
        return fail(`${scene.name}: ${message}`);
      }
    },
  );

  return server;
}
