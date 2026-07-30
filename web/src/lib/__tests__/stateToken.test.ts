import { beforeEach, describe, expect, it } from "vitest";
import { createStateToken, readStateToken, verifyStateToken } from "../urls";

/**
 * The OAuth state now carries WHOSE Spotify link a callback is completing.
 * The Spotify callback has no app credentials of its own, so this subject is
 * the only thing standing between "Ruth links her account" and "Ruth comes
 * back holding a state that overwrites the house account".
 */

beforeEach(() => {
  process.env.APP_SESSION_SECRET = "test-secret";
});

describe("subject-carrying state", () => {
  it("round-trips the subject", () => {
    const t = createStateToken("spotify-link", 1_000_000, "user:ruth@example.com");
    expect(readStateToken("spotify-link", t, 1_000_000)).toEqual({
      ok: true,
      subject: "user:ruth@example.com",
    });
  });

  it("rejects a state whose subject has been edited", () => {
    const t = createStateToken("spotify-link", 1_000_000, "user:ruth@example.com");
    const [payload, sig] = t.split(".");
    const tampered = `${Buffer.from("nonce|9999999999999|" + Buffer.from("house").toString("base64url")).toString("base64url")}.${sig}`;
    expect(readStateToken("spotify-link", tampered, 1_000_000).ok).toBe(false);
    expect(payload).not.toBe("");
  });

  it("still expires", () => {
    const t = createStateToken("spotify-link", 1_000_000, "user:ruth@example.com");
    expect(readStateToken("spotify-link", t, 1_000_000 + 10 * 60_000 + 1).ok).toBe(false);
  });

  it("stays scoped to its purpose", () => {
    const t = createStateToken("spotify-link", 1_000_000, "user:ruth@example.com");
    expect(readStateToken("google-signin", t, 1_000_000).ok).toBe(false);
  });

  it("keeps the old subject-less shape working across a deploy", () => {
    // A state minted by the previous build must still verify, and read as
    // "no subject" so the callback treats it as the house link it was.
    const t = createStateToken("spotify-link", 1_000_000);
    expect(readStateToken("spotify-link", t, 1_000_000)).toEqual({ ok: true, subject: null });
    expect(verifyStateToken("spotify-link", t, 1_000_000)).toBe(true);
  });
});
