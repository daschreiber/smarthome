import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { canProgram } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { loadAway, setAway } from "@/lib/away";
import { listAutomations } from "@/lib/automations";
import { bedConfigured, bedSetAwayAll } from "@/lib/eightsleep";

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
    // So the cards can say what the switch actually does right now:
    // "home"-only automations pause while away; "away"-only ones take over.
    homeOnlyCount: enabled.filter((a) => a.activeWhen === "home").length,
    awayOnlyCount: enabled.filter((a) => a.activeWhen === "away").length,
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
  // Eight Sleep rides along: the Pod has its own away mode (stops its
  // schedules and Autopilot), so the house switch flips it on every
  // configured side. Best-effort — a cloud hiccup never blocks the house
  // flag — but the outcome is audited and returned so the card can say so.
  let bed: { synced: boolean; detail?: string } | null = null;
  if (bedConfigured()) {
    const started = Date.now();
    const { failures } = await bedSetAwayAll(body.away);
    bed = failures.length ? { synced: false, detail: failures.join("; ") } : { synced: true };
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: "automations",
      entityId: "away_mode", command: body.away ? "bed_away_on" : "bed_away_off",
      args: {}, ok: failures.length === 0, durationMs: Date.now() - started,
      error: failures.length ? failures.join("; ") : undefined,
    });
  }
  return NextResponse.json({ ok: true, away: st.away, bed });
}
