import { NextRequest, NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateMcp, createHouseMcpServer } from "@/lib/mcp";

/**
 * The house's MCP endpoint (docs/MCP_SERVER.md): Streamable HTTP, stateless.
 * Every POST is one JSON-RPC exchange — a fresh server and transport per
 * request, no session to keep, which is what a Railway container that may
 * be redeployed under a client wants. JSON responses rather than SSE for
 * the same reason: nothing long-lived to keep open through a proxy.
 *
 * Auth is decided here, before the protocol sees a byte (lib/mcp
 * authenticateMcp): the MCP token, or the app's own session / app key.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function unauthorized() {
  return NextResponse.json(
    { error: "unauthorized" },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="smarthome-mcp"' } },
  );
}

function methodNotAllowed() {
  return NextResponse.json(
    { error: "method not allowed — the MCP endpoint takes POST (see docs/MCP_SERVER.md)" },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function POST(req: NextRequest) {
  const caller = authenticateMcp(req);
  if (!caller) return unauthorized();
  const server = createHouseMcpServer(caller);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } finally {
    // JSON mode: the Response above is complete before we get here.
    void server.close().catch(() => {});
  }
}

/** No standalone server-to-client stream in stateless mode (spec: 405). */
export async function GET() {
  return methodNotAllowed();
}

/** No sessions to end. */
export async function DELETE() {
  return methodNotAllowed();
}
