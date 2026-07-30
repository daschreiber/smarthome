import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { authUrl, spotifyConfigured, spotifyRedirectUri, type LinkTarget } from "@/lib/spotify";
import { MAX_LINKED_USERS, getLink, usedSlots } from "@/lib/spotifyAccounts";

/**
 * Start a Spotify consent flow. Two targets:
 *
 * - `?target=me` (the default) — any signed-in user links THEIR OWN
 *   Spotify, so the room controls on their phone drive their account.
 * - `?target=house` — admin only: the shared fallback account that everyone
 *   without a personal link (and the APP_KEY admin) plays as.
 */
export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const wantsHouse = req.nextUrl.searchParams.get("target") === "house";
  if (wantsHouse && auth.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
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

  let target: LinkTarget;
  if (wantsHouse) {
    target = { kind: "house" };
  } else {
    // A personal link needs a real account to hang the token on; the
    // password-less principals (APP_KEY admin, dev fallback) have none.
    if (!auth.user.includes("@")) {
      return NextResponse.json(
        { error: "sign in with your own account to link your Spotify — the app key has no personal account" },
        { status: 400 },
      );
    }
    // Spotify's Development Mode ceiling (5 authorised users since Feb 2026)
    // is worth hitting HERE, with a number and a remedy, rather than at
    // Spotify's consent screen with "we couldn't link your account".
    // usedSlots counts Spotify USERS — the house account included, since it
    // holds a slot of its own unless it's the same account being linked
    // personally. That last case can only be known after consent, so the
    // callback re-checks with the identity in hand.
    if (!getLink(auth.user) && usedSlots(auth.user) >= MAX_LINKED_USERS) {
      return NextResponse.json(
        {
          error:
            `Spotify allows ${MAX_LINKED_USERS} linked accounts for this app, and all ${MAX_LINKED_USERS} are taken — ` +
            `someone can disconnect theirs in More → Spotify to free a slot`,
        },
        { status: 409 },
      );
    }
    target = { kind: "user", email: auth.user };
  }
  return NextResponse.redirect(authUrl(spotifyRedirectUri(), target));
}
