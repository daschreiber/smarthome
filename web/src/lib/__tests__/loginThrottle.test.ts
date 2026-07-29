import { beforeEach, describe, expect, it } from "vitest";
import {
  throttleStatus,
  recordFailure,
  recordSuccess,
  clientIp,
  throttleLimits,
  __resetThrottle,
} from "../loginThrottle";

const { ACCOUNT_MAX, IP_MAX, LOCKOUT_MS, WINDOW_MS } = throttleLimits;
const T0 = 1_000_000_000; // fixed base time so tests never touch the wall clock

beforeEach(() => __resetThrottle());

describe("account lockout", () => {
  it("is not locked before the threshold", () => {
    for (let i = 0; i < ACCOUNT_MAX - 1; i++) recordFailure("a@x.com", "1.1.1.1", T0);
    expect(throttleStatus("a@x.com", "1.1.1.1", T0).locked).toBe(false);
  });

  it("locks the account once it reaches the threshold", () => {
    for (let i = 0; i < ACCOUNT_MAX; i++) recordFailure("a@x.com", "1.1.1.1", T0);
    const s = throttleStatus("a@x.com", "1.1.1.1", T0);
    expect(s.locked).toBe(true);
    expect(s.retryAfterMs).toBe(LOCKOUT_MS);
  });

  it("locks a targeted account even when the source IP rotates", () => {
    for (let i = 0; i < ACCOUNT_MAX; i++) recordFailure("a@x.com", `10.0.0.${i}`, T0);
    // A fresh IP still sees the account locked.
    expect(throttleStatus("a@x.com", "9.9.9.9", T0).locked).toBe(true);
  });

  it("clears the counter on a successful check", () => {
    for (let i = 0; i < ACCOUNT_MAX - 1; i++) recordFailure("a@x.com", "1.1.1.1", T0);
    recordSuccess("a@x.com", "1.1.1.1");
    for (let i = 0; i < ACCOUNT_MAX - 1; i++) recordFailure("a@x.com", "1.1.1.1", T0);
    expect(throttleStatus("a@x.com", "1.1.1.1", T0).locked).toBe(false);
  });

  it("expires the lockout after the lockout window", () => {
    for (let i = 0; i < ACCOUNT_MAX; i++) recordFailure("a@x.com", "1.1.1.1", T0);
    expect(throttleStatus("a@x.com", "1.1.1.1", T0 + LOCKOUT_MS - 1).locked).toBe(true);
    expect(throttleStatus("a@x.com", "1.1.1.1", T0 + LOCKOUT_MS).locked).toBe(false);
  });

  it("forgets stale failures that fall outside the counting window", () => {
    for (let i = 0; i < ACCOUNT_MAX - 1; i++) recordFailure("a@x.com", "1.1.1.1", T0);
    // A failure long after the window resets the count rather than adding to it.
    recordFailure("a@x.com", "1.1.1.1", T0 + WINDOW_MS + 1);
    expect(throttleStatus("a@x.com", "1.1.1.1", T0 + WINDOW_MS + 1).locked).toBe(false);
  });
});

describe("IP lockout (password spray across accounts)", () => {
  it("locks a source IP that sprays many accounts before any one account trips", () => {
    for (let i = 0; i < IP_MAX; i++) recordFailure(`user${i}@x.com`, "5.5.5.5", T0);
    // No single account is locked, but the IP is.
    expect(throttleStatus("user0@x.com", "5.5.5.5", T0).locked).toBe(true);
    expect(throttleStatus("fresh@x.com", "5.5.5.5", T0).locked).toBe(true);
  });
});

describe("clientIp", () => {
  const withHeaders = (h: Record<string, string>) => ({
    headers: { get: (n: string) => h[n.toLowerCase()] ?? null },
  });
  it("takes the first hop of x-forwarded-for", () => {
    expect(clientIp(withHeaders({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
  });
  it("falls back to x-real-ip, then unknown", () => {
    expect(clientIp(withHeaders({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIp(withHeaders({}))).toBe("unknown");
  });
});
