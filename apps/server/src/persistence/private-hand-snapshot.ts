import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  hydrateStartedHandForVerifiedServerRecovery,
  serializeStartedHand,
  type StartedHand,
  type StartedHandSnapshot,
} from '../../../../packages/poker-core/src/server-recovery.js';

const SNAPSHOT_DOMAIN = 'texas-holdem/private-hand-snapshot/v1\0';

export interface SignedPrivateHandSnapshot {
  readonly version: 1;
  readonly keyId: string;
  readonly roomId: string;
  readonly sequence: number;
  readonly snapshot: StartedHandSnapshot;
  readonly signature: string;
}

export type PrivateSnapshotSigningKey = Buffer;

/** Opaque server capability minted only after a context-bound MAC verifies. */
export interface VerifiedPrivateHandRecovery {
  readonly hand: StartedHand;
}

const verifiedRecoveries = new WeakSet<object>();

export function isVerifiedPrivateHandRecovery(value: unknown): value is VerifiedPrivateHandRecovery {
  return !!value && typeof value === 'object' && verifiedRecoveries.has(value);
}

function requireSigningKey(key: unknown): asserts key is PrivateSnapshotSigningKey {
  if (!Buffer.isBuffer(key) || key.length < 32) throw new Error('Private snapshot signing key must be a Buffer of at least 32 bytes');
}

function requireContext(roomId: unknown, sequence: unknown): asserts roomId is string {
  if (typeof roomId !== 'string' || roomId.length === 0 || roomId.length > 128 || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('Invalid private snapshot context');
  }
}

function requireKeyId(keyId: unknown): asserts keyId is string {
  if (typeof keyId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(keyId)) throw new Error('Invalid private snapshot key ID');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Private snapshot cannot contain a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('Private snapshot must contain only JSON values');
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function unsignedEnvelope(value: Omit<SignedPrivateHandSnapshot, 'signature'>): Omit<SignedPrivateHandSnapshot, 'signature'> {
  return { version: value.version, keyId: value.keyId, roomId: value.roomId, sequence: value.sequence, snapshot: value.snapshot };
}

function signatureFor(value: Omit<SignedPrivateHandSnapshot, 'signature'>, key: PrivateSnapshotSigningKey): string {
  return createHmac('sha256', key).update(SNAPSHOT_DOMAIN).update(canonicalJson(unsignedEnvelope(value)), 'utf8').digest('hex');
}

/** Server-only persistence envelope. Do not emit this value to Socket.IO clients. */
export function signPrivateHandSnapshot(
  hand: StartedHand,
  context: { roomId: string; sequence: number; keyId: string },
  key: PrivateSnapshotSigningKey,
): SignedPrivateHandSnapshot {
  requireSigningKey(key);
  requireContext(context.roomId, context.sequence);
  requireKeyId(context.keyId);
  const unsigned = {
    version: 1 as const,
    keyId: context.keyId,
    roomId: context.roomId,
    sequence: context.sequence,
    snapshot: serializeStartedHand(hand),
  };
  return Object.freeze({ ...unsigned, signature: signatureFor(unsigned, key) });
}

/** Verifies a context-bound MAC before the server-only core recovery surface grants authority. */
export function hydrateSignedPrivateHandSnapshot(
  value: unknown,
  context: { roomId: string; sequence: number },
  keyring: ReadonlyMap<string, PrivateSnapshotSigningKey>,
): VerifiedPrivateHandRecovery {
  requireContext(context.roomId, context.sequence);
  if (!value || typeof value !== 'object') throw new Error('Invalid signed private hand snapshot');
  const { version, keyId, roomId, sequence, snapshot, signature } = value as Partial<SignedPrivateHandSnapshot>;
  if (version !== 1 || !snapshot || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) throw new Error('Invalid signed private hand snapshot');
  try {
    requireKeyId(keyId);
    requireContext(roomId, sequence);
  } catch {
    throw new Error('Invalid signed private hand snapshot');
  }
  if (roomId !== context.roomId || sequence !== context.sequence) throw new Error('Invalid signed private hand snapshot');
  const key = keyring.get(keyId);
  try {
    requireSigningKey(key);
  } catch {
    throw new Error('Invalid signed private hand snapshot');
  }
  const expected = Buffer.from(signatureFor({ version, keyId, roomId, sequence, snapshot }, key), 'hex');
  const actual = Buffer.from(signature, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid signed private hand snapshot');
  const recovery = Object.freeze({ hand: hydrateStartedHandForVerifiedServerRecovery(snapshot) });
  verifiedRecoveries.add(recovery);
  return recovery;
}
