import { NextRequest, NextResponse } from "next/server";
import { createStateToken, googleAuthUrl, googleConfigured } from "@/lib/google";

/** Step 1: send the browser to Google with a signed state cookie. */
export async function GET(req: NextRequest) {
  if (!googleConfigured()) {
    return NextResponse.redirect(new URL("/?error=google-not-configured", req.url));
  }
  const state = createStateToken();
  const res = NextResponse.redirect(googleAuthUrl(new URL(req.url).origin, state));
  res.cookies.set("oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 600,
    path: "/",
  });
  return res;
}
