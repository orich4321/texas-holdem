const DEFAULT_CLIENT_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

function validateOrigin(origin: string): string {
  let url: URL;

  try {
    url = new URL(origin);
  } catch {
    throw new Error(`CLIENT_ORIGINS contains an invalid origin: ${origin}`);
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(`CLIENT_ORIGINS entries must be absolute HTTP(S) origins: ${origin}`);
  }

  return url.origin;
}

export function createOriginPolicy(configuredOrigins = process.env.CLIENT_ORIGINS) {
  const origins = configuredOrigins === undefined
    ? DEFAULT_CLIENT_ORIGINS
    : configuredOrigins.split(',').map((origin) => origin.trim());

  if (origins.some((origin) => origin.length === 0)) {
    throw new Error('CLIENT_ORIGINS must not contain empty values');
  }

  const allowedOrigins = new Set(origins.map(validateOrigin));
  return (origin: string | undefined) => origin !== undefined && allowedOrigins.has(origin);
}

/**
 * Allows an explicitly configured browser origin, or the origin of the public
 * request itself. The latter is for a same-origin Vercel Services deployment;
 * it still requires the complete browser Origin to match the request Host.
 */
export function isAllowedRequestOrigin(
  origin: string | undefined,
  requestHost: string | undefined,
  isConfiguredOriginAllowed: (origin: string | undefined) => boolean,
): boolean {
  if (isConfiguredOriginAllowed(origin)) return true;
  if (!origin || !requestHost) return false;

  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && parsed.host === requestHost;
  } catch {
    return false;
  }
}
