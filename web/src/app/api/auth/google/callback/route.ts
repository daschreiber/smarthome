import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { appBaseUrl, exchangeCodeForEmail, googleConfigured, verifyStateToken } from "@/lib/google";
import { createSessionToken } from "@/lib/session";
import { getUser } from "@/lib/users";

/**
 * Step 2: Google sends the browser back here. Verify state, exchange the
 * code, and — crucially — admit only emails already in the user store.
 * Google proves identity; the allow-list grants access.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const back = (q: string) => {
    // Redirects go to the browser: they must use the public base URL, not
    // the request origin (behind Railway's proxy that is 0.0.0.0:8080).
    const res = NextResponse.redirect(new URL(`/?${q}`, appBaseUrl(url.origin)));
    res.cookies.delete("oauth_state");
    return res;
  };

  if (!googleConfigured()) return back("error=google-not-configured");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stateCookie = req.cookies.get("oauth_state")?.value;
  if (!code || !state || state !== stateCookie || !verifyStateToken(state)) {
    return back("error=google-signin-failed");
  }

  try {
    const email = await exchangeCodeForEmail(code, url.origin);
    const user = getUser(email);
    if (!user) {
      // Real Google account, but not on the allow-list.
      audit({
        ts: new Date().toISOString(), user: email, deviceId: "auth", entityId: "app.auth",
        command: "google_signin_denied", args: {}, ok: false, durationMs: 0,
        error: "not on the user list",
      });
      return back("error=not-invited");
    }
    audit({
      ts: new Date().toISOString(), user: user.email, deviceId: "auth", entityId: "app.auth",
      command: "google_signin", args: { role: user.role }, ok: true, durationMs: 0,
    });
    const res = back("");
    res.cookies.set("session", createSessionToken(user.email), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 90 * 24 * 3600,
      path: "/",
    });
    return res;
  } catch (err) {
    console.error("google callback error:", err);
    return back("error=google-signin-failed");
  }
}
