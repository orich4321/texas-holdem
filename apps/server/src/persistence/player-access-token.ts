import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

const ACCESS_TOKEN_BYTE_LENGTH = 32;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type PlayerAccessTokenFactory = () => string;
export type PlayerAccessTokenHasher = (accessToken: string) => Buffer;
export type RandomBytes = (size: number) => Buffer;

export function createPlayerAccessToken(randomBytes: RandomBytes = nodeRandomBytes): string {
  return randomBytes(ACCESS_TOKEN_BYTE_LENGTH).toString('base64url');
}

export function hashPlayerAccessToken(accessToken: string): Buffer {
  return createHash('sha256').update(accessToken, 'utf8').digest();
}

export function isValidPlayerAccessToken(accessToken: unknown): accessToken is string {
  if (typeof accessToken !== 'string' || !ACCESS_TOKEN_PATTERN.test(accessToken)) return false;

  try {
    return Buffer.from(accessToken, 'base64url').length === ACCESS_TOKEN_BYTE_LENGTH;
  } catch {
    return false;
  }
}
