import { describe, expect, it } from "vitest";
import { errorFrom, networkError } from "../fetchError";

/**
 * Regression cover for the Terrace Music card, which showed the user
 * "The string did not match the expected pattern." — Safari's complaint
 * about parsing a non-JSON error body, surfaced by a catch block as though
 * it were the reason the music didn't play. The rule these tests hold:
 * whatever the server sends back, the card says something true about the
 * request, and never something about JSON.
 */

const SAFARI_JSON_ERROR = /did not match the expected pattern|JSON|Unexpected/i;

describe("errorFrom", () => {
  it("uses the server's own message when the body is JSON", async () => {
    const res = new Response(JSON.stringify({ error: "\"Spotify C4 Terrace\" is not visible" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
    expect(await errorFrom(res, "play failed")).toBe("\"Spotify C4 Terrace\" is not visible");
  });

  it("explains an HTML error page instead of parroting a parse failure", async () => {
    // A proxy 502 — the exact shape that produced the Terrace screenshot.
    const res = new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 });
    const message = await errorFrom(res, "play failed");
    expect(message).toBe("the house server didn't answer — try again in a moment");
    expect(message).not.toMatch(SAFARI_JSON_ERROR);
  });

  it("survives an empty body", async () => {
    const res = new Response("", { status: 504 });
    const message = await errorFrom(res, "play failed");
    expect(message).toBe("the house server didn't answer — try again in a moment");
    expect(message).not.toMatch(SAFARI_JSON_ERROR);
  });

  it("survives a body that starts like JSON but isn't", async () => {
    const res = new Response("{not json at all", { status: 500 });
    const message = await errorFrom(res, "play failed");
    expect(message).toBe("play failed (HTTP 500)");
    expect(message).not.toMatch(SAFARI_JSON_ERROR);
  });

  it("names the common auth statuses in plain words", async () => {
    expect(await errorFrom(new Response("", { status: 401 }), "x")).toMatch(/signed out/);
    expect(await errorFrom(new Response("", { status: 403 }), "x")).toMatch(/not allowed/);
    expect(await errorFrom(new Response("", { status: 501 }), "x")).toMatch(/not set up/);
  });

  it("never throws, whatever the response does", async () => {
    const hostile = {
      status: 500,
      text: async () => { throw new Error("body already consumed"); },
    } as unknown as Response;
    await expect(errorFrom(hostile, "play failed")).resolves.toBe("play failed (HTTP 500)");
  });
});

describe("networkError", () => {
  it("calls a dropped connection what it is", () => {
    expect(networkError(new TypeError("Load failed"), "play failed")).toBe(
      "no connection to the house server",
    );
  });

  it("passes a real server message through", () => {
    expect(networkError(new Error("no Spotify endpoint mapped for Gym"), "play failed")).toBe(
      "no Spotify endpoint mapped for Gym",
    );
  });
});
