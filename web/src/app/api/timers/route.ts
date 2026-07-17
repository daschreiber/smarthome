import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { canProgram } from "@/lib/permissions";
import { createTimer, deleteTimer, listTimers, setTimerEnabled } from "@/lib/timers";

export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ timers: listTimers() });
}

export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canProgram(auth.role)) {
    return NextResponse.json({ error: "your account can't change timers" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | { action?: "create" | "delete" | "toggle"; id?: string; deviceId?: string; afterMinutes?: number; enabled?: boolean }
    | null;
  if (!body?.action) return NextResponse.json({ error: "action required" }, { status: 400 });

  try {
    if (body.action === "create") {
      if (!body.deviceId || body.afterMinutes == null) {
        return NextResponse.json({ error: "deviceId and afterMinutes required" }, { status: 400 });
      }
      const rule = createTimer(body.deviceId, body.afterMinutes, auth.user);
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId: body.deviceId,
        entityId: `timer.${rule.id}`, command: "create_timer",
        args: { afterMinutes: rule.afterMinutes }, ok: true, durationMs: 0,
      });
      return NextResponse.json({ ok: true, timers: listTimers() });
    }
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    if (body.action === "delete") {
      deleteTimer(body.id);
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId: "timers",
        entityId: `timer.${body.id}`, command: "delete_timer", args: {}, ok: true, durationMs: 0,
      });
    } else {
      setTimerEnabled(body.id, body.enabled !== false);
    }
    return NextResponse.json({ ok: true, timers: listTimers() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed" }, { status: 400 });
  }
}
