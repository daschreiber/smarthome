import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { canProgram } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import {
  CLOSET_LIGHTS, READING_LIGHTS, SLEEP_ROOM, WINDOW_END, WINDOW_START,
  loadSleepwatch, saveSleepwatch, watchedLightEntities,
} from "@/lib/sleepwatch";
import { noiseConfigured } from "@/lib/whitenoise";
import { isAway } from "@/lib/away";
import { bedPresenceEntities } from "@/lib/eightsleep";

/** The sleep watcher's switchboard: read status for the Automations card,
 *  flip enabled. The watcher itself runs in the scheduler (lib/sleepwatch). */
export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const st = loadSleepwatch();
  return NextResponse.json({
    enabled: st.enabled,
    active: st.active,
    away: isAway(),
    configured: noiseConfigured(),
    room: SLEEP_ROOM,
    window: { start: WINDOW_START, end: WINDOW_END },
    watchedLights: watchedLightEntities().length,
    readingLights: READING_LIGHTS.size,
    closetLights: CLOSET_LIGHTS.size,
    bedPresenceSides: bedPresenceEntities().length,
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
  const st = loadSleepwatch();
  // Disabling mid-night must not strand a playing session as "active" —
  // clear the tracking state so re-enabling starts clean.
  saveSleepwatch({ enabled: body.enabled, active: false, latched: false });
  audit({
    ts: new Date().toISOString(), user: auth.user, deviceId: "automations",
    entityId: "sleepwatch", command: body.enabled ? "sleepwatch_enable" : "sleepwatch_disable",
    args: { was: st.enabled }, ok: true, durationMs: 0,
  });
  return NextResponse.json({ ok: true, enabled: body.enabled });
}
