import { createHash, randomBytes } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTH_CODE = /^[A-Za-z0-9_-]{8,256}$/;
const VERIFIER = /^[A-Za-z0-9_-]{43}$/;

export function safeAuthDestination(value: unknown): string {
  return typeof value === 'string' && value.length <= 250
    && (/^\/$/.test(value) || /^\/enter-room$/.test(value) || /^\/profile$/.test(value) || /^\/history(?:\/[a-f0-9]{16})?$/i.test(value) || /^\/r\/[a-f0-9]{16}(?:\/host)?$/i.test(value))
    ? value : '/';
}

export function newCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export class GoogleOAuth {
  private readonly baseUrl: string;

  constructor(
    supabaseUrl: string,
    private readonly publishableKey: string,
    readonly callbackUrl: string,
    private readonly httpFetch: typeof fetch = fetch,
  ) {
    const parsed = new URL(supabaseUrl);
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.supabase.co')) throw new Error('Invalid Supabase Auth URL');
    this.baseUrl = parsed.origin;
    if (new URL(callbackUrl).protocol !== 'https:' && !callbackUrl.startsWith('http://localhost:')) throw new Error('Invalid OAuth callback URL');
  }

  authorizationUrl(verifier: string): string {
    if (!VERIFIER.test(verifier)) throw new Error('Invalid PKCE verifier');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL('/auth/v1/authorize', this.baseUrl);
    url.searchParams.set('provider', 'google');
    url.searchParams.set('redirect_to', this.callbackUrl);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 's256');
    return url.toString();
  }

  async exchangeCode(code: unknown, verifier: unknown): Promise<{ id: string; email: string }> {
    if (typeof code !== 'string' || !AUTH_CODE.test(code) || typeof verifier !== 'string' || !VERIFIER.test(verifier)) throw new Error('Invalid OAuth callback');
    const response = await this.httpFetch(`${this.baseUrl}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      headers: { apikey: this.publishableKey, 'content-type': 'application/json' },
      body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error('OAuth code exchange failed');
    const result = await response.json() as { access_token?: unknown };
    if (typeof result.access_token !== 'string' || result.access_token.length > 10_000) throw new Error('Invalid OAuth token');
    const userResponse = await this.httpFetch(`${this.baseUrl}/auth/v1/user`, {
      headers: { apikey: this.publishableKey, authorization: `Bearer ${result.access_token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!userResponse.ok) throw new Error('OAuth identity verification failed');
    const user = await userResponse.json() as { id?: unknown; email?: unknown; app_metadata?: { providers?: unknown } };
    if (typeof user.id !== 'string' || !UUID.test(user.id) || typeof user.email !== 'string'
      || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(user.email) || user.email.length > 254
      || !Array.isArray(user.app_metadata?.providers) || !user.app_metadata.providers.includes('google')) {
      throw new Error('Google identity required');
    }
    return { id: user.id, email: user.email };
  }
}
