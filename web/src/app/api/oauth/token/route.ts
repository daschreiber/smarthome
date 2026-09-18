import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, exchangeCode, refreshTokens } from "@/lib/oauth";

/**
 * RFC 6749 §3.2 token endpoint: authorization_code (with PKCE) and
 * refresh_token grants, public clients (client_id in the body, or in a
 * Basic header with an empty secret — some clients send that). Form
 * encoding is the standard; JSON is accepted too.
 */
async function readBody(req: NextRequest): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const j = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    return Object.fromEntries(Object.entries(j ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  }
  return Object.fromEntries(new URLSearchParams(await req.text().catch(() => "")));
}

function basicClientId(req: NextRequest): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return null;
  const decoded = Buffer.from(m[1], "base64").toString();
  const colon = decoded.indexOf(":");
  return decodeURIComponent(colon >= 0 ? decoded.slice(0, colon) : decoded) || null;
}

const headers = () => ({ ...corsHeaders(), "Cache-Control": "no-store", Pragma: "no-cache" });

export async function POST(req: NextRequest) {
  const body = await readBody(req);
  const client_id = body.client_id || basicClientId(req);
  const origin = new URL(req.url).origin;
  const fail = (error: string, description: string) =>
    NextResponse.json(
      { error, error_description: description },
      { status: error === "invalid_client" ? 401 : 400, headers: headers() },
    );

  if (body.grant_type === "authorization_code") {
    const r = exchangeCode({ ...body, client_id }, origin);
    return r.ok ? NextResponse.json(r.tokens, { headers: headers() }) : fail(r.error, r.description);
  }
  if (body.grant_type === "refresh_token") {
    const r = refreshTokens({ ...body, client_id });
    return r.ok ? NextResponse.json(r.tokens, { headers: headers() }) : fail(r.error, r.description);
  }
  return fail("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}
