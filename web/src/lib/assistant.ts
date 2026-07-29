import fs from "node:fs";
import path from "node:path";
// zod/v4: the SDK's zodOutputFormat helper requires v4 schemas. This module's
// schemas are self-contained, so they live in v4 while the rest of the app
// stays on classic v3 (both ship in the installed zod package).
import { z } from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
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
  "start_cleaning", "pause_cleaning", "return_to_dock",
  "set_bed_level",
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
  // Exactly one trigger: a clock time OR a sun event. Null out the one you
  // aren't using (structured outputs disallow optionals).
  time: z.string().nullable(), // HH:MM 24h, or null when sun is set
  sun: z.enum(["sunset", "sunrise"]).nullable(), // null when time is set
  sunOffsetMinutes: z.number().nullable(), // minutes vs the sun event; negative = before
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

/**
 * Structured-output format for the assistant call.
 *
 * zodOutputFormat emits reused sub-schemas (our action schema, shared by the
 * "actions" proposal and automation steps) as `$defs` + `$ref`. Anthropic's
 * structured-output API rejects `$defs` under a top-level `anyOf` (our
 * discriminated union) with `For 'anyOf', '$defs' is not supported`, which
 * made EVERY assistant request 400. We keep the SDK's format (and its zod
 * `parse`) but inline the `$ref`s so no `$defs` remain.
 */
type JsonNode = Record<string, unknown>;

function inlineDefs(node: unknown, defs: Record<string, JsonNode>): unknown {
  if (Array.isArray(node)) return node.map((n) => inlineDefs(n, defs));
  if (node && typeof node === "object") {
    const obj = node as JsonNode;
    if (typeof obj.$ref === "string") {
      const key = obj.$ref.replace("#/$defs/", "");
      return inlineDefs(structuredClone(defs[key]), defs);
    }
    const out: JsonNode = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "$defs") continue; // drop the defs block itself
      out[k] = inlineDefs(v, defs);
    }
    return out;
  }
  return node;
}

export function proposalOutputFormat() {
  // Keep zodOutputFormat's exact return type (so parsed_output still infers as
  // LlmProposal) and only swap in the $ref-free schema.
  const fmt = zodOutputFormat(LlmProposalSchema);
  const schema = fmt.schema as JsonNode;
  const defs = (schema.$defs ?? {}) as Record<string, JsonNode>;
  if (Object.keys(defs).length > 0) {
    return { ...fmt, schema: inlineDefs(schema, defs) as typeof fmt.schema };
  }
  return fmt;
}

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
    case "set_bed_level":
      // Eight Sleep's own -100 (cool) … +100 (warm) scale, not a percent.
      if (v == null) throw new Error("set_bed_level needs a value");
      return { command: "set_bed_level", level: Math.min(100, Math.max(-100, Math.round(v))) };
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
    steps: p.steps.map((s) => {
      // Sun trigger wins if present; otherwise fall back to the clock time.
      // The internal schema enforces exactly-one, so we never emit both.
      const trigger = s.sun
        ? { sun: s.sun, ...(s.sunOffsetMinutes ? { sunOffsetMinutes: s.sunOffsetMinutes } : {}) }
        : { time: s.time ?? "00:00" };
      return {
        ...trigger,
        ...(s.days && s.days.length > 0 ? { days: s.days } : {}),
        ...(s.date ? { date: s.date } : {}),
        actions: s.actions.map(toInternalAction),
      };
    }),
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
  // Door locks are excluded from the conversational layer entirely
  // (CONVERSATIONAL_LAYER doc: security tier, "excluded from conversation
  // initially") — not even in the vocabulary, so no proposal can name them.
  const devices = registry()
    .devices.filter((d) => d.visible && d.kind !== "lock")
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
- "automation": scheduled steps. Each step is triggered by EITHER a clock time OR a sun event, never both:
  - clock: set "time" to HH:MM 24h and "sun"/"sunOffsetMinutes" to null.
  - sun: set "sun" to "sunset" or "sunrise" and "time" to null. "sunOffsetMinutes" shifts the trigger relative to the event — negative is before, positive is after, 0 or null is exactly at the event (e.g. "15 minutes before sunset" → sun "sunset", sunOffsetMinutes -15; range ±120).
  - "days" (array 0=Sunday..6, or null for every day) and "date" (YYYY-MM-DD one-shot, or null for recurring) apply to either trigger.
  Use for anything with a time, a schedule, or sunrise/sunset.
- "clarify": when the request is ambiguous (unknown room, multiple plausible devices, missing time). Ask ONE short question.

## Rules
- Use ONLY deviceId/sceneId values listed above. Never invent identifiers. If nothing matches, use "clarify".
- "the lights in X" or "X lights" → prefer a room action (lights_on/lights_off) over listing devices.
- Device values: brightness/position/volume are percent 0-100; temperature is °C (rooms 10-32, sauna 40-100).
- Eight Sleep bed sides (kind "bed"): warmth uses set_bed_level with value -100 (coolest) to +100 (warmest) — NOT degrees, NOT percent. "Warm the bed" → turn_on then set_bed_level around +30; "cool the bed" → around -30; "pre-warm at 21:30" is an automation with those two actions. Bed sides never join room light actions or scene captures.
- The sauna is safety-sensitive: propose it only when explicitly asked, never include it in room actions or scene captures, and say clearly in the message that confirming will start/stop the heater.
- The robot vacuums are per-floor: the Lounge vacuum cleans floor 6, the Den vacuum cleans floor 5. "vacuum/clean the lounge", "clean floor 6", "clean upstairs" → start_cleaning on that floor's vacuum; "send it home/back" → return_to_dock. Vacuums never join room light actions or scene captures.
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
