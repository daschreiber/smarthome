"use client";

import { useEffect } from "react";

/**
 * Defense in depth for the Safari "The string did not match the expected
 * pattern" gremlin: a stored app key with whitespace or non-ASCII (a paste
 * artifact) makes any fetch that sends it as a header throw. Per-page guards
 * stop it being sent, but the poisoned value lingers in localStorage until
 * overwritten — so purge it the first time the app loads any page.
 */
export default function AppKeyGuard() {
  useEffect(() => {
    try {
      const k = localStorage.getItem("appKey");
      if (k != null && (k !== k.trim() || (k && !/^[\x21-\x7e]+$/.test(k)))) {
        const cleaned = k.trim();
        if (cleaned && /^[\x21-\x7e]+$/.test(cleaned)) localStorage.setItem("appKey", cleaned);
        else localStorage.removeItem("appKey");
      }
    } catch { /* storage unavailable — nothing to clean */ }
  }, []);
  return null;
}
