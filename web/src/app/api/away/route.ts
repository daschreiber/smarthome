import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { canProgram } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { loadAway, runsWhileAway, setAway } from "@/lib/away";
import { listAutomations } from "@/lib/automations";

/**
 * Away mode switchboard: read status for the Automations card, flip the
 * house-wide flag. What the flag actually gates lives in the scheduler and
 * the sleep watcher — see lib/away.ts for the semantics.
 */
export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const st = loadAway();
  const enabled = listAutomations().filter((a) => a.enabled);
  return NextResponse.json({
    away: st.away,
    since: st.since ?? null,
    setBy: st.setBy ?? null,
    // So the card can say what the switch will actually do right now.
    pausedCount: enabled.filter((a) => !runsWhileAway(a)).length,
    runningCount: enabled.filter(runsWhileAway).length,
    canToggle: canProgram(auth.role),
  });
}

export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canProgram(auth.role)) {
    return NextResponse.json({ error: "your account can't change automations" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as { away?: unknown } | null;
  if (typeof body?.away !== "boolean") {
    return NextResponse.json({ error: "away (boolean) required" }, { status: 400 });
  }
  const was = loadAway().away;
  const st = setAway(body.away, auth.user);
  audit({
    ts: new Date().toISOString(), user: auth.user, deviceId: "automations",
    entityId: "away_mode", command: body.away ? "away_on" : "away_off",
    args: { was }, ok: true, durationMs: 0,
  });
  return NextResponse.json({ ok: true, away: st.away });
}
