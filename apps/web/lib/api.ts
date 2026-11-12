import type {
  AgentSummaryView,
  AgentView,
  ApprovalView,
  MeView,
  WorldView,
} from '@hustle/core/browser';
import useSWR, { type SWRConfiguration } from 'swr';

/** An error the API returned: `{error, code, details}` with an HTTP status. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'include',
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new ApiError('Could not reach the game server', 0, 'network');
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body ?? {}) as { error?: string; code?: string; details?: unknown };
    throw new ApiError(
      err.error ??
        (res.status >= 500 ? 'The game server had a problem' : `Request failed (${res.status})`),
      res.status,
      err.code ?? 'unknown',
      err.details ?? null,
    );
  }
  return body as T;
}

export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : 'Something went wrong';

export const fetcher = <T>(path: string) => api<T>(path);

export const useApi = <T>(path: string | null, config?: SWRConfiguration<T>) =>
  useSWR<T>(path, fetcher, config);

// No polling intervals here: the live feed (components/providers.tsx) revalidates mounted keys on
// its heartbeat and on matching feed events.
export const useMe = () => useApi<MeView | null>('/api/me');
/**
 * Many components read the world; it is fetched once per world tick by the live feed. Mounting or
 * refocusing a component never adds a request of its own once the world is cached.
 */
export const useWorld = () =>
  useApi<WorldView>('/api/world', {
    revalidateIfStale: false,
    revalidateOnFocus: false,
    dedupingInterval: 1500,
  });
export const useAgent = (id: string | null) => useApi<AgentView>(id ? `/api/agents/${id}` : null);
export const useAgents = () => useApi<AgentSummaryView[]>('/api/agents');
export const useApprovals = (signedIn: boolean) =>
  useApi<ApprovalView[]>(signedIn ? '/api/approvals' : null);
