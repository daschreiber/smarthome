import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { canProgram } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import {
  AutomationSpecSchema, createAutomation, deleteAutomation, listAutomations, setEnabled,
} from "@/lib/automations";

export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ automations: listAutomations(), tz: process.env.APP_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone });
}

export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canProgram(auth.role)) {
    return NextResponse.json({ error: "your account can't change automations" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | { action?: "create" | "delete" | "toggle"; id?: string; enabled?: boolean; spec?: unknown }
    | null;
  if (!body?.action) return NextResponse.json({ error: "action required" }, { status: 400 });

  try {
    if (body.action === "create") {
      const parsed = AutomationSpecSchema.safeParse(body.spec);
      if (!parsed.success) {
        return NextResponse.json({ error: "invalid automation", detail: parsed.error.flatten() }, { status: 400 });
      }
      const auto = createAutomation(parsed.data, auth.user);
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId: "automations",
        entityId: `automation.${auto.id}`, command: "create_automation",
        args: { steps: auto.steps.length }, ok: true, durationMs: 0,
      });
      return NextResponse.json({ ok: true, automation: auto });
    }
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    if (body.action === "delete") {
      deleteAutomation(body.id);
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId: "automations",
        entityId: `automation.${body.id}`, command: "delete_automation", args: {}, ok: true, durationMs: 0,
      });
      return NextResponse.json({ ok: true });
    }
    // toggle
    setEnabled(body.id, body.enabled !== false);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed" }, { status: 400 });
  }
}
