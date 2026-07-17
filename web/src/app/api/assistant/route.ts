import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { authenticate } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  LlmProposalSchema, assistantConfigured, buildSystemPrompt, houseNowLine,
  toAutomationSpec, toInternalAction,
} from "@/lib/assistant";
import { AutomationSpecSchema, createAutomation } from "@/lib/automations";
import { executeAction } from "@/lib/execute";
import { getStates } from "@/lib/ha";
import { registry } from "@/lib/registry";
import { buildSceneStates, createScene } from "@/lib/scenes";
import { z } from "zod/v4"; // v4 to match the assistant schemas (see lib/assistant.ts)

export const maxDuration = 120;

const ChatBody = z.object({
  message: z.string().min(1).max(2000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }))
    .max(20)
    .optional(),
});

const ExecuteBody = z.object({
  action: z.literal("execute"),
  proposal: LlmProposalSchema,
});

export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const raw = await req.json().catch(() => null);

  // ---- Execute a confirmed proposal ----
  if (raw && typeof raw === "object" && (raw as { action?: string }).action === "execute") {
    const parsed = ExecuteBody.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: "invalid proposal" }, { status: 400 });
    const proposal = parsed.data.proposal;
    const started = Date.now();

    try {
      if (proposal.kind === "clarify") {
        return NextResponse.json({ error: "nothing to execute" }, { status: 400 });
      }

      if (proposal.kind === "actions") {
        const failures: string[] = [];
        let total = 0;
        for (const a of proposal.actions) {
          const r = await executeAction(toInternalAction(a));
          total += r.total;
          failures.push(...r.failed.map((f) => `${f.target}: ${f.error}`));
        }
        audit({
          ts: new Date().toISOString(), user: auth.user, deviceId: "assistant",
          entityId: "assistant.actions", command: "execute_proposal",
          args: { actions: proposal.actions.length, targets: total, failed: failures.length },
          ok: failures.length === 0, durationMs: Date.now() - started,
          error: failures.length ? failures.join("; ") : undefined,
        });
        return NextResponse.json({ ok: failures.length === 0, targets: total, failed: failures });
      }

      if (proposal.kind === "scene_capture") {
        const states = new Map((await getStates()).map((s) => [s.entity_id, s]));
        const devices = registry().devices.filter((d) => d.room === proposal.room);
        const scene = createScene(proposal.name, proposal.room, auth.user, buildSceneStates(devices, states));
        audit({
          ts: new Date().toISOString(), user: auth.user, deviceId: "assistant",
          entityId: `scene.${scene.id}`, command: "capture_scene_via_chat",
          args: { room: proposal.room }, ok: true, durationMs: Date.now() - started,
        });
        return NextResponse.json({ ok: true, sceneId: scene.id });
      }

      // automation
      const spec = AutomationSpecSchema.parse(toAutomationSpec(proposal));
      const auto = createAutomation(spec, auth.user);
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId: "assistant",
        entityId: `automation.${auto.id}`, command: "create_automation_via_chat",
        args: { steps: auto.steps.length }, ok: true, durationMs: Date.now() - started,
      });
      return NextResponse.json({ ok: true, automationId: auto.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : "execution failed";
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId: "assistant",
        entityId: "assistant.execute", command: "execute_proposal",
        args: { kind: proposal.kind }, ok: false, durationMs: Date.now() - started, error: message,
      });
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  // ---- Chat: turn a message into a proposal ----
  if (!assistantConfigured()) {
    return NextResponse.json(
      { error: "The assistant isn't configured yet — set ANTHROPIC_API_KEY on the server." },
      { status: 501 },
    );
  }
  const body = ChatBody.safeParse(raw);
  if (!body.success) return NextResponse.json({ error: "message required" }, { status: 400 });

  const client = new Anthropic();
  const history = (body.data.history ?? []).map((m) => ({ role: m.role, content: m.content }));

  try {
    const response = await client.messages.parse({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: [
        {
          type: "text",
          text: buildSystemPrompt(),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        ...history,
        { role: "user" as const, content: `${houseNowLine()}\n${body.data.message}` },
      ],
      output_config: { format: zodOutputFormat(LlmProposalSchema) },
    });

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      return NextResponse.json({
        proposal: { kind: "clarify", message: "I couldn't turn that into a house action — could you rephrase it?" },
      });
    }
    return NextResponse.json({ proposal: response.parsed_output });
  } catch (err) {
    console.error("assistant error:", err);
    return NextResponse.json(
      { error: "The assistant hit a problem talking to the model — try again in a moment." },
      { status: 502 },
    );
  }
}
