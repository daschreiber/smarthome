import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { canProgram } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { gymwatchAvailable, loadGymwatch, saveGymwatch } from "@/lib/gymwatch";

/** The Gym TV follower's switchboard: read status for the Automations card,
 *  flip enabled. The rule itself runs in the scheduler (lib/gymwatch). */
export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const st = loadGymwatch();
  return NextResponse.json({
    enabled: st.enabled,
    available: gymwatchAvailable(),
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
  const st = loadGymwatch();
  // Re-enabling starts from a fresh baseline, so turning the rule back on
  // with the lights already on does not switch the TV.
  saveGymwatch({ enabled: body.enabled, lastLightsOn: null });
  audit({
    ts: new Date().toISOString(), user: auth.user, deviceId: "automations",
    entityId: "gymwatch", command: body.enabled ? "gymwatch_enable" : "gymwatch_disable",
    args: { was: st.enabled }, ok: true, durationMs: 0,
  });
  return NextResponse.json({ ok: true, enabled: body.enabled });
}
