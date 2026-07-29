import crypto from "node:crypto";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "./store";

/**
 * User store: a JSON file (point USERS_PATH at a persistent volume in
 * production). Passwords are scrypt-hashed. APP_USERS seeds the store once
 * when it is empty — the first entry becomes the admin — after which the
 * store is the source of truth and the env var is ignored.
 *
 * Roles: "admin" manages users; "member" controls and programs the house;
 * "guest" controls devices but can't program anything (see
 * lib/permissions.ts for the capability matrix).
 */

export type Role = "admin" | "member" | "guest";

export interface UserRecord {
  email: string;
  passwordHash: string;
  role: Role;
  createdAt: string;
}

function usersPath(): string {
  return process.env.USERS_PATH || path.join(process.cwd(), "users.json");
}

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString("hex")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const ref = Buffer.from(hash, "hex");
  return test.length === ref.length && crypto.timingSafeEqual(test, ref);
}

// Missing file = empty store; corrupt file = loud error (lib/store.ts).
// Critical here: if a truncated users.json read as "empty", ensureSeeded()
// would re-seed from APP_USERS and overwrite every account.
function load(): UserRecord[] {
  return readJsonFile<UserRecord[]>(usersPath(), []);
}

function save(users: UserRecord[]): void {
  writeJsonFile(usersPath(), users);
}

export function ensureSeeded(): void {
  if (load().length > 0) return;
  const env = process.env.APP_USERS;
  if (!env) return;
  const users: UserRecord[] = [];
  env.split(",").forEach((pair, i) => {
    const idx = pair.indexOf(":");
    if (idx < 1) return;
    users.push({
      email: pair.slice(0, idx).trim().toLowerCase(),
      passwordHash: hashPassword(pair.slice(idx + 1)),
      role: i === 0 ? "admin" : "member",
      createdAt: new Date().toISOString(),
    });
  });
  if (users.length) save(users);
}

export function getUser(email: string): UserRecord | undefined {
  ensureSeeded();
  const norm = email.trim().toLowerCase();
  return load().find((u) => u.email === norm);
}

export function listUsers(): Array<Omit<UserRecord, "passwordHash">> {
  ensureSeeded();
  return load().map(({ passwordHash: _ph, ...u }) => u);
}

export function anyUsers(): boolean {
  ensureSeeded();
  return load().length > 0;
}

export function addUser(email: string, password: string | null, role: Role = "member"): void {
  ensureSeeded();
  const norm = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm)) throw new Error("invalid email address");
  // No password = Google-sign-in-only user. The "!" sentinel can never
  // verify (verifyPassword requires salt:hash), and a reset link can set a
  // real password later if they ever need one.
  if (password != null && password.length < 8) throw new Error("password must be at least 8 characters");
  const users = load();
  if (users.some((u) => u.email === norm)) throw new Error("user already exists");
  users.push({
    email: norm,
    passwordHash: password == null ? "!" : hashPassword(password),
    role,
    createdAt: new Date().toISOString(),
  });
  save(users);
}

export function removeUser(email: string): void {
  const norm = email.trim().toLowerCase();
  const users = load();
  const target = users.find((u) => u.email === norm);
  if (!target) throw new Error("no such user");
  if (target.role === "admin" && users.filter((u) => u.role === "admin").length === 1) {
    throw new Error("cannot remove the last admin");
  }
  save(users.filter((u) => u.email !== norm));
}

export function setRole(email: string, role: Role): void {
  const norm = email.trim().toLowerCase();
  const users = load();
  const target = users.find((u) => u.email === norm);
  if (!target) throw new Error("no such user");
  if (
    target.role === "admin" &&
    role !== "admin" &&
    users.filter((u) => u.role === "admin").length === 1
  ) {
    throw new Error("cannot demote the last admin");
  }
  target.role = role;
  save(users);
}

export function setPassword(email: string, password: string): void {
  if (password.length < 8) throw new Error("password must be at least 8 characters");
  const norm = email.trim().toLowerCase();
  const users = load();
  const target = users.find((u) => u.email === norm);
  if (!target) throw new Error("no such user");
  target.passwordHash = hashPassword(password);
  save(users);
}

/**
 * Stateless single-use reset tokens: HMAC over email + expiry + a
 * fingerprint of the current password hash. Changing the password (i.e.
 * completing a reset) invalidates every outstanding token for that user.
 */
function resetSecret(): string {
  const s = process.env.APP_SESSION_SECRET;
  if (!s) throw new Error("APP_SESSION_SECRET is not set");
  return s + "|reset";
}

export function createResetToken(email: string, nowMs = Date.now()): string {
  const user = getUser(email);
  if (!user) throw new Error("no such user");
  const exp = nowMs + 3600_000;
  const fp = crypto.createHash("sha256").update(user.passwordHash).digest("hex").slice(0, 12);
  const payload = Buffer.from(`${user.email}|${exp}|${fp}`).toString("base64url");
  const sig = crypto.createHmac("sha256", resetSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyResetToken(token: string, nowMs = Date.now()): string | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const expect = crypto.createHmac("sha256", resetSecret()).update(payload).digest("base64url");
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [email, expStr, fp] = Buffer.from(payload, "base64url").toString().split("|");
  if (!email || !expStr || !fp) return null;
  if (!Number.isFinite(Number(expStr)) || nowMs > Number(expStr)) return null;
  const user = getUser(email);
  if (!user) return null;
  const currentFp = crypto.createHash("sha256").update(user.passwordHash).digest("hex").slice(0, 12);
  if (fp !== currentFp) return null; // already used, or password changed since
  return user.email;
}
