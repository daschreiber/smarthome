import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { canProgram } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { liftwatchAvailable, loadLiftwatch, saveLiftwatch } from "@/lib/liftwatch";

/** The TV follower's switchboard: read status for the Automations card,
 *  flip enabled. The rule itself runs in the scheduler (lib/liftwatch). */
export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const st = loadLiftwatch();
  return NextResponse.json({
    enabled: st.enabled,
    available: liftwatchAvailable(),
    canToggle: canProgram(auth.role),
  });
}

export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canProgram(auth.role)) {
    return NextResponse.json({ error: "your account can't change automations" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled (boolean) required" }, { status: 400 });
  }
  const st = loadLiftwatch();
  // Re-enabling starts with a fresh baseline: the next readable relay state
  // is recorded without acting, so flipping the rule on with the lift down
  // doesn't command anything until the lift next moves.
  saveLiftwatch({ enabled: body.enabled, lastDown: null });
  audit({
    ts: new Date().toISOString(), user: auth.user, deviceId: "automations",
    entityId: "liftwatch", command: body.enabled ? "liftwatch_enable" : "liftwatch_disable",
    args: { was: st.enabled }, ok: true, durationMs: 0,
  });
  return NextResponse.json({ ok: true, enabled: body.enabled });
}
