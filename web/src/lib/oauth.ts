import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "./store";
import { getUser, type Role } from "./users";
import { publicBaseUrl } from "./urls";

/**
 * The app as an OAuth 2.1 authorization server for its own MCP endpoint
 * (docs/MCP_SERVER.md). This is what lets an agent — Claude Code, Claude
 * Desktop, claude.ai, ChatGPT — connect AS A PERSON: the client discovers
 * this server from `/api/mcp`'s 401, registers itself, sends the person to
 * the consent page, and exchanges the code for tokens bound to that
 * person's account. Every MCP action then audits under their email with
 * their role, and revoking one agent touches nobody else.
 *
 * The shape follows the MCP authorization spec's requirements and nothing
 * more: Protected Resource Metadata (RFC 9728) → Authorization Server
 * Metadata (RFC 8414) → Dynamic Client Registration (RFC 7591) → the
 * authorization-code grant with PKCE S256 (RFC 7636), public clients only
 * (no client secrets), resource indicators (RFC 8707), refresh-token
 * rotation, and revocation (RFC 7009).
 *
 * Storage is one JSON file on the volume (`OAUTH_PATH`). Tokens and codes
 * are stored as SHA-256 hashes: the file never holds anything a reader
 * could present. The user list stays the allow-list — a token whose user
 * has since been removed stops working at the next request, exactly as a
 * session cookie does.
 */

export const SCOPE = "house";
export const ACCESS_TTL_MS = 60 * 60_000; // 1 hour
export const REFRESH_TTL_MS = 90 * 24 * 3600_000; // the session cookie's own length
export const CODE_TTL_MS = 10 * 60_000;
/** A rotated-out refresh token stays valid this long, so a client whose
 *  network dropped the refresh response can retry without re-consenting. */
const REFRESH_GRACE_MS = 2 * 60_000;
/** Registration is unauthenticated (the spec's model); a client that never
 *  completes a grant is forgotten after this, and the table is capped. */
const UNUSED_CLIENT_TTL_MS = 7 * 24 * 3600_000;
const MAX_CLIENTS = 200;

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: string;
}

interface OAuthCode {
  hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  user: string;
  scope: string;
  resource: string | null;
  expires_at: number;
}

export interface OAuthGrant {
  id: string;
  client_id: string;
  client_name: string;
  user: string;
  scope: string;
  resource: string | null;
  created_at: string;
  last_used_at: string;
  access_hash: string;
  access_expires_at: number;
  refresh_hash: string;
  refresh_expires_at: number;
  previous_refresh_hash?: string;
  previous_refresh_until?: number;
}

interface Store {
  clients: OAuthClient[];
  codes: OAuthCode[];
  grants: OAuthGrant[];
}

export interface Tokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export type OAuthError = { ok: false; error: string; description: string };
type Ok<T> = { ok: true } & T;

/** The store: OAUTH_PATH, else the Railway volume when it is mounted,
 *  else the working directory (dev). Same rule as the watchers' state. */
function storePath(): string {
  if (process.env.OAUTH_PATH) return process.env.OAUTH_PATH;
  if (fs.existsSync("/data")) return "/data/oauth.json";
  return path.join(process.cwd(), "oauth.json");
}

function load(): Store {
  return readJsonFile<Store>(storePath(), { clients: [], codes: [], grants: [] });
}

/** Save, dropping what has expired: codes past their minute, grants whose
 *  refresh token is gone, clients that never earned a grant. */
function save(store: Store, nowMs = Date.now()): void {
  store.codes = store.codes.filter((c) => c.expires_at > nowMs);
  store.grants = store.grants.filter((g) => g.refresh_expires_at > nowMs);
  const inUse = new Set(store.grants.map((g) => g.client_id));
  store.clients = store.clients.filter(
    (c) => inUse.has(c.client_id) || nowMs - Date.parse(c.created_at) < UNUSED_CLIENT_TTL_MS,
  );
  if (store.clients.length > MAX_CLIENTS) {
    const spare = store.clients.filter((c) => !inUse.has(c.client_id));
    const drop = new Set(spare.slice(0, store.clients.length - MAX_CLIENTS).map((c) => c.client_id));
    store.clients = store.clients.filter((c) => !drop.has(c.client_id));
  }
  writeJsonFile(storePath(), store);
}

