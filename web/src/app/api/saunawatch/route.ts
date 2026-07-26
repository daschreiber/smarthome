import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { canProgram } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import {
  loadSaunawatch, saunaAcDevices, saunaAcFan, saunaAcTemp, saunawatchAvailable, saveSaunawatch,
} from "@/lib/saunawatch";

/** The sauna follower's switchboard: read status for the Automations card,
 *  flip enabled. The rule itself runs in the scheduler (lib/saunawatch). */
export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const st = loadSaunawatch();
  return NextResponse.json({
    enabled: st.enabled,
    available: saunawatchAvailable(),
    acTemp: saunaAcTemp(),
    acFan: saunaAcFan(),
    acZones: saunaAcDevices().length,
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
  const st = loadSaunawatch();
  // Re-enabling starts with a fresh baseline: the next readable status is
  // recorded without acting, so flipping the rule on mid-session doesn't
  // command anything until the sauna next changes state.
  saveSaunawatch({ enabled: body.enabled, lastPower: null });
  audit({
    ts: new Date().toISOString(), user: auth.user, deviceId: "automations",
    entityId: "saunawatch", command: body.enabled ? "saunawatch_enable" : "saunawatch_disable",
    args: { was: st.enabled }, ok: true, durationMs: 0,
  });
  return NextResponse.json({ ok: true, enabled: body.enabled });
}
