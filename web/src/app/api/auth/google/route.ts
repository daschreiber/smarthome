import { NextRequest, NextResponse } from "next/server";
import { appBaseUrl, createStateToken, googleAuthUrl, googleConfigured, safeNext } from "@/lib/google";

/** Step 1: send the browser to Google with a signed state cookie. */
export async function GET(req: NextRequest) {
  if (!googleConfigured()) {
    return NextResponse.redirect(new URL("/?error=google-not-configured", appBaseUrl(new URL(req.url).origin)));
  }
  const state = createStateToken();
  const res = NextResponse.redirect(googleAuthUrl(new URL(req.url).origin, state));
  const cookie = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge: 600,
    path: "/",
  };
  res.cookies.set("oauth_state", state, cookie);
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  if (next) res.cookies.set("oauth_next", next, cookie);
  else res.cookies.delete("oauth_next");
  return res;
}
