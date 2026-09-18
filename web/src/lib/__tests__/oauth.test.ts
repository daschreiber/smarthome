import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACCESS_TTL_MS, CODE_TTL_MS, REFRESH_TTL_MS,
  authenticateAccessToken, authorizationServerMetadata, clientInformation, clientSecretOk, configuredClients,
  exchangeCode, getClient, issueCode, listGrants, protectedResourceMetadata, redirectUriAllowed, redirectWith,
  refreshTokens, registerClient, revokeGrant, revokeToken, validateAuthorizeRequest, wwwAuthenticate,
  type ValidAuthorize,
} from "../oauth";
import { addUser, removeUser } from "../users";

/**
 * The authorization server, walked the way an MCP client walks it:
 * discovery → registration → the authorization request → the code →
 * tokens → use, refresh, revoke. Clocks are explicit so expiry is tested,
 * not waited for.
 */

const BASE = "https://house.test";
const T0 = Date.parse("2026-09-18T10:00:00Z");

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-test-"));
  process.env.OAUTH_PATH = path.join(dir, "oauth.json");
  process.env.USERS_PATH = path.join(dir, "users.json");
  process.env.APP_BASE_URL = BASE;
  delete process.env.OAUTH_CLIENTS;
  addUser("daniel@example.com", "password1", "admin");
  addUser("guest@example.com", "password1", "guest");
});

/** One PKCE pair, the way a client makes it. */
function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function register(uris = ["https://claude.ai/api/mcp/auth_callback"]) {
  const r = registerClient({ client_name: "Claude", redirect_uris: uris }, T0);
  if (!r.ok) throw new Error(r.description);
  return r.client;
}

function authorize(over: Partial<Record<string, string | null>> = {}) {
  const client = register();
  const { verifier, challenge } = pkce();
  const v = validateAuthorizeRequest({
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${BASE}/api/mcp`,
    ...over,
  });
  return { client, verifier, v };
}

describe("discovery", () => {
  it("points a client from the MCP endpoint's 401 to the metadata, and the metadata to the endpoints", () => {
    expect(wwwAuthenticate()).toBe(`Bearer realm="smarthome-mcp", resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
    expect(wwwAuthenticate(undefined, "invalid_token")).toContain('error="invalid_token"');
    expect(protectedResourceMetadata()).toMatchObject({ resource: `${BASE}/api/mcp`, authorization_servers: [BASE] });
    expect(authorizationServerMetadata()).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/api/oauth/token`,
      registration_endpoint: `${BASE}/api/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    });
  });
});

