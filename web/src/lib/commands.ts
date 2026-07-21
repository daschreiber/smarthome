import { z } from "zod";
import { unitEntityIds } from "./coolmaster";
import type { Device } from "./registry";

/**
 * Typed command layer. Semantic and room-oriented by design: its two future
 * callers are the UI and the conversational layer
 * (docs/CONVERSATIONAL_LAYER_AND_EXPANSION.md). No generic service passthrough.
 */

export const CommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("turn_on") }),
  z.object({ command: z.literal("turn_off") }),
  z.object({
    command: z.literal("set_brightness"),
    brightnessPct: z.number().int().min(0).max(100),
  }),
  z.object({ command: z.literal("open") }),
  z.object({ command: z.literal("close") }),
  z.object({ command: z.literal("stop") }),
  z.object({
    command: z.literal("set_position"),
    positionPct: z.number().int().min(0).max(100),
  }),
  z.object({
    command: z.literal("set_temperature"),
    // Outer sanity range; per-kind bounds enforced by temperatureBounds().
    temperature: z.number().min(5).max(110),
  }),
  z.object({
    command: z.literal("set_volume"),
    volumePct: z.number().int().min(0).max(100),
  }),
  // Vacuums (Roborock, one per floor). start doubles as resume-from-pause.
  // segments: Roborock map segment ids ("clean only these rooms"); omitted =
  // whole floor. repeat: passes over each segment (Roborock allows 1-3) —
  // only meaningful with segments, the plain start service has no repeat.
  z.object({
    command: z.literal("start_cleaning"),
    segments: z.array(z.number().int().min(0).max(255)).min(1).max(64).optional(),
    repeat: z.number().int().min(1).max(3).optional(),
  }),
  z.object({ command: z.literal("pause_cleaning") }),
  z.object({ command: z.literal("return_to_dock") }),
  // Suction power; valid values are whatever the entity's fan_speed_list
  // reports (the command route validates against it before sending).
  z.object({
    command: z.literal("set_fan_speed"),
    fanSpeed: z.string().min(1).max(32).regex(/^[a-z0-9_ ]+$/i),
  }),
]);

export type Command = z.infer<typeof CommandSchema>;

export interface ServiceCall {
  domain: string;
  service: string;
  data: Record<string, unknown>;
}

const CAPABILITY_FOR_COMMAND: Record<Command["command"], string> = {
  turn_on: "on_off",
  turn_off: "on_off",
  set_brightness: "brightness",
  open: "open_close_stop",
  close: "open_close_stop",
  stop: "open_close_stop",
  set_position: "position",
  set_temperature: "set_temperature",
  set_volume: "volume",
  start_cleaning: "vacuum_control",
  pause_cleaning: "vacuum_control",
  return_to_dock: "vacuum_control",
  set_fan_speed: "vacuum_control",
};

/** Per-kind safe set-point ranges (°C), enforced server-side. */
export function temperatureBounds(kind: Device["kind"]): { min: number; max: number } {
  switch (kind) {
    case "climate":
      return { min: 10, max: 32 };
    case "sauna":
      return { min: 40, max: 100 }; // matches the KLAFS app's own clamp
    default:
      return { min: 10, max: 32 };
  }
}

export function assertCommandAllowed(device: Device, cmd: Command): void {
  const needed = CAPABILITY_FOR_COMMAND[cmd.command];
  // Climate zones advertise hvac_mode rather than on_off; turning the zone
  // on/off is the hvac-mode operation, so either capability satisfies it.
  const satisfied =
    device.capabilities.includes(needed as Device["capabilities"][number]) ||
    ((cmd.command === "turn_on" || cmd.command === "turn_off") &&
      device.capabilities.includes("hvac_mode" as Device["capabilities"][number]));
  if (!satisfied) {
    throw new Error(
      `device ${device.id} (${device.kind}) does not support ${cmd.command}`,
    );
  }
  if (cmd.command === "set_temperature") {
    const { min, max } = temperatureBounds(device.kind);
    if (cmd.temperature < min || cmd.temperature > max) {
      throw new Error(
        `temperature ${cmd.temperature} out of range ${min}-${max} for ${device.kind}`,
      );
    }
  }
}

