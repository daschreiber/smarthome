import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { nowPlaying, spotifyConfigured, spotifyLinked } from "@/lib/spotify";

/** The household Spotify session, for the Music cards: track + artist +
 *  art + which room it's playing in. Quiet {playing:false} when Spotify
 *  isn't set up — the cards degrade to zone-only info, not errors. */
export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!spotifyConfigured() || !spotifyLinked()) {
    return NextResponse.json({ playing: false, track: null, artist: null, artUrl: null, deviceName: null, room: null });
  }
  try {
    return NextResponse.json(await nowPlaying());
  } catch {
    return NextResponse.json({ playing: false, track: null, artist: null, artUrl: null, deviceName: null, room: null });
  }
}
