import { beforeEach, describe, expect, it } from "vitest";
import {
  appBaseUrl, createStateToken, emailFromIdTokenPayload, googleConfigured, redirectUri, verifyStateToken,
} from "../google";
import {
  createStateToken as createStateTokenScoped,
  verifyStateToken as verifyStateTokenScoped,
} from "../urls";

beforeEach(() => {
  process.env.APP_SESSION_SECRET = "test-secret";
  delete process.env.APP_BASE_URL;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

describe("configuration", () => {
  it("requires both client id and secret", () => {
    expect(googleConfigured()).toBe(false);
    process.env.GOOGLE_CLIENT_ID = "id";
    expect(googleConfigured()).toBe(false);
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    expect(googleConfigured()).toBe(true);
  });

  it("builds the redirect URI from APP_BASE_URL, falling back to the request origin", () => {
    expect(redirectUri("https://fallback.example")).toBe("https://fallback.example/api/auth/google/callback");
    process.env.APP_BASE_URL = "https://harakevet.app/";
    expect(redirectUri("https://fallback.example")).toBe("https://harakevet.app/api/auth/google/callback");
  });

  it("browser redirects never use the internal proxy origin when APP_BASE_URL is set", () => {
    process.env.APP_BASE_URL = "https://harakevet.app";
    // Behind Railway's proxy the request origin is the internal bind address.
    expect(appBaseUrl("https://0.0.0.0:8080")).toBe("https://harakevet.app");
    expect(new URL("/?error=x", appBaseUrl("https://0.0.0.0:8080")).href).toBe("https://harakevet.app/?error=x");
    delete process.env.APP_BASE_URL;
    expect(appBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });
});

describe("state tokens", () => {
  it("round-trips, expires after 10 minutes, and rejects tampering", () => {
    const t = createStateToken(1_000_000);
    expect(verifyStateToken(t, 1_000_000)).toBe(true);
    expect(verifyStateToken(t, 1_000_000 + 10 * 60_000 + 1)).toBe(false);
    expect(verifyStateToken(t.slice(0, -2) + "xx", 1_000_000)).toBe(false);
    expect(verifyStateToken("garbage", 1_000_000)).toBe(false);
  });

  it("never verifies in another flow: a Google sign-in state must not pass the Spotify callback", () => {
    // The Google mint route is unauthenticated (it's the sign-in button);
    // the Spotify mint is admin-gated. Cross-acceptance would let anyone
    // relink the household Spotify account with a fished Google state.
    const googleState = createStateToken(1_000_000);
    expect(verifyStateTokenScoped("spotify-link", googleState, 1_000_000)).toBe(false);
    const spotifyState = createStateTokenScoped("spotify-link", 1_000_000);
    expect(verifyStateToken(spotifyState, 1_000_000)).toBe(false);
    expect(verifyStateTokenScoped("spotify-link", spotifyState, 1_000_000)).toBe(true);
  });
});

describe("emailFromIdTokenPayload", () => {
  const now = 1_700_000_000_000;
  const good = {
    iss: "https://accounts.google.com",
    aud: "my-client-id",
    exp: now / 1000 + 60,
    email: "Person@Gmail.com",
    email_verified: true,
  };

  it("accepts a valid payload and normalizes the email", () => {
    expect(emailFromIdTokenPayload(good, "my-client-id", now)).toBe("person@gmail.com");
  });

  it("rejects wrong issuer, wrong audience, expiry, and unverified email", () => {
    expect(emailFromIdTokenPayload({ ...good, iss: "https://evil.example" }, "my-client-id", now)).toBeNull();
    expect(emailFromIdTokenPayload({ ...good, aud: "someone-else" }, "my-client-id", now)).toBeNull();
    expect(emailFromIdTokenPayload({ ...good, exp: now / 1000 - 1 }, "my-client-id", now)).toBeNull();
    expect(emailFromIdTokenPayload({ ...good, email_verified: false }, "my-client-id", now)).toBeNull();
    expect(emailFromIdTokenPayload({ ...good, email: undefined }, "my-client-id", now)).toBeNull();
  });
});
