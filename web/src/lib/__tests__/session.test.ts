import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { checkCredentials, createSessionToken, verifySessionToken } from "../session";

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-test-"));
  process.env.USERS_PATH = path.join(dir, "users.json");
  process.env.APP_SESSION_SECRET = "test-secret";
  process.env.APP_USERS = "daniel@example.com:pw-one,daniella@example.com:pw-two";
});

describe("checkCredentials", () => {
  it("accepts a listed user with the right password", () => {
    expect(checkCredentials("daniel@example.com", "pw-one")).toBe(true);
    expect(checkCredentials("Daniella@Example.com", "pw-two")).toBe(true);
  });
  it("rejects wrong passwords and unknown users", () => {
    expect(checkCredentials("daniel@example.com", "pw-two")).toBe(false);
    expect(checkCredentials("intruder@example.com", "pw-one")).toBe(false);
  });
});

describe("session tokens", () => {
  it("round-trips a valid token", () => {
    const t = createSessionToken("daniel@example.com");
    expect(verifySessionToken(t)).toBe("daniel@example.com");
  });
  it("rejects tampered tokens", () => {
    const t = createSessionToken("daniel@example.com");
    expect(verifySessionToken(t.slice(0, -2) + "xx")).toBeNull();
    const forged = Buffer.from("admin@example.com|9999999999999").toString("base64url");
    expect(verifySessionToken(`${forged}.${t.split(".")[1]}`)).toBeNull();
  });
  it("rejects expired tokens", () => {
    const t = createSessionToken("daniel@example.com", Date.now() - 91 * 24 * 3600 * 1000);
    expect(verifySessionToken(t)).toBeNull();
  });
});
