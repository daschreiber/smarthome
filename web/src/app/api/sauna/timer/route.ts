import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { saunaConfigured, saunaStopIn } from "@/lib/sauna";

/**
 * Schedule (or replace) the sauna's auto-stop while it is running. The
 * sauna app owns the schedule and its cron does the stopping; this is a
 * thin, audited pass-through.
 */
export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!saunaConfigured()) return NextResponse.json({ error: "sauna is not configured" }, { status: 501 });

  const body = (await req.json().catch(() => null)) as { minutes?: unknown } | null;
  const minutes = typeof body?.minutes === "number" ? body.minutes : NaN;
  if (!Number.isFinite(minutes) || minutes < 15 || minutes > 480) {
    return NextResponse.json({ error: "minutes must be 15-480" }, { status: 400 });
  }

  const started = Date.now();
  try {
    const { stopAt } = await saunaStopIn(minutes);
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: "sauna__klafs_sauna",
      entityId: "virtual.sauna", command: "schedule_auto_stop",
      args: { minutes, stopAt }, ok: true, durationMs: Date.now() - started,
    });
    return NextResponse.json({ ok: true, stopAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : "auto-stop failed";
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: "sauna__klafs_sauna",
      entityId: "virtual.sauna", command: "schedule_auto_stop",
      args: { minutes }, ok: false, durationMs: Date.now() - started, error: message,
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
