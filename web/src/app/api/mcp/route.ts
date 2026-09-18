import { NextRequest, NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateMcp, createHouseMcpServer } from "@/lib/mcp";
import { corsHeaders, wwwAuthenticate } from "@/lib/oauth";

/**
 * The house's MCP endpoint (docs/MCP_SERVER.md): Streamable HTTP, stateless.
 * Every POST is one JSON-RPC exchange — a fresh server and transport per
 * request, no session to keep, which is what a Railway container that may
 * be redeployed under a client wants. JSON responses rather than SSE for
 * the same reason: nothing long-lived to keep open through a proxy.
 *
 * Auth is decided here, before the protocol sees a byte (lib/mcp
 * authenticateMcp): an OAuth access token issued by the app itself
 * (lib/oauth — the person's own identity), the shared MCP token, or the
 * app's session / app key. A 401 carries the WWW-Authenticate pointer
 * that starts a client's OAuth discovery.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function unauthorized(req: NextRequest) {
  const presented = /^Bearer\s+\S/i.test(req.headers.get("authorization") ?? "");
  return NextResponse.json(
    { error: "unauthorized" },
    {
      status: 401,
      headers: {
        ...corsHeaders(),
        "WWW-Authenticate": wwwAuthenticate(new URL(req.url).origin, presented ? "invalid_token" : undefined),
      },
    },
  );
}

function methodNotAllowed() {
  return NextResponse.json(
    { error: "method not allowed — the MCP endpoint takes POST (see docs/MCP_SERVER.md)" },
    { status: 405, headers: { ...corsHeaders(), Allow: "POST, OPTIONS" } },
  );
}

export async function POST(req: NextRequest) {
  const caller = authenticateMcp(req);
  if (!caller) return unauthorized(req);
  const server = createHouseMcpServer(caller);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    for (const [k, v] of Object.entries(corsHeaders())) res.headers.set(k, v);
    return res;
  } finally {
    // JSON mode: the Response above is complete before we get here.
    void server.close().catch(() => {});
  }
}

/** Browser-based clients preflight; bearer auth carries no cookies. */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

/** No standalone server-to-client stream in stateless mode (spec: 405). */
export async function GET() {
  return methodNotAllowed();
}

/** No sessions to end. */
export async function DELETE() {
  return methodNotAllowed();
}
