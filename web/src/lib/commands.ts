import { z } from "zod";
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
    // Server-side sanity bounds; refined per-zone later.
    temperature: z.number().min(10).max(32),
  }),
  z.object({
    command: z.literal("set_volume"),
    volumePct: z.number().int().min(0).max(100),
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
};

/** Pure mapping: (device, command) -> HA service call, or throws. */
export function buildServiceCall(device: Device, cmd: Command): ServiceCall {
  const needed = CAPABILITY_FOR_COMMAND[cmd.command];
  if (!device.capabilities.includes(needed as Device["capabilities"][number])) {
    throw new Error(
      `device ${device.id} (${device.kind}) does not support ${cmd.command}`,
    );
  }
  const target = { entity_id: device.entityId };
  switch (cmd.command) {
    case "turn_on":
      return device.kind === "media_player"
        ? { domain: "media_player", service: "turn_on", data: target }
        : { domain: "light", service: "turn_on", data: target };
    case "turn_off":
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
        data: { ...target, temperature: cmd.temperature },
      };
    case "set_volume":
      return {
        domain: "media_player",
        service: "volume_set",
        data: { ...target, volume_level: cmd.volumePct / 100 },
      };
  }
}
