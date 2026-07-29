import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { authUrl, spotifyConfigured, spotifyRedirectUri } from "@/lib/spotify";

/** Start the one-time Spotify account link. Admin-only: the linked account
 *  becomes the whole household's music source. */
export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok || auth.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: auth.ok ? 403 : 401 });
  }
  if (!spotifyConfigured()) {
    return NextResponse.json(
      { error: "set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET first (see docs/AUDIO_SYSTEM.md)" },
      { status: 501 },
    );
  }
  // The link flow's signed state needs the session secret; an APP_KEY-only
  // deployment gets a clear pointer instead of a 500 from the mint.
  if (!process.env.APP_SESSION_SECRET) {
    return NextResponse.json(
      { error: "set APP_SESSION_SECRET first — the Spotify link flow signs its OAuth state with it" },
      { status: 501 },
    );
  }
  return NextResponse.redirect(authUrl(spotifyRedirectUri()));
}
