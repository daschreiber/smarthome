import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, protectedResourceMetadata } from "@/lib/oauth";

/** RFC 9728: where an MCP client learns which authorization server guards
 *  `/api/mcp`. The endpoint's 401 points here (docs/MCP_SERVER.md). */
export async function GET(req: NextRequest) {
  return NextResponse.json(protectedResourceMetadata(new URL(req.url).origin), {
    headers: { ...corsHeaders(), "Cache-Control": "public, max-age=3600" },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}
