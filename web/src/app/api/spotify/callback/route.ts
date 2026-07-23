import { NextRequest, NextResponse } from "next/server";
import { consumeState, exchangeCode } from "@/lib/spotify";

/** Spotify redirects here after consent. No app auth: the state nonce from
 *  /api/spotify/login (admin-gated) is the proof this flow is ours. */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const denied = req.nextUrl.searchParams.get("error");
  if (denied) return NextResponse.redirect(`${req.nextUrl.origin}/more?spotify=denied`);
  if (!code || !state || !consumeState(state)) {
    return NextResponse.json({ error: "invalid or expired link attempt — start again from More" }, { status: 400 });
  }
  try {
    await exchangeCode(code, `${req.nextUrl.origin}/api/spotify/callback`);
    return NextResponse.redirect(`${req.nextUrl.origin}/more?spotify=linked`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "link failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