const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const token = () => crypto.randomBytes(32).toString("base64url");
const err = (error: string, description: string): OAuthError => ({ ok: false, error, description });

// ---- Discovery ----

export function issuer(origin?: string): string {
  return publicBaseUrl(origin);
}

/** The one protected resource: the MCP endpoint. */
export function mcpResourceUrl(origin?: string): string {
  return `${issuer(origin)}/api/mcp`;
}

export function protectedResourceMetadata(origin?: string) {
  return {
    resource: mcpResourceUrl(origin),
    authorization_servers: [issuer(origin)],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
    resource_name: "The house",
  };
}

export function authorizationServerMetadata(origin?: string) {
  const base = issuer(origin);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
}

/** The MCP endpoint's 401: tells the client where discovery starts. */
export function wwwAuthenticate(origin?: string, error?: string): string {
  const parts = [
    'realm="smarthome-mcp"',
    ...(error ? [`error="${error}"`] : []),
    `resource_metadata="${issuer(origin)}/.well-known/oauth-protected-resource"`,
  ];
  return `Bearer ${parts.join(", ")}`;
}

/** Discovery, registration, and token endpoints are called from anywhere
 *  (a browser-based client included); bearer auth carries no cookies, so
 *  an open origin is safe here. */
export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
  };
}

// ---- Clients (RFC 7591) ----

/**
 * Where a client may be sent back to with a code: https anywhere, plain
 * http only on the loopback (Claude Code's local callback), and native
 * private-use schemes. Never javascript:/data:/file:.
 */
export function redirectUriAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") {
    return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  }
  return !["javascript:", "data:", "file:", "vbscript:", "blob:"].includes(u.protocol);
}

export function registerClient(body: unknown, nowMs = Date.now()): Ok<{ client: OAuthClient }> | OAuthError {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (uris.length === 0 || uris.length > 10) return err("invalid_redirect_uri", "redirect_uris must list 1-10 URIs");
  const bad = uris.find((u) => !redirectUriAllowed(u));
  if (bad) return err("invalid_redirect_uri", `redirect URI not allowed: ${bad}`);
  const method = b.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    // Public clients only: PKCE is the proof of possession, not a secret.
    return err("invalid_client_metadata", "only token_endpoint_auth_method \"none\" is supported");
  }
  const name = typeof b.client_name === "string" && b.client_name.trim()
    ? b.client_name.trim().slice(0, 100)
    : "MCP client";
  const client: OAuthClient = {
    client_id: crypto.randomUUID(),
    client_name: name,
    redirect_uris: uris,
    created_at: new Date(nowMs).toISOString(),
  };
  const store = load();
  store.clients.push(client);
  save(store, nowMs);
  return { ok: true, client };
}

