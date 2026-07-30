/**
 * Turn a failed fetch Response into a sentence a person can act on.
 *
 * Why this exists: `await res.json()` on an error response THROWS whenever
 * the body isn't JSON — and error bodies frequently aren't (a proxy's HTML
 * 502, an empty 504, a Next.js error page). In Safari that throw reads
 * "SyntaxError: The string did not match the expected pattern.", and a
 * catch block that does `setNote(e.message)` then shows the user Safari's
 * complaint about JSON parsing *as if it were the reason the music didn't
 * play*. That is exactly what the Terrace Music card was reporting.
 *
 * So: read the body as text (which can't fail that way), parse it only if
 * it looks like JSON, and otherwise say something true about the status.
 * Never throws — the caller is already on its error path.
 */
export async function errorFrom(res: Response, fallback: string): Promise<string> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* body already consumed or connection dropped — status is all we have */
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const body = JSON.parse(trimmed) as { error?: unknown; detail?: unknown };
      if (typeof body.error === "string" && body.error) return body.error;
      if (typeof body.detail === "string" && body.detail) return body.detail;
    } catch {
      /* looked like JSON, wasn't — fall through to the status wording */
    }
  }
  switch (res.status) {
    case 401:
      return "signed out — reload and sign in again";
    case 403:
      return "not allowed for your account";
    case 501:
      return "not set up on the server yet";
    case 502:
    case 503:
    case 504:
      return "the house server didn't answer — try again in a moment";
    default:
      return `${fallback} (HTTP ${res.status})`;
  }
}

/**
 * The same guard for a fetch that never reached the server. A dropped
 * connection or an offline phone must read as such, not as whatever
 * low-level string the browser attached to the rejection.
 */
export function networkError(err: unknown, fallback: string): string {
  if (err instanceof Error && /NetworkError|Load failed|Failed to fetch|network/i.test(err.message)) {
    return "no connection to the house server";
  }
  return err instanceof Error && err.message ? err.message : fallback;
}
