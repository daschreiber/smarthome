import { NextRequest, NextResponse } from "next/server";
import { clientInformation, corsHeaders, registerClient } from "@/lib/oauth";

/**
 * RFC 7591 dynamic client registration. Unauthenticated by design — an
 * MCP client registers itself before anyone has signed in — and it grants
 * nothing: a registered client is only a name and a set of redirect URIs
 * the consent page will honour. Public clients only (PKCE, no secret).
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const result = registerClient(body);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, error_description: result.description },
      { status: 400, headers: corsHeaders() },
    );
  }
  return NextResponse.json(clientInformation(result.client), { status: 201, headers: corsHeaders() });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}
