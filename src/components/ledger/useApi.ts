"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "pf-api-secret";

/**
 * The last answer to each GET, kept for this tab, so a page opened again draws at once
 * from what it showed last time while its usual load refreshes it. Anything that writes
 * (a non-GET call, notifyLedgerChanged) clears it, so an edit is never followed by old
 * figures.
 */
const responses = new Map<string, { text: string; data: unknown }>();

/** The last answer to a GET of `path` in this tab, or null. Seeds a page's first draw. */
export function cachedResponse<T>(path: string): T | null {
  return (responses.get(path)?.data as T | undefined) ?? null;
}

/** The data tag (x-data-stamp) of the latest answer this tab got: what the figures on screen were built from. */
let dataStampSeen: string | null = null;
export const lastDataStamp = () => dataStampSeen;

export function clearCachedResponses() {
  responses.clear();
}

/** Headers for a plain fetch outside useApi: the API secret entered this session, if any. */
export function apiSecretHeaders(): Record<string, string> {
  try {
    const s = sessionStorage.getItem(STORAGE_KEY)?.trim();
    return s ? { "x-api-secret": s } : {};
  } catch {
    return {};
  }
}

/**
 * Fetch helper for the local API. When the server requires API_SECRET, the
 * secret is entered once per browser session and sent on every request.
 */
export function useApi(requiresApiSecret: boolean) {
  const [secret, setSecretState] = useState("");
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read after mount: sessionStorage doesn't exist in the server render (hydration-safe)
      setSecretState(sessionStorage.getItem(STORAGE_KEY) ?? "");
    } catch {
      /* storage unavailable */
    }
  }, []);
  const setSecret = useCallback((s: string) => {
    setSecretState(s);
    try {
      sessionStorage.setItem(STORAGE_KEY, s);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const ready = !requiresApiSecret || secret.trim().length > 0;

  const call = useCallback(
    async <T,>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> => {
      const headers = new Headers(init.headers);
      if (requiresApiSecret && secret.trim()) headers.set("x-api-secret", secret.trim());
      let body = init.body;
      if (init.json !== undefined) {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(init.json);
      }
      const isRead = (init.method ?? "GET").toUpperCase() === "GET";
      if (!isRead) responses.clear();
      const res = await fetch(path, { ...init, headers, body });
      const text = await res.text().catch(() => "");
      if (isRead && res.ok) dataStampSeen = res.headers.get("x-data-stamp") ?? dataStampSeen;
      const prior = isRead ? responses.get(path) : undefined;
      // An unchanged answer hands back the same object, so the page doesn't redraw.
      if (res.ok && prior && prior.text === text) return prior.data as T;
      let data: (T & { error?: string }) | null = null;
      try {
        data = JSON.parse(text) as T & { error?: string };
      } catch {
        /* not JSON */
      }
      if (res.status === 401) throw new Error("Unauthorized — check your access secret.");
      if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
      if (isRead) responses.set(path, { text, data });
      else responses.clear();
      return data as T;
    },
    [requiresApiSecret, secret],
  );

  // Stable identity: pages list `api` as an effect dependency, so a fresh object on
  // every render would refetch forever.
  return useMemo(() => ({ call, ready, secret, setSecret, requiresApiSecret }), [call, ready, secret, setSecret, requiresApiSecret]);
}

export type Api = ReturnType<typeof useApi>;
