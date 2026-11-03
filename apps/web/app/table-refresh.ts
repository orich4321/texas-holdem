type RefreshOptions<T> = {
  url: string;
  validate: (value: unknown) => value is T;
  currentSequence: () => number;
  onView: (view: T) => void;
  onUnchanged: () => void;
  onUnauthorized: () => void;
  onWaiting: () => void;
  onError: (kind: 'NETWORK' | 'INVALID_STATE') => void;
  fetcher?: typeof globalThis.fetch;
  timeoutMs?: number;
};

/** A single authenticated, conditional read at a time. A deadline frees the
 * poller after a hung request; it never resends player actions or joins a seat. */
export function createTableRefresh<T extends { sequence?: number }>(options: RefreshOptions<T>) {
  let active = true;
  let tag: string | undefined;
  let inFlight: Promise<void> | undefined;
  let controller: AbortController | undefined;
  const fetcher = options.fetcher ?? globalThis.fetch;

  function refresh(): Promise<void> {
    if (!active) return Promise.resolve();
    if (inFlight) return inFlight;
    const request = new AbortController();
    controller = request;
    const timeout = globalThis.setTimeout(() => request.abort(), options.timeoutMs ?? 12_000);
    inFlight = (async () => {
      let invalidState = false;
      try {
        const response = await fetcher(options.url, { credentials: 'include', cache: 'no-store', signal: request.signal,
          ...(tag ? { headers: { 'If-None-Match': tag } } : {}) });
        if (!active) return;
        if (response.status === 304) {
          if (!tag) throw new Error('Unexpected unchanged response');
          options.onUnchanged();
          return;
        }
        if (response.status === 401) { options.onUnauthorized(); return; }
        const next: unknown = await response.json();
        if (!active) return;
        if (response.status === 409 && (next as { error?: { code?: string } })?.error?.code === 'GAME_NOT_AVAILABLE') {
          tag = undefined; options.onWaiting(); return;
        }
        if (!response.ok) throw new Error('Table temporarily unavailable');
        if (!options.validate(next)) { invalidState = true; throw new Error('Invalid table response'); }
        if ((next.sequence ?? 0) < options.currentSequence()) {
          tag = undefined; // Never install a validator for a stale action response.
          return;
        }
        tag = response.headers.get('etag') ?? undefined;
        options.onView(next);
      } catch {
        if (active) options.onError(invalidState ? 'INVALID_STATE' : 'NETWORK');
      } finally { globalThis.clearTimeout(timeout); }
    })().finally(() => { inFlight = undefined; if (controller === request) controller = undefined; });
    return inFlight;
  }

  return { refresh, dispose: () => { active = false; controller?.abort(); } };
}
