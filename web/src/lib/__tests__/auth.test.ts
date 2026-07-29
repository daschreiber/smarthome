import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { authenticate } from "../auth";
import { createSessionToken } from "../session";

/** NODE_ENV is typed readonly; tests legitimately vary it. */
function setNodeEnv(v: string) {
  (process.env as Record<string, string>).NODE_ENV = v;
}

/** Minimal stand-in for the two request surfaces authenticate() reads. */
function req(opts: { session?: string; appKey?: string } = {}): NextRequest {
  return {
    cookies: {
      get: (name: string) =>
        name === "session" && opts.session !== undefined ? { name, value: opts.session } : undefined,
    },
    headers: {
      get: (name: string) => (name === "x-app-key" ? opts.appKey ?? null : null),
    },
  } as unknown as NextRequest;
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"));
  process.env.USERS_PATH = path.join(dir, "users.json");
  process.env.APP_SESSION_SECRET = "test-secret";
  process.env.APP_USERS = "admin@example.com:pw-admin,member@example.com:pw-member";
  delete process.env.APP_KEY;
  setNodeEnv("test");
});

describe("session cookies", () => {
  it("authenticates a valid session with the user's stored role", () => {
    const out = authenticate(req({ session: createSessionToken("member@example.com") }));
    expect(out).toEqual({ ok: true, user: "member@example.com", role: "member" });
    const admin = authenticate(req({ session: createSessionToken("admin@example.com") }));
    expect(admin.role).toBe("admin");
  });

  it("rejects a garbage token, and a valid token for a deleted user", () => {
    expect(authenticate(req({ session: "not-a-token" })).ok).toBe(false);
    const token = createSessionToken("ghost@example.com"); // never in the store
    expect(authenticate(req({ session: token })).ok).toBe(false);
  });
});

describe("APP_KEY transition gate", () => {
  it("grants admin on an exact header match, refuses otherwise", () => {
    process.env.APP_KEY = "k-123";
    expect(authenticate(req({ appKey: "k-123" }))).toEqual({ ok: true, user: "app-key", role: "admin" });
    expect(authenticate(req({ appKey: "wrong" })).ok).toBe(false);
    expect(authenticate(req()).ok).toBe(false);
  });

  it("loses to a valid session — cookie auth is checked first", () => {
    process.env.APP_KEY = "k-123";
    const out = authenticate(req({ session: createSessionToken("member@example.com"), appKey: "wrong" }));
    expect(out.ok).toBe(true);
    expect(out.user).toBe("member@example.com");
  });
});

describe("nothing configured", () => {
  beforeEach(() => {
    delete process.env.APP_USERS;
    process.env.USERS_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "auth-empty-")), "users.json");
  });

  it("fails closed in production", () => {
    setNodeEnv("production");
    expect(authenticate(req()).ok).toBe(false);
  });

  it("stays open in local dev only", () => {
    setNodeEnv("development");
    expect(authenticate(req())).toEqual({ ok: true, user: "dev", role: "admin" });
  });
});
