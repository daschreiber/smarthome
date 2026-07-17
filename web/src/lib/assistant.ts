import fs from "node:fs";
import path from "node:path";
// zod/v4: the SDK's zodOutputFormat helper requires v4 schemas. This module's
// schemas are self-contained, so they live in v4 while the rest of the app
// stays on classic v3 (both ship in the installed zod package).
import { z } from "zod/v4";
import { registry } from "./registry";
import { listScenes } from "./scenes";
import { nowParts, type Action, type AutomationSpec } from "./automations";
import type { Command } from "./commands";

/**
 * Conversational layer (docs/CONVERSATIONAL_LAYER_AND_EXPANSION.md).
 * Claude translates natural language into a structured PROPOSAL — immediate
 * actions, a scene capture, or an automation — which the user reviews and
 * confirms before anything executes. The model never touches the house
 * directly; execution goes through the same typed command layer as the UI.
 *
 * The proposal schema is enforced with structured outputs (messages.parse +
 * zodOutputFormat), so a malformed proposal is impossible by construction;
 * we still re-validate against the internal schemas before executing.
 */

const DEVICE_COMMANDS = [
  "turn_on", "turn_off", "set_brightness", "open", "close", "stop",
  "set_position", "set_temperature", "set_volume",
] as const;

// Structured-outputs-safe schema (no records, no optionals — nullable instead).
export const LlmActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("scene"), sceneId: z.string() }),
  z.object({
    type: z.literal("room"),
    room: z.string(),
    command: z.enum(["lights_on", "lights_off"]),
  }),
  z.object({
    type: z.literal("device"),
    deviceId: z.string(),
    command: z.enum(DEVICE_COMMANDS),
    value: z.number().nullable(), // percent for brightness/position/volume, °C for temperature
  }),
]);

export const LlmStepSchema = z.object({
  time: z.string(), // HH:MM 24h
  days: z.array(z.number()).nullable(), // 0=Sunday..6; null = every day
  date: z.string().nullable(), // YYYY-MM-DD one-shot; null = recurring
  actions: z.array(LlmActionSchema),
});

export const LlmProposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clarify"), message: z.string() }),
  z.object({
    kind: z.literal("actions"),
    message: z.string(),
    actions: z.array(LlmActionSchema),
  }),
  z.object({
    kind: z.literal("scene_capture"),
    message: z.string(),
    name: z.string(),
    room: z.string(),
  }),
  z.object({
    kind: z.literal("automation"),
    message: z.string(),
    name: z.string(),
    steps: z.array(LlmStepSchema),
  }),
]);

export type LlmProposal = z.infer<typeof LlmProposalSchema>;
export type LlmAction = z.infer<typeof LlmActionSchema>;

/** Convert an LLM device action's (command, value) into an internal Command. */
export function toCommand(action: Extract<LlmAction, { type: "device" }>): Command {
  const v = action.value;
  switch (action.command) {
    case "set_brightness":
      if (v == null) throw new Error("set_brightness needs a value");
      return { command: "set_brightness", brightnessPct: Math.round(v) };
    case "set_position":
      if (v == null) throw new Error("set_position needs a value");
      return { command: "set_position", positionPct: Math.round(v) };
    case "set_temperature":
      if (v == null) throw new Error("set_temperature needs a value");
      return { command: "set_temperature", temperature: v };
    case "set_volume":
      if (v == null) throw new Error("set_volume needs a value");
      return { command: "set_volume", volumePct: Math.round(v) };
    default:
      return { command: action.command };
  }
}

/** Convert an LLM action to the internal Action shape used by the executor. */
export function toInternalAction(a: LlmAction): Action {
  if (a.type === "scene") return { type: "scene", sceneId: a.sceneId };
  if (a.type === "room") return { type: "room", room: a.room, command: a.command };
  return { type: "device", deviceId: a.deviceId, command: toCommand(a) as unknown as Record<string, unknown> };
}

/** Convert an LLM automation proposal to an internal AutomationSpec. */
export function toAutomationSpec(p: Extract<LlmProposal, { kind: "automation" }>): AutomationSpec {
  return {
    name: p.name,
    steps: p.steps.map((s) => ({
      time: s.time,
      ...(s.days && s.days.length > 0 ? { days: s.days } : {}),
      ...(s.date ? { date: s.date } : {}),
      actions: s.actions.map(toInternalAction),
    })),
  };
}

function loadAliases(): Record<string, string[]> {
  for (const p of [
    path.join(process.cwd(), "..", "data", "room_aliases.json"),
    path.join(process.cwd(), "data", "room_aliases.json"),
  ]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
      delete parsed._comment;
      return parsed as Record<string, string[]>;
    } catch { /* try next */ }
  }
  return {};
}

/**
 * The system prompt is the stable, cacheable half of every request: the
 * house vocabulary (devices, scenes, aliases) and the proposal rules.
 * Anything volatile (current time, the user's words) goes in messages.
 */
export function buildSystemPrompt(): string {
  const devices = registry()
    .devices.filter((d) => d.visible)
    .map((d) =>
      `- ${d.id} | ${d.label} | room: ${d.room || "—"} | kind: ${d.kind} | capabilities: ${d.capabilities.join(",")}` +
      (d.requiresConfirmation ? " | SAFETY: requires explicit user confirmation" : ""),
    )
    .join("\n");

  const scenes = listScenes()
    .map((s) => `- ${s.id} | "${s.name}"${s.room ? ` | room: ${s.room}` : ""}`)
    .join("\n") || "(none yet)";

  const aliases = Object.entries(loadAliases())
    .filter(([, list]) => list.length > 0)
    .map(([room, list]) => `- ${room}: ${list.join(", ")}`)
    .join("\n");

  return `You are the conversational interface of a private smart home app. You translate the owner's natural-language requests into a single structured proposal that they review and confirm in the UI. You never execute anything yourself.

## Devices (the ONLY valid deviceId values)
${devices}

## Saved scenes (the ONLY valid sceneId values)
${scenes}

## Room name synonyms (resolve these to the canonical room name)
${aliases}

## Proposal kinds
- "actions": immediate commands, executed once when the user confirms. Use for "turn on X", "close the blinds", "set the lounge to 23 degrees".
- "scene_capture": snapshot a room's current state under a name. Use for "save the lounge like this as Cozy".
- "automation": scheduled steps (time HH:MM 24h; days array 0=Sunday..6 or null for every day; date YYYY-MM-DD for one-shot or null for recurring). Use for anything with a time or schedule.
- "clarify": when the request is ambiguous (unknown room, multiple plausible devices, missing time). Ask ONE short question.

## Rules
- Use ONLY deviceId/sceneId values listed above. Never invent identifiers. If nothing matches, use "clarify".
- "the lights in X" or "X lights" → prefer a room action (lights_on/lights_off) over listing devices.
- Device values: brightness/position/volume are percent 0-100; temperature is °C (rooms 10-32, sauna 40-100).
- The sauna is safety-sensitive: propose it only when explicitly asked, never include it in room actions or scene captures, and say clearly in the message that confirming will start/stop the heater.
- Relative dates ("tomorrow", "Saturday"): resolve using the current house time given in the user message; one-shot automations must carry the resolved date.
- "message" is shown to the user above the confirm button: one or two plain sentences describing exactly what will happen, including resolved times/dates.
- Prefer the simplest correct proposal. Do not bundle unrelated extras the user didn't ask for.`;
}

export function houseNowLine(): string {
  const now = nowParts();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `[house time: ${dayNames[now.day]} ${now.date} ${now.hhmm}]`;
}

export function assistantConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