/**
 * States that prove a command took effect, for read-back verification.
 * null = not verifiable by simple state comparison (position, volume, stop);
 * those commands report the observed state without claiming confirmation.
 */
export function expectedStates(cmd: Command, kind?: Device["kind"]): string[] | null {
  switch (cmd.command) {
    case "turn_on":
      // A climate zone that turns on lands in an hvac mode we can't predict
      // (heat/cool/auto…), so state comparison can't prove it — report "sent".
      if (kind === "climate") return null;
      return ["on"];
    case "set_brightness":
      return ["on"];
    case "turn_off":
      return ["off"];
    case "open":
      return ["open", "opening"];
    case "close":
      return ["closed", "closing"];
    case "start_cleaning":
      return ["cleaning"];
    case "pause_cleaning":
      return ["paused"];
    case "return_to_dock":
      return ["returning", "docked"];
    default:
      return null;
  }
}

/** Pure mapping: (device, command) -> HA service call, or throws. */
export function buildServiceCall(device: Device, cmd: Command): ServiceCall {
  assertCommandAllowed(device, cmd);
  if (device.kind === "sauna") {
    throw new Error("sauna commands are executed by the sauna adapter, not Home Assistant");
  }
  const target = { entity_id: device.entityId };
  // Climate zones command their CoolMaster units directly — the bridge is the
  // authority; the Control4 proxy only ever handled on/off and drops setpoints.
  const climateTarget = () => ({ entity_id: unitEntityIds(device) ?? device.entityId });
  switch (cmd.command) {
    case "turn_on":
      if (device.kind === "climate") return { domain: "climate", service: "turn_on", data: climateTarget() };
      return device.kind === "media_player"
        ? { domain: "media_player", service: "turn_on", data: target }
        : { domain: "light", service: "turn_on", data: target };
    case "turn_off":
      if (device.kind === "climate") return { domain: "climate", service: "turn_off", data: climateTarget() };
      return device.kind === "media_player"
        ? { domain: "media_player", service: "turn_off", data: target }
        : { domain: "light", service: "turn_off", data: target };
    case "set_brightness":
      return {
        domain: "light",
        service: "turn_on",
        data: { ...target, brightness_pct: cmd.brightnessPct },
      };
    case "open":
      return { domain: "cover", service: "open_cover", data: target };
    case "close":
      return { domain: "cover", service: "close_cover", data: target };
    case "stop":
      return { domain: "cover", service: "stop_cover", data: target };
    case "set_position":
      return {
        domain: "cover",
        service: "set_cover_position",
        data: { ...target, position: cmd.positionPct },
      };
    case "set_temperature":
      return {
        domain: "climate",
        service: "set_temperature",
        data: { ...climateTarget(), temperature: cmd.temperature },
      };
    case "set_volume":
      return {
        domain: "media_player",
        service: "volume_set",
        data: { ...target, volume_level: cmd.volumePct / 100 },
      };
    case "start_cleaning":
      // Segment (per-room) cleaning goes through Roborock's own command;
      // vacuum.start has no notion of rooms or passes.
      if (cmd.segments?.length) {
        return {
          domain: "vacuum",
          service: "send_command",
          data: {
            ...target,
            command: "app_segment_clean",
            params: [{
              segments: cmd.segments,
              ...(cmd.repeat && cmd.repeat > 1 ? { repeat: cmd.repeat } : {}),
            }],
          },
        };
      }
      return { domain: "vacuum", service: "start", data: target };
    case "pause_cleaning":
      return { domain: "vacuum", service: "pause", data: target };
    case "return_to_dock":
      return { domain: "vacuum", service: "return_to_base", data: target };
    case "set_fan_speed":
      return {
        domain: "vacuum",
        service: "set_fan_speed",
        data: { ...target, fan_speed: cmd.fanSpeed },
      };
  }
}
