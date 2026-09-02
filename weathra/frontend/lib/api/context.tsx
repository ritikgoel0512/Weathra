"use client";

/**
 * The API client the screens use, wired to the browser session.
 *
 * A context rather than a module-level singleton, for two reasons that both matter:
 *
 * - A test supplies its own client, so a component test needs no network and no Supabase.
 * - The client needs `onSessionExpired`, which belongs to whatever is holding the session state.
 *   A singleton created at import time has nothing to call.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { browserAccessToken } from "@/lib/supabase/browser";

import { createApiClient, type ApiClient, type SessionExpired } from "./client";

const ApiClientContext = createContext<ApiClient | null>(null);

export interface ApiProviderProps {
  readonly children: ReactNode;
  /** Supplied by tests; built from the browser session otherwise. */
  readonly client?: ApiClient;
  readonly onSessionExpired?: (error: SessionExpired) => void;
}

export function ApiProvider({ children, client, onSessionExpired }: ApiProviderProps) {
  const value = useMemo(
    () => client ?? createApiClient({ accessToken: browserAccessToken, onSessionExpired }),
    [client, onSessionExpired],
  );

  return <ApiClientContext.Provider value={value}>{children}</ApiClientContext.Provider>;
}

/** The API client. Throws rather than returning null, so a missing provider fails at the boundary. */
export function useApiClient(): ApiClient {
  const client = useOptionalApiClient();
  if (client === null) {
    throw new Error("useApiClient was called outside an <ApiProvider>.");
  }
  return client;
}

/**
 * The API client, or null when there is no provider.
 *
 * For a hook that accepts a client directly — `useAgentStream` does, so a component test needs
 * neither a provider nor Supabase. A hook cannot ask for the context conditionally, so it asks
 * without insisting.
 */
export function useOptionalApiClient(): ApiClient | null {
  return useContext(ApiClientContext);
}
