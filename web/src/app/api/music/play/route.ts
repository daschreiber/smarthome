import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { playInRoom, roomDeviceName, spotifyConfigured, spotifyLinked } from "@/lib/spotify";

/** "Play music here": resume the household Spotify on the room's Connect
 *  endpoint (the Core's per-zone "Spotify C4 …" devices). Any signed-in
 *  user may play — it's a light switch, not programming. */
export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!spotifyConfigured() || !spotifyLinked()) {
    return NextResponse.json(
      { error: "Spotify isn't linked yet — an admin can link it from the More page" },
      { status: 501 },
    );
  }
  const body = (await req.json().catch(() => null)) as { room?: unknown } | null;
  const room = typeof body?.room === "string" ? body.room : null;
  if (!room || !roomDeviceName(room)) {
    return NextResponse.json({ error: `no Spotify endpoint mapped for ${room ?? "that room"}` }, { status: 400 });
  }
  const started = Date.now();
  try {
    const device = await playInRoom(room);
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: `music:${room}`,
      entityId: device, command: "spotify_play", args: { room }, ok: true,
      durationMs: Date.now() - started,
    });
    return NextResponse.json({ ok: true, device });
  } catch (err) {
    const message = err instanceof Error ? err.message : "play failed";
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: `music:${room}`,
      entityId: roomDeviceName(room) ?? room, command: "spotify_play", args: { room },
      ok: false, durationMs: Date.now() - started, error: message,
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
