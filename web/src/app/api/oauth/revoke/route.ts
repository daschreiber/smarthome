import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, revokeToken } from "@/lib/oauth";

/** RFC 7009: a client disconnecting cleanly. Either token of a grant ends
 *  the grant; an unknown token is still a 200 (the spec's rule — nothing
 *  to learn from probing). */
export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";
  const body = ct.includes("application/json")
    ? ((await req.json().catch(() => null)) as Record<string, unknown> | null) ?? {}
    : Object.fromEntries(new URLSearchParams(await req.text().catch(() => "")));
  const token = typeof body.token === "string" ? body.token : "";
  if (token) revokeToken(token);
  return NextResponse.json({}, { headers: { ...corsHeaders(), "Cache-Control": "no-store" } });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}
