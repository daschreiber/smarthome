import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { nowPlaying, roomDeviceName, spotifyConfigured, transferToRoom } from "@/lib/spotify";
import { getLink, userKey } from "@/lib/spotifyAccounts";

/**
 * Hand a room over to the phone's own Spotify app.
 *
 * Spotify publishes no deep link that pre-selects a Connect device, and the
 * App Remote SDK that could is native-app-only — this is a PWA. So the app
 * does the half a link can't: it points the user's OWN account at the
 * room's Connect endpoint over the Web API, and then sends them into
 * Spotify, which opens already attached to that room. Search, playlists and
 * the queue are Spotify's job from there; ours was getting them to the
 * right speakers.
 *
 * This only works on a PERSONAL link. Transferring the house account and
 * then opening the user's own Spotify would attach a room to one account
 * and show them another — so an un-linked user gets the deep link plus the
 * honest instruction to pick the room in Spotify's device picker.
 */
export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { room?: unknown } | null;
  const room = typeof body?.room === "string" ? body.room : null;
  if (!room || !roomDeviceName(room)) {
    return NextResponse.json({ error: `no Spotify endpoint mapped for ${room ?? "that room"}` }, { status: 400 });
  }

  const url = "https://open.spotify.com";
  const link = spotifyConfigured() ? getLink(auth.user) : null;
  if (!link) {
    return NextResponse.json({
      ok: true,
      transferred: false,
      url,
      hint: `Connect your own Spotify in More to have this open straight onto the ${room}. For now: tap the speaker icon in Spotify and pick "${roomDeviceName(room)}".`,
    });
  }

  const account = userKey(auth.user);
  const started = Date.now();
  try {
    // Keep playing if they already were; otherwise just attach the device so
    // opening Spotify doesn't blast music into an empty room.
    const current = await nowPlaying(account).catch(() => null);
    const device = await transferToRoom(room, account, current?.playing === true);
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: `music:${room}`,
      entityId: device, command: "spotify_handoff", args: { room }, ok: true,
      durationMs: Date.now() - started,
    });
    return NextResponse.json({
      ok: true,
      transferred: true,
      device,
      url,
      hint: `Spotify is now pointed at the ${room} — everything you play there lands in that room.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "hand-off failed";
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: `music:${room}`,
      entityId: roomDeviceName(room) ?? room, command: "spotify_handoff", args: { room },
      ok: false, durationMs: Date.now() - started, error: message,
    });
    // Still worth opening Spotify: the picker is the manual version of what
    // just failed, so the user isn't left with only an error.
    return NextResponse.json({ error: message, url, transferred: false }, { status: 502 });
  }
}
