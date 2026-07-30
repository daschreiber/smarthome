import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { nowPlaying, roomSessions, spotifyConfigured } from "@/lib/spotify";
import { HOUSE, accountFor, getLink } from "@/lib/spotifyAccounts";

/**
 * What Spotify is doing, from this caller's point of view:
 *
 * - `mine` — the session on the account THIS user plays as (their own link
 *   if they have one, else the house account). Drives the transport
 *   controls, which only work on your own session.
 * - `rooms` — every room with a session, across every linked account. This
 *   is what lets the Lounge card say "Ruth's Spotify is playing here" when
 *   the music isn't yours at all; before per-user links there was only one
 *   account and the question couldn't arise.
 *
 * Quiet, empty answers when Spotify isn't set up — the cards degrade to
 * zone-only info rather than showing errors on every room page.
 */
const EMPTY = {
  configured: false,
  linked: false,
  usingHouse: false,
  premium: null as boolean | null,
  mine: { playing: false, track: null, artist: null, artUrl: null, deviceName: null, room: null },
  rooms: [] as unknown[],
};

export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!spotifyConfigured()) return NextResponse.json(EMPTY);

  const account = accountFor(auth.user);
  if (!account) return NextResponse.json({ ...EMPTY, configured: true });

  const link = getLink(auth.user);
  const base = {
    configured: true,
    linked: true,
    usingHouse: account === HOUSE,
    premium: link?.premium ?? null,
  };
  try {
    // One sweep serves both answers: roomSessions() shares the same
    // per-account cache nowPlaying() fills, so this is not two round trips.
    const [mine, rooms] = await Promise.all([nowPlaying(account), roomSessions()]);
    return NextResponse.json({
      ...base,
      mine,
      rooms: rooms.map((s) => ({
        room: s.room,
        track: s.track,
        artist: s.artist,
        artUrl: s.artUrl,
        playing: s.playing,
        who: s.who,
        mine: s.account === account,
      })),
    });
  } catch {
    return NextResponse.json({ ...base, mine: EMPTY.mine, rooms: [] });
  }
}
