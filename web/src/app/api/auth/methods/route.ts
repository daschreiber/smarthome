import { NextResponse } from "next/server";
import { googleConfigured } from "@/lib/google";

/** Which sign-in methods are available (safe to expose pre-auth). */
export async function GET() {
  return NextResponse.json({ password: true, google: googleConfigured() });
}
