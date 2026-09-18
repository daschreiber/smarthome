import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, revokeToken } from "@/lib/oauth";

/**
 * RFC 7009: a client disconnecting cleanly. Either token of a grant ends
 * the grant; an unknown token is still a 200 (the spec's rule — nothing to
 * learn from probing). A configured confidential client authenticates
 * here as at the token endpoint (secret in the body or a Basic header);
 * without it, its grant stays and the answer is 401 invalid_client.
 */
function basicClient(req: NextRequest): { id: string | null; secret: string | null } {
  const m = /^Basic\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return { id: null, secret: null };
  const decoded = Buffer.from(m[1], "base64").toString();
  const colon = decoded.indexOf(":");
  return {
    id: decodeURIComponent(colon >= 0 ? decoded.slice(0, colon) : decoded) || null,
    secret: colon >= 0 ? decodeURIComponent(decoded.slice(colon + 1)) || null : null,
  };
}

export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";
  const body = ct.includes("application/json")
    ? ((await req.json().catch(() => null)) as Record<string, unknown> | null) ?? {}
    : Object.fromEntries(new URLSearchParams(await req.text().catch(() => "")));
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : null);
  const basic = basicClient(req);
  const headers = { ...corsHeaders(), "Cache-Control": "no-store" };
  const token = str("token");
  if (token) {
    const r = revokeToken(token, { client_id: str("client_id") || basic.id, client_secret: str("client_secret") || basic.secret });
    if (r.unauthorized) {
      return NextResponse.json({ error: "invalid_client", error_description: "client secret is missing or wrong" }, { status: 401, headers });
    }
  }
  return NextResponse.json({}, { headers });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}
