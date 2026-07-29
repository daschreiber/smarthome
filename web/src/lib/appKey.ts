/**
 * Client-side helper for the optional x-app-key header (the APP_KEY
 * transition gate — see lib/auth.ts). One implementation so every page
 * agrees on the two rules that were previously copy-pasted with drift:
 *
 * - The key is read from localStorage on every call (survives soft
 *   navigations, no ref plumbing).
 * - It is sent ONLY when it is a legal ASCII header token. A stored key
 *   with whitespace or non-ASCII (a paste artifact) makes Safari reject
 *   the whole fetch with a cryptic SyntaxError — AppKeyGuard purges such
 *   values, and this guard means a poisoned value can't break a fetch in
 *   the window before it runs.
 */
export function appKeyHeaders(): Record<string, string> {
  try {
    const k = (localStorage.getItem("appKey") ?? "").trim();
    return k && /^[\x21-\x7e]+$/.test(k) ? { "x-app-key": k } : {};
  } catch {
    return {}; // storage unavailable (SSR, privacy mode) — cookie auth only
  }
}
