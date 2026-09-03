import { randomInt as nodeCryptoRandomInt } from 'node:crypto';

export type CryptoRandomInt = (maxExclusive: number) => number;

export function createSecureRandomInt(randomInt: CryptoRandomInt = nodeCryptoRandomInt): CryptoRandomInt {
  return (maxExclusive) => randomInt(maxExclusive);
}

export const secureRandomInt = createSecureRandomInt();
