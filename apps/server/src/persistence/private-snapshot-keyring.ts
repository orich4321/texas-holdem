import { Buffer } from 'node:buffer';

import type { PrivateSnapshotSigningKey } from './private-hand-snapshot.js';

type SnapshotKeyringEnvironment = Readonly<{
  PRIVATE_SNAPSHOT_KEY_ID?: string;
  PRIVATE_SNAPSHOT_KEY_BASE64?: string;
}>;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Reads the sole active server snapshot key. This is intentionally server-only:
 * snapshots must never be signed or verified with browser-supplied material.
 */
export function createPrivateSnapshotKeyring(environment: SnapshotKeyringEnvironment = process.env): ReadonlyMap<string, PrivateSnapshotSigningKey> {
  const keyId = environment.PRIVATE_SNAPSHOT_KEY_ID;
  if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) throw new Error('Private snapshot key ID is required and invalid');

  const encodedKey = environment.PRIVATE_SNAPSHOT_KEY_BASE64;
  if (typeof encodedKey !== 'string' || !BASE64.test(encodedKey)) throw new Error('Private snapshot key must be valid base64');

  const key = Buffer.from(encodedKey, 'base64');
  if (key.length < 32) throw new Error('Private snapshot key must contain at least 32 bytes');
  return new Map([[keyId, key]]);
}
