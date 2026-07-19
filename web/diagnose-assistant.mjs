// Reproduce the app's exact assistant model call and print the RAW error.
// Run from web/ with the app's key:  ANTHROPIC_API_KEY=sk-... node diagnose-assistant.mjs
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";

// Faithful copy of LlmProposalSchema (kept inline so this runs standalone).
const Act = z.discriminatedUnion("type", [
  z.object({ type: z.literal("scene"), sceneId: z.string() }),
  z.object({ type: z.literal("room"), room: z.string(), command: z.enum(["lights_on","lights_off"]) }),
  z.object({ type: z.literal("device"), deviceId: z.string(),
    command: z.enum(["turn_on","turn_off","set_brightness","open","close","stop","set_position","set_temperature","set_volume"]),
    value: z.number().nullable() }),
]);
const Step = z.object({ time: z.string().nullable(), sun: z.enum(["sunset","sunrise"]).nullable(),
  sunOffsetMinutes: z.number().nullable(), days: z.array(z.number()).nullable(), date: z.string().nullable(),
  actions: z.array(Act) });
const Proposal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clarify"), message: z.string() }),
  z.object({ kind: z.literal("actions"), message: z.string(), actions: z.array(Act) }),
  z.object({ kind: z.literal("scene_capture"), message: z.string(), name: z.string(), room: z.string() }),
  z.object({ kind: z.literal("automation"), message: z.string(), name: z.string(), steps: z.array(Step) }),
]);

const client = new Anthropic();
const base = { model: "claude-opus-4-8", max_tokens: 1024,
  messages: [{ role: "user", content: "turn off the lights in the study" }] };

async function attempt(label, extra, useParse) {
  try {
    const params = { ...base, ...extra };
    const res = useParse ? await client.messages.parse(params) : await client.messages.create(params);
    console.log(`✅ ${label}: SUCCEEDED (stop_reason=${res.stop_reason})`);
    return true;
  } catch (e) {
    const status = e?.status ?? e?.error?.status ?? "?";
    const msg = e?.error?.error?.message ?? e?.message ?? String(e);
    console.log(`❌ ${label}: [${status}] ${msg}`);
    return false;
  }
}

console.log("Bisecting the assistant model call...\n");
await attempt("A) EXACT app call (adaptive thinking + structured output)",
  { thinking: { type: "adaptive" }, output_config: { format: zodOutputFormat(Proposal) } }, true);
await attempt("B) structured output, NO thinking",
  { output_config: { format: zodOutputFormat(Proposal) } }, true);
await attempt("C) structured output, thinking=enabled",
  { max_tokens: 4096, thinking: { type: "enabled", budget_tokens: 2048 }, output_config: { format: zodOutputFormat(Proposal) } }, true);
await attempt("D) plain call, NO structured output, NO thinking", {}, false);
await attempt("E) thinking=adaptive, NO structured output",
  { thinking: { type: "adaptive" } }, false);
console.log("\nThe first ✅ tells us which ingredient is breaking the app's call.");
