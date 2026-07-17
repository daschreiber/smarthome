import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addUser, createResetToken, ensureSeeded, getUser, hashPassword, listUsers,
  removeUser, setPassword, setRole, verifyPassword, verifyResetToken,
} from "../users";
import { canManageUsers, canProgram } from "../permissions";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "users-test-"));
  process.env.USERS_PATH = path.join(dir, "users.json");
  process.env.APP_SESSION_SECRET = "test-secret";
  delete process.env.APP_USERS;
});

describe("roles and permissions", () => {
  it("guest can't program or manage; member programs; admin does both", () => {
    expect(canProgram("guest")).toBe(false);
    expect(canProgram("member")).toBe(true);
    expect(canProgram("admin")).toBe(true);
    expect(canManageUsers("guest")).toBe(false);
    expect(canManageUsers("member")).toBe(false);
    expect(canManageUsers("admin")).toBe(true);
  });

  it("changes a user's role but never demotes the last admin", () => {
    addUser("admin@x.com", "adminpass1", "admin");
    addUser("kid@x.com", "kidpass123", "member");
    setRole("kid@x.com", "guest");
    expect(getUser("kid@x.com")!.role).toBe("guest");
    expect(() => setRole("admin@x.com", "member")).toThrow(/last admin/);
    setRole("kid@x.com", "admin");
    setRole("admin@x.com", "member"); // fine now — kid is an admin
    expect(getUser("admin@x.com")!.role).toBe("member");
  });
});

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", () => {
    const h = hashPassword("correct horse");
    expect(verifyPassword("correct horse", h)).toBe(true);
    expect(verifyPassword("wrong pony", h)).toBe(false);
  });

  it("a Google-only user (no password) can never sign in by password", () => {
    addUser("g@x.com", null, "guest");
    const u = getUser("g@x.com")!;
    expect(verifyPassword("", u.passwordHash)).toBe(false);
    expect(verifyPassword("!", u.passwordHash)).toBe(false);
    expect(verifyPassword("anything", u.passwordHash)).toBe(false);
    // A reset link can still give them a real password later.
    setPassword("g@x.com", "real-password-1");
    expect(verifyPassword("real-password-1", getUser("g@x.com")!.passwordHash)).toBe(true);
  });
});

describe("store and seeding", () => {
  it("seeds once from APP_USERS with the first entry as admin", () => {
    process.env.APP_USERS = "a@x.com:password-a,b@x.com:password-b";
    ensureSeeded();
    const users = listUsers();
    expect(users.map((u) => [u.email, u.role])).toEqual([
      ["a@x.com", "admin"],
      ["b@x.com", "member"],
    ]);
    expect(verifyPassword("password-a", getUser("a@x.com")!.passwordHash)).toBe(true);
  });

  it("adds and removes users, protecting the last admin", () => {
    addUser("admin@x.com", "adminpass1", "admin");
    addUser("kid@x.com", "kidpass123");
    expect(listUsers()).toHaveLength(2);
    expect(() => removeUser("admin@x.com")).toThrow(/last admin/);
    removeUser("kid@x.com");
    expect(listUsers()).toHaveLength(1);
  });

  it("rejects duplicates, bad emails, and short passwords", () => {
    addUser("a@x.com", "longenough", "admin");
    expect(() => addUser("a@x.com", "longenough")).toThrow(/exists/);
    expect(() => addUser("not-an-email", "longenough")).toThrow(/invalid email/);
    expect(() => addUser("b@x.com", "short")).toThrow(/at least 8/);
  });
});

describe("reset tokens", () => {
  beforeEach(() => {
    addUser("a@x.com", "original-pass", "admin");
  });

  it("round-trips and allows a password change", () => {
    const t = createResetToken("a@x.com");
    expect(verifyResetToken(t)).toBe("a@x.com");
    setPassword("a@x.com", "brand-new-pass");
    expect(verifyPassword("brand-new-pass", getUser("a@x.com")!.passwordHash)).toBe(true);
  });

  it("is single-use: changing the password invalidates outstanding tokens", () => {
    const t = createResetToken("a@x.com");
    setPassword("a@x.com", "changed-already");
    expect(verifyResetToken(t)).toBeNull();
  });

  it("rejects tampered and expired tokens", () => {
    const t = createResetToken("a@x.com");
    expect(verifyResetToken(t.slice(0, -3) + "abc")).toBeNull();
    const old = createResetToken("a@x.com", Date.now() - 2 * 3600_000);
    expect(verifyResetToken(old)).toBeNull();
  });
});
