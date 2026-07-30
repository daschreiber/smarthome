import { NextRequest, NextResponse } from "next/server";
import { exchangeCode, forgetAccount, profileWithToken, spotifyRedirectUri } from "@/lib/spotify";
import { publicBaseUrl, readStateToken } from "@/lib/urls";
import { HOUSE, saveHouseRefreshToken, saveLink, userKey } from "@/lib/spotifyAccounts";

/**
 * Spotify redirects here after consent. No app auth of its own: the
 * HMAC-signed state minted by /api/spotify/login is the proof this flow is
 * ours, and its SUBJECT says whose link it is. That subject must come from
 * the signature rather than a query parameter or the session cookie — a
 * member must not be able to come back holding a state that overwrites the
 * house account, and the cookie may legitimately be absent on a cross-site
 * return.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const denied = req.nextUrl.searchParams.get("error");
  if (denied) return NextResponse.redirect(`${publicBaseUrl()}/more?spotify=denied`);
  const checked = state ? readStateToken("spotify-link", state) : { ok: false, subject: null };
  if (!code || !checked.ok) {
    return NextResponse.json({ error: "invalid or expired link attempt — start again from More" }, { status: 400 });
  }
  // A state minted before this build carries no subject; it can only have
  // come from the old admin-only house flow, so honour it as such.
  const subject = checked.subject ?? "house";
  try {
    const { refreshToken, accessToken } = await exchangeCode(code, spotifyRedirectUri());
    // Read the profile with the token we just got: the display name labels
    // the session house-wide ("Ruth's Spotify"), and the product tier lets
    // More say "Connect control needs Premium" instead of leaving a free
    // account to fail mysteriously at the first Play.
    const profile = await profileWithToken(accessToken);
    if (subject === "house") {
      saveHouseRefreshToken(refreshToken);
      forgetAccount(HOUSE);
    } else {
      const email = subject.startsWith("user:") ? subject.slice(5) : subject;
      saveLink({ user: email, refreshToken, displayName: profile.displayName, premium: profile.premium });
      forgetAccount(userKey(email));
    }
    const flag = profile.premium === false ? "linked-free" : "linked";
    return NextResponse.redirect(`${publicBaseUrl()}/more?spotify=${flag}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "link failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
