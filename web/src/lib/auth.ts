import type { NextRequest } from "next/server";

/**
 * Vertical-slice gate: if APP_KEY is set, every API request must present it
 * in the `x-app-key` header. Real per-user sign-in replaces this in Phase C.
 */
export function authorized(req: NextRequest): boolean {
  const key = process.env.APP_KEY;
  if (!key) return true;
  return req.headers.get("x-app-key") === key;
}
