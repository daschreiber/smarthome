import { NextRequest, NextResponse } from "next/server";
import { authorizationServerMetadata, corsHeaders } from "@/lib/oauth";

/** RFC 8414: the authorization server's endpoints and what it supports. */
export async function GET(req: NextRequest) {
  return NextResponse.json(authorizationServerMetadata(new URL(req.url).origin), {
    headers: { ...corsHeaders(), "Cache-Control": "public, max-age=3600" },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}
