import { startHand, type StartHandInput } from '@texas-holdem/poker-core/server';
import type { StartedHand } from '../../../packages/poker-core/src/server-recovery.js';

import { secureRandomInt } from './secure-random.js';

export type ServerStartHandInput = Omit<StartHandInput, 'randomInt'>;

/**
 * The sole production hand-dealing boundary. It deliberately accepts no RNG,
 * seed, or client-controlled shuffle input: Node's crypto adapter supplies it.
 */
export function startServerHand(input: ServerStartHandInput): StartedHand {
  return startHand({ ...input, randomInt: secureRandomInt });
}
