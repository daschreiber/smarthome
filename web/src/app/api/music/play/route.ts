import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { playInRoom, roomDeviceName, spotifyConfigured } from "@/lib/spotify";
import { HOUSE, accountFor, accountLabel } from "@/lib/spotifyAccounts";

/** "Play music here": resume the caller's Spotify on the room's Connect
 *  endpoint (the Core's per-zone "Spotify C4 …" devices). Their own account
 *  when they've linked one, the house account otherwise — so someone
 *  playing the Kitchen no longer moves whoever is listening in the Lounge.
 *  Any signed-in user may play; it's a light switch, not programming. */
export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!spotifyConfigured()) {
    return NextResponse.json(
      { error: "Spotify isn't set up on this server yet (see docs/AUDIO_SYSTEM.md)" },
      { status: 501 },
    );
  }
  const account = accountFor(auth.user);
  if (!account) {
    return NextResponse.json(
      { error: "No Spotify is linked yet — connect yours in More → Spotify" },
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
    const device = await playInRoom(room, account);
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: `music:${room}`,
      entityId: device, command: "spotify_play", args: { room, account }, ok: true,
      durationMs: Date.now() - started,
    });
    return NextResponse.json({
      ok: true,
      device,
      // The card says whose music started — "the house Spotify" is a
      // different fact from "yours", and the difference matters when two
      // people are listening in different rooms.
      who: accountLabel(account),
      usingHouse: account === HOUSE,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "play failed";
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: `music:${room}`,
      entityId: roomDeviceName(room) ?? room, command: "spotify_play", args: { room, account },
      ok: false, durationMs: Date.now() - started, error: message,
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