/** The registration response: what we stored, in RFC 7591's vocabulary. */
export function clientInformation(client: OAuthClient) {
  return {
    client_id: client.client_id,
    client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

export function getClient(clientId: string): OAuthClient | undefined {
  return load().clients.find((c) => c.client_id === clientId);
}

// ---- Authorization ----

export interface AuthorizeParams {
  client_id?: string | null;
  redirect_uri?: string | null;
  response_type?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  scope?: string | null;
  state?: string | null;
  resource?: string | null;
}

export interface ValidAuthorize {
  client: OAuthClient;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  state: string | null;
  resource: string | null;
}

/** An error the client may hear about: only once its identity and
 *  redirect URI have checked out (RFC 6749 §4.1.2.1). */
export type AuthorizeError = OAuthError & { redirect_uri: string | null; state: string | null };

const normaliseResource = (r: string) => r.replace(/\/+$/, "");

/**
 * Validate an authorization request before showing anyone a consent page.
 * The client and redirect URI are checked first, so that no later error
 * ever sends a code — or an error — to an address the client did not
 * register.
 */
export function validateAuthorizeRequest(
  p: AuthorizeParams,
  origin?: string,
): Ok<ValidAuthorize> | AuthorizeError {
  const fail = (error: string, description: string, redirect: string | null = null): AuthorizeError =>
    ({ ok: false, error, description, redirect_uri: redirect, state: p.state ?? null });
  if (!p.client_id) return fail("invalid_request", "client_id is required");
  const client = getClient(p.client_id);
  if (!client) return fail("invalid_client", "unknown client_id — register first");
  if (!p.redirect_uri) return fail("invalid_request", "redirect_uri is required");
  if (!client.redirect_uris.includes(p.redirect_uri)) {
    return fail("invalid_request", "redirect_uri is not registered for this client");
  }
  const redirect = p.redirect_uri;
  if (p.response_type !== "code") return fail("unsupported_response_type", "response_type must be \"code\"", redirect);
  if (!p.code_challenge || !/^[A-Za-z0-9._~-]{43,128}$/.test(p.code_challenge)) {
    return fail("invalid_request", "code_challenge (PKCE) is required", redirect);
  }
  if (p.code_challenge_method !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256", redirect);
  }
  let resource: string | null = null;
  if (p.resource) {
    if (normaliseResource(p.resource) !== mcpResourceUrl(origin)) {
      return fail("invalid_target", `this server only issues tokens for ${mcpResourceUrl(origin)}`, redirect);
    }
    resource = mcpResourceUrl(origin);
  }
  return {
    ok: true,
    client,
    redirect_uri: redirect,
    code_challenge: p.code_challenge,
    scope: (p.scope ?? "").trim() || SCOPE,
    state: p.state ?? null,
    resource,
  };
}

/** Append OAuth response parameters to a redirect URI, keeping any query
 *  the client registered. */
export function redirectWith(uri: string, params: Record<string, string | null>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

/** The person said yes: mint the single-use code the client will exchange. */
export function issueCode(valid: ValidAuthorize, user: string, nowMs = Date.now()): string {
  const code = token();
  const store = load();
  store.codes.push({
    hash: hash(code),
    client_id: valid.client.client_id,
    redirect_uri: valid.redirect_uri,
    code_challenge: valid.code_challenge,
    user,
    scope: valid.scope,
    resource: valid.resource,
    expires_at: nowMs + CODE_TTL_MS,
  });
  save(store, nowMs);
  return code;
}

// ---- Tokens ----

function mint(grant: OAuthGrant, nowMs: number): Tokens {
  const access = token();
  const refresh = token();
  grant.access_hash = hash(access);
  grant.access_expires_at = nowMs + ACCESS_TTL_MS;
  grant.refresh_hash = hash(refresh);
  grant.last_used_at = new Date(nowMs).toISOString();
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refresh,
    scope: grant.scope,
  };
}

export function exchangeCode(
  p: { code?: string | null; client_id?: string | null; redirect_uri?: string | null; code_verifier?: string | null; resource?: string | null },
  origin?: string,
  nowMs = Date.now(),
): Ok<{ tokens: Tokens }> | OAuthError {
  if (!p.code || !p.client_id || !p.code_verifier) {
    return err("invalid_request", "code, client_id and code_verifier are required");
  }
  const store = load();
  const idx = store.codes.findIndex((c) => c.hash === hash(p.code!));
  const code = idx >= 0 ? store.codes[idx] : null;
  // A code is spent the moment it is presented, right or wrong.
  if (idx >= 0) store.codes.splice(idx, 1);
  if (!code || code.expires_at <= nowMs) {
    save(store, nowMs);
    return err("invalid_grant", "authorization code is invalid or expired");
  }
  if (code.client_id !== p.client_id) {
    save(store, nowMs);
    return err("invalid_grant", "code was issued to a different client");
  }
  if (p.redirect_uri && p.redirect_uri !== code.redirect_uri) {
    save(store, nowMs);
    return err("invalid_grant", "redirect_uri does not match the authorization request");
  }
  const challenge = crypto.createHash("sha256").update(p.code_verifier).digest("base64url");
  if (challenge !== code.code_challenge) {
    save(store, nowMs);
    return err("invalid_grant", "PKCE verification failed");
  }
  if (p.resource && normaliseResource(p.resource) !== mcpResourceUrl(origin)) {
    save(store, nowMs);
    return err("invalid_target", `this server only issues tokens for ${mcpResourceUrl(origin)}`);
  }
  const user = getUser(code.user);
  if (!user) {
    save(store, nowMs);
    return err("invalid_grant", "the account is no longer on the user list");
  }
  const client = store.clients.find((c) => c.client_id === code.client_id);
  const grant: OAuthGrant = {
    id: crypto.randomBytes(6).toString("hex"),
    client_id: code.client_id,
    client_name: client?.client_name ?? "MCP client",
    user: user.email,
    scope: code.scope,
    resource: code.resource,
    created_at: new Date(nowMs).toISOString(),
    last_used_at: new Date(nowMs).toISOString(),
    access_hash: "",
    access_expires_at: 0,
    refresh_hash: "",
    refresh_expires_at: nowMs + REFRESH_TTL_MS,
  };
  const tokens = mint(grant, nowMs);
  store.grants.push(grant);
  save(store, nowMs);
  return { ok: true, tokens };
}

export function refreshTokens(
  p: { refresh_token?: string | null; client_id?: string | null; scope?: string | null },
  nowMs = Date.now(),
): Ok<{ tokens: Tokens }> | OAuthError {
  if (!p.refresh_token || !p.client_id) return err("invalid_request", "refresh_token and client_id are required");
  const h = hash(p.refresh_token);
  const store = load();
  const grant = store.grants.find(
    (g) => g.refresh_hash === h || (g.previous_refresh_hash === h && (g.previous_refresh_until ?? 0) > nowMs),
  );
  if (!grant || grant.refresh_expires_at <= nowMs) return err("invalid_grant", "refresh token is invalid or expired");
  if (grant.client_id !== p.client_id) return err("invalid_grant", "refresh token belongs to a different client");
  if (!getUser(grant.user)) {
    store.grants = store.grants.filter((g) => g.id !== grant.id);
    save(store, nowMs);
    return err("invalid_grant", "the account is no longer on the user list");
  }
  if (p.scope && p.scope.trim() !== grant.scope) return err("invalid_scope", "a refresh cannot widen the scope");
  // Rotate: the presented token retires (with a short grace for a lost
  // response); the previous-previous one is gone for good.
  if (grant.refresh_hash === h) {
    grant.previous_refresh_hash = h;
    grant.previous_refresh_until = nowMs + REFRESH_GRACE_MS;
  }
  const tokens = mint(grant, nowMs);
  save(store, nowMs);
  return { ok: true, tokens };
}

/** The MCP endpoint's check: a live access token → the person and their
 *  CURRENT role. Last-use is recorded, at most once a minute per grant. */
export function authenticateAccessToken(
  access: string,
  nowMs = Date.now(),
): { user: string; role: Role; grantId: string; clientName: string } | null {
  const h = hash(access);
  const store = load();
  const grant = store.grants.find((g) => g.access_hash === h);
  if (!grant || grant.access_expires_at <= nowMs) return null;
  const user = getUser(grant.user);
  if (!user) return null;
  if (nowMs - Date.parse(grant.last_used_at) > 60_000) {
    grant.last_used_at = new Date(nowMs).toISOString();
    save(store, nowMs);
  }
  return { user: user.email, role: user.role, grantId: grant.id, clientName: grant.client_name };
}

/** RFC 7009: revoking either token of a grant ends the whole grant. */
export function revokeToken(presented: string, nowMs = Date.now()): boolean {
  const h = hash(presented);
  const store = load();
  const before = store.grants.length;
  store.grants = store.grants.filter(
    (g) => g.access_hash !== h && g.refresh_hash !== h && g.previous_refresh_hash !== h,
  );
  if (store.grants.length === before) return false;
  save(store, nowMs);
  return true;
}

// ---- The person's view (the More screen) ----

export interface GrantView {
  id: string;
  clientName: string;
  user: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export function listGrants(user: string, role: Role, nowMs = Date.now()): GrantView[] {
  return load()
    .grants.filter((g) => g.refresh_expires_at > nowMs && (role === "admin" || g.user === user))
    .map((g) => ({
      id: g.id,
      clientName: g.client_name,
      user: g.user,
      createdAt: g.created_at,
      lastUsedAt: g.last_used_at,
      expiresAt: new Date(g.refresh_expires_at).toISOString(),
    }));
}

/** Disconnect one agent: your own, or anyone's as an admin. */
export function revokeGrant(id: string, user: string, role: Role, nowMs = Date.now()): boolean {
  const store = load();
  const grant = store.grants.find((g) => g.id === id);
  if (!grant || (role !== "admin" && grant.user !== user)) return false;
  store.grants = store.grants.filter((g) => g.id !== id);
  save(store, nowMs);
  return true;
}