describe("registration", () => {
  it("accepts https, loopback http, and native schemes; refuses plain http and script schemes", () => {
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectUriAllowed("http://localhost:52341/callback")).toBe(true);
    expect(redirectUriAllowed("http://127.0.0.1:8080/cb")).toBe(true);
    expect(redirectUriAllowed("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe(true);
    expect(redirectUriAllowed("http://evil.example/cb")).toBe(false);
    expect(redirectUriAllowed("javascript:alert(1)")).toBe(false);
    expect(redirectUriAllowed("https://x.test/cb#frag")).toBe(false);
    expect(redirectUriAllowed("not a url")).toBe(false);
  });

  it("registers a public client and answers in RFC 7591's vocabulary", () => {
    const client = register(["http://localhost:1234/cb"]);
    expect(clientInformation(client)).toMatchObject({
      client_id: client.client_id,
      client_name: "Claude",
      redirect_uris: ["http://localhost:1234/cb"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(clientInformation(client)).not.toHaveProperty("client_secret");
    const secretful = registerClient({ redirect_uris: ["https://x.test/cb"], token_endpoint_auth_method: "client_secret_basic" });
    expect(secretful.ok).toBe(false);
    const none = registerClient({ redirect_uris: [] });
    expect(none.ok).toBe(false);
  });
});

describe("the authorization request", () => {
  it("validates client, redirect URI, PKCE, response type and resource — and only tells a known client about errors", () => {
    const { v } = authorize();
    expect(v.ok).toBe(true);
    if (v.ok) expect(v).toMatchObject({ scope: "house", state: "xyz", resource: `${BASE}/api/mcp` });

    const unknown = validateAuthorizeRequest({ client_id: "nope", redirect_uri: "https://x.test/cb", response_type: "code" });
    expect(unknown).toMatchObject({ ok: false, error: "invalid_client", redirect_uri: null });

    const wrongUri = authorize({ redirect_uri: "https://evil.example/cb" }).v;
    expect(wrongUri).toMatchObject({ ok: false, error: "invalid_request", redirect_uri: null });

    const noPkce = authorize({ code_challenge: null }).v;
    expect(noPkce).toMatchObject({ ok: false, error: "invalid_request", redirect_uri: "https://claude.ai/api/mcp/auth_callback", state: "xyz" });

    const plain = authorize({ code_challenge_method: "plain" }).v;
    expect(plain).toMatchObject({ ok: false, error: "invalid_request" });

    const token = authorize({ response_type: "token" }).v;
    expect(token).toMatchObject({ ok: false, error: "unsupported_response_type" });

    const elsewhere = authorize({ resource: "https://other.test/mcp" }).v;
    expect(elsewhere).toMatchObject({ ok: false, error: "invalid_target" });

    const slash = authorize({ resource: `${BASE}/api/mcp/` }).v;
    expect(slash.ok).toBe(true);
  });

  it("builds redirects that keep the client's own query string", () => {
    expect(redirectWith("https://x.test/cb?app=1", { code: "abc", state: "s" })).toBe("https://x.test/cb?app=1&code=abc&state=s");
    expect(redirectWith("https://x.test/cb", { error: "access_denied", state: null })).toBe("https://x.test/cb?error=access_denied");
  });
});

describe("codes and tokens", () => {
  function grant() {
    const { client, verifier, v } = authorize();
    const code = issueCode(v as ValidAuthorize, "daniel@example.com", T0);
    return { client, verifier, code };
  }

  it("exchanges a code once, with the right verifier, client, and redirect URI", () => {
    const { client, verifier, code } = grant();
    const wrongVerifier = exchangeCode({ code, client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_verifier: "x".repeat(43) }, undefined, T0);
    expect(wrongVerifier).toMatchObject({ ok: false, error: "invalid_grant" });
    // A code is spent on its first presentation, right or wrong.
    const again = exchangeCode({ code, client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_verifier: verifier }, undefined, T0);
    expect(again).toMatchObject({ ok: false, error: "invalid_grant" });

    const { client: c2, verifier: v2, code: code2 } = grant();
    const unknownClient = exchangeCode({ code: code2, client_id: "someone-else", redirect_uri: c2.redirect_uris[0], code_verifier: v2 }, undefined, T0);
    expect(unknownClient).toMatchObject({ ok: false, error: "invalid_client" });
    // A real, different client presenting another client's code.
    const other = register(["https://other.test/cb"]);
    const otherClient = exchangeCode({ code: code2, client_id: other.client_id, redirect_uri: c2.redirect_uris[0], code_verifier: v2 }, undefined, T0);
    expect(otherClient).toMatchObject({ ok: false, error: "invalid_grant" });

    const { client: c3, verifier: v3, code: code3 } = grant();
    const r = exchangeCode({ code: code3, client_id: c3.client_id, redirect_uri: c3.redirect_uris[0], code_verifier: v3 }, undefined, T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens).toMatchObject({ token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, scope: "house" });
    expect(r.tokens.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.tokens.refresh_token).not.toBe(r.tokens.access_token);
    // Nothing presentable is on disk.
    const raw = fs.readFileSync(process.env.OAUTH_PATH!, "utf8");
    expect(raw).not.toContain(r.tokens.access_token);
    expect(raw).not.toContain(r.tokens.refresh_token);
    expect(raw).not.toContain(code3);
  });

  it("an expired code is refused", () => {
    const { client, verifier, code } = grant();
    const late = exchangeCode({ code, client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_verifier: verifier }, undefined, T0 + CODE_TTL_MS + 1);
    expect(late).toMatchObject({ ok: false, error: "invalid_grant" });
  });

  it("an access token answers as the person with their CURRENT role, until it expires or they are removed", () => {
    const { client, verifier, v } = authorize();
    const code = issueCode(v as ValidAuthorize, "guest@example.com", T0);
    const r = exchangeCode({ code, client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_verifier: verifier }, undefined, T0);
    if (!r.ok) throw new Error(r.description);
    expect(authenticateAccessToken(r.tokens.access_token, T0 + 1000)).toMatchObject({ user: "guest@example.com", role: "guest", clientName: "Claude" });
    expect(authenticateAccessToken(r.tokens.access_token, T0 + ACCESS_TTL_MS + 1)).toBeNull();
    expect(authenticateAccessToken("not-a-token", T0)).toBeNull();
    removeUser("guest@example.com");
    expect(authenticateAccessToken(r.tokens.access_token, T0 + 1000)).toBeNull();
    expect(refreshTokens({ refresh_token: r.tokens.refresh_token, client_id: client.client_id }, T0 + 1000)).toMatchObject({ ok: false, error: "invalid_grant" });
  });

  it("refresh rotates the pair, with a short grace for the retired token, and stops at the refresh lifetime", () => {
    const { client, verifier, code } = grant();
    const r = exchangeCode({ code, client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_verifier: verifier }, undefined, T0);
    if (!r.ok) throw new Error(r.description);
    const t1 = T0 + ACCESS_TTL_MS + 5000;
    const r2 = refreshTokens({ refresh_token: r.tokens.refresh_token, client_id: client.client_id }, t1);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.tokens.access_token).not.toBe(r.tokens.access_token);
    expect(r2.tokens.refresh_token).not.toBe(r.tokens.refresh_token);
    expect(authenticateAccessToken(r.tokens.access_token, t1)).toBeNull();
    expect(authenticateAccessToken(r2.tokens.access_token, t1)).toMatchObject({ user: "daniel@example.com" });
    // The retired refresh token still works for a moment (a lost response)…
    const retry = refreshTokens({ refresh_token: r.tokens.refresh_token, client_id: client.client_id }, t1 + 30_000);
    expect(retry.ok).toBe(true);
    // …but not for long.
    const tooLate = refreshTokens({ refresh_token: r.tokens.refresh_token, client_id: client.client_id }, t1 + 3 * 60_000);
    expect(tooLate).toMatchObject({ ok: false, error: "invalid_grant" });
    // Another client can't use it.
    if (retry.ok) {
      expect(refreshTokens({ refresh_token: retry.tokens.refresh_token, client_id: "other" }, t1 + 40_000)).toMatchObject({ ok: false });
      expect(refreshTokens({ refresh_token: retry.tokens.refresh_token, client_id: client.client_id }, T0 + REFRESH_TTL_MS + 1)).toMatchObject({ ok: false, error: "invalid_grant" });
    }
  });

  it("revoking either token ends the grant; the person sees and disconnects their own", () => {
    const { client, verifier, code } = grant();
    const r = exchangeCode({ code, client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_verifier: verifier }, undefined, T0);
    if (!r.ok) throw new Error(r.description);
    expect(listGrants("daniel@example.com", "admin", T0)).toEqual([
      expect.objectContaining({ clientName: "Claude", user: "daniel@example.com" }),
    ]);
    expect(listGrants("guest@example.com", "guest", T0)).toEqual([]);
    expect(revokeGrant(listGrants("daniel@example.com", "admin", T0)[0].id, "guest@example.com", "guest", T0)).toBe(false);
    expect(revokeToken(r.tokens.refresh_token, T0)).toBe(true);
    expect(revokeToken(r.tokens.refresh_token, T0)).toBe(false);
    expect(authenticateAccessToken(r.tokens.access_token, T0)).toBeNull();
    expect(listGrants("daniel@example.com", "admin", T0)).toEqual([]);

    const { client: c2, verifier: v2, code: code2 } = grant();
    const r2 = exchangeCode({ code: code2, client_id: c2.client_id, redirect_uri: c2.redirect_uris[0], code_verifier: v2 }, undefined, T0);
    if (!r2.ok) throw new Error(r2.description);
    const id = listGrants("daniel@example.com", "admin", T0)[0].id;
    expect(revokeGrant(id, "daniel@example.com", "admin", T0)).toBe(true);
    expect(authenticateAccessToken(r2.tokens.access_token, T0)).toBeNull();
  });
});

describe("configured confidential clients (OAUTH_CLIENTS — Alexa+)", () => {
  const ALEXA = {
    client_id: "alexa-house",
    client_secret: "s3cret-s3cret-s3cret",
    client_name: "Alexa+",
    redirect_uris: ["https://layla.amazon.com/api/skill/link/M1", "https://pitangui.amazon.com/api/skill/link/M1"],
  };

  it("reads the env, skips broken entries, never exposes the secret through getClient", () => {
    process.env.OAUTH_CLIENTS = JSON.stringify([
      ALEXA,
      { client_id: "short", client_secret: "tiny", redirect_uris: ["https://x.test/cb"] },
      { client_id: "nowhere", client_secret: "s3cret-s3cret-s3cret", redirect_uris: ["http://evil.example/cb"] },
    ]);
    expect(configuredClients().map((c) => c.client_id)).toEqual(["alexa-house"]);
    const client = getClient("alexa-house");
    expect(client).toMatchObject({ client_id: "alexa-house", client_name: "Alexa+", confidential: true, redirect_uris: ALEXA.redirect_uris });
    expect(client).not.toHaveProperty("secret");
    expect(clientSecretOk("alexa-house", ALEXA.client_secret)).toBe(true);
    expect(clientSecretOk("alexa-house", "wrong")).toBe(false);
    process.env.OAUTH_CLIENTS = "not json";
    expect(configuredClients()).toEqual([]);
    expect(authorizationServerMetadata().token_endpoint_auth_methods_supported).toEqual(["none", "client_secret_basic", "client_secret_post"]);
  });

  it("may skip PKCE (the secret is its proof), must send the right secret, exactly one of its redirect URIs", () => {
    process.env.OAUTH_CLIENTS = JSON.stringify([ALEXA]);
    const noPkce = validateAuthorizeRequest({
      client_id: "alexa-house", redirect_uri: ALEXA.redirect_uris[1], response_type: "code", state: "s",
    });
    expect(noPkce.ok).toBe(true);
    if (!noPkce.ok) return;
    expect(noPkce.code_challenge).toBeNull();
    const badPkce = validateAuthorizeRequest({
      client_id: "alexa-house", redirect_uri: ALEXA.redirect_uris[1], response_type: "code", code_challenge: "x", code_challenge_method: "S256",
    });
    expect(badPkce).toMatchObject({ ok: false, error: "invalid_request" });
    const elsewhere = validateAuthorizeRequest({ client_id: "alexa-house", redirect_uri: "https://layla.amazon.com/api/skill/link/OTHER", response_type: "code" });
    expect(elsewhere).toMatchObject({ ok: false, redirect_uri: null });

    const code = issueCode(noPkce, "daniel@example.com", T0);
    const noSecret = exchangeCode({ code, client_id: "alexa-house", redirect_uri: ALEXA.redirect_uris[1] }, undefined, T0);
    expect(noSecret).toMatchObject({ ok: false, error: "invalid_client" });
    // The client check comes before the code is spent, so a retry with the secret works.
    const wrong = exchangeCode({ code, client_id: "alexa-house", client_secret: "wrong", redirect_uri: ALEXA.redirect_uris[1] }, undefined, T0);
    expect(wrong).toMatchObject({ ok: false, error: "invalid_client" });
    const r = exchangeCode({ code, client_id: "alexa-house", client_secret: ALEXA.client_secret, redirect_uri: ALEXA.redirect_uris[1] }, undefined, T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(authenticateAccessToken(r.tokens.access_token, T0)).toMatchObject({ user: "daniel@example.com", clientName: "Alexa+" });
    expect(refreshTokens({ refresh_token: r.tokens.refresh_token, client_id: "alexa-house" }, T0 + 1000)).toMatchObject({ ok: false, error: "invalid_client" });
    expect(refreshTokens({ refresh_token: r.tokens.refresh_token, client_id: "alexa-house", client_secret: ALEXA.client_secret }, T0 + 1000).ok).toBe(true);
    expect(listGrants("daniel@example.com", "admin", T0)).toEqual([expect.objectContaining({ clientName: "Alexa+" })]);
  });

  it("when it does send PKCE, the verifier is still checked; public clients still cannot skip it", () => {
    process.env.OAUTH_CLIENTS = JSON.stringify([ALEXA]);
    const { verifier, challenge } = pkce();
    const v = validateAuthorizeRequest({
      client_id: "alexa-house", redirect_uri: ALEXA.redirect_uris[0], response_type: "code", code_challenge: challenge, code_challenge_method: "S256",
    }) as ValidAuthorize;
    const code = issueCode(v, "daniel@example.com", T0);
    const wrongVerifier = exchangeCode({ code, client_id: "alexa-house", client_secret: ALEXA.client_secret, redirect_uri: ALEXA.redirect_uris[0], code_verifier: "x".repeat(43) }, undefined, T0);
    expect(wrongVerifier).toMatchObject({ ok: false, error: "invalid_grant" });
    const code2 = issueCode(v, "daniel@example.com", T0);
    expect(exchangeCode({ code: code2, client_id: "alexa-house", client_secret: ALEXA.client_secret, redirect_uri: ALEXA.redirect_uris[0], code_verifier: verifier }, undefined, T0).ok).toBe(true);
    const publicNoPkce = authorize({ code_challenge: null }).v;
    expect(publicNoPkce).toMatchObject({ ok: false, error: "invalid_request" });
  });
});
