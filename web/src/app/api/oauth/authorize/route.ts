import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { authenticate } from "@/lib/auth";
import { googleConfigured } from "@/lib/google";
import { issueCode, redirectWith, validateAuthorizeRequest, type AuthorizeParams } from "@/lib/oauth";
import { usersConfigured } from "@/lib/session";
import { getUser } from "@/lib/users";

/**
 * The consent page's backend (`/oauth/authorize` is the page itself, which
 * is what clients are sent to). GET describes the request — who is asking,
 * who is signed in, how one can sign in — and POST records the decision
 * and hands back the redirect. Validation runs before either: a request
 * with a bad client or redirect URI never gets a consent card, and never
 * gets an error sent to an address the client did not register.
 */

function params(src: URLSearchParams | Record<string, unknown>): AuthorizeParams {
  const get = (k: string) => {
    const v = src instanceof URLSearchParams ? src.get(k) : src[k];
    return typeof v === "string" ? v : null;
  };
  return {
    client_id: get("client_id"),
    redirect_uri: get("redirect_uri"),
    response_type: get("response_type"),
    code_challenge: get("code_challenge"),
    code_challenge_method: get("code_challenge_method"),
    scope: get("scope"),
    state: get("state"),
    resource: get("resource"),
  };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const v = validateAuthorizeRequest(params(url.searchParams), url.origin);
  if (!v.ok) {
    return NextResponse.json({
      ok: false,
      error: v.error,
      description: v.description,
      // The client hears about a bad request only through its own,
      // registered redirect URI (RFC 6749 §4.1.2.1).
      redirect: v.redirect_uri ? redirectWith(v.redirect_uri, { error: v.error, error_description: v.description, state: v.state }) : null,
    });
  }
  const auth = authenticate(req);
  // Only a real account can be the subject of a grant: the dev fallback and
  // the app key are principals without a user record, and a token minted
  // for them would fail at first use.
  const user = auth.ok ? getUser(auth.user) : undefined;
  return NextResponse.json({
    ok: true,
    client: { name: v.client.client_name },
    scope: v.scope,
    user: user ? { email: user.email, role: user.role } : null,
    methods: { password: usersConfigured(), google: googleConfigured() },
  });
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const v = validateAuthorizeRequest(params(body), url.origin);
  if (!v.ok) return NextResponse.json({ error: v.error, description: v.description }, { status: 400 });

  const auth = authenticate(req);
  const user = auth.ok ? getUser(auth.user) : undefined;
  if (!user) return NextResponse.json({ error: "sign in with your account first" }, { status: 401 });

  if (body.decision !== "allow") {
    audit({
      ts: new Date().toISOString(), user: user.email, deviceId: "auth", entityId: "app.oauth",
      command: "agent_consent", args: { client: v.client.client_name, allowed: false }, ok: true, durationMs: 0,
    });
    return NextResponse.json({
      redirect: redirectWith(v.redirect_uri, { error: "access_denied", error_description: "the person declined", state: v.state }),
    });
  }
  const code = issueCode(v, user.email);
  audit({
    ts: new Date().toISOString(), user: user.email, deviceId: "auth", entityId: "app.oauth",
    command: "agent_consent", args: { client: v.client.client_name, allowed: true, role: user.role }, ok: true, durationMs: 0,
  });
  return NextResponse.json({ redirect: redirectWith(v.redirect_uri, { code, state: v.state }) });
}
