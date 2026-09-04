import { randomBytes as nodeRandomBytes } from 'node:crypto';

export type RandomBytes = (size: number) => Buffer;

export function createRoomJoinId(randomBytes: RandomBytes = nodeRandomBytes): string {
  return randomBytes(8).toString('hex');
}
