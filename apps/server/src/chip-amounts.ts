/** Public chips are decimals; the poker engine and jackpot ledger use exact integer tenths. */
export function isChipAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    && Number.isSafeInteger(Math.round(value * 10)) && Math.abs(value - Math.round(value * 10) / 10) < 1e-9;
}

export function chipUnits(chips: number): number {
  if (!isChipAmount(chips)) throw new Error('Invalid chip amount');
  return Math.round(chips * 10);
}

const moneyKeys = new Set(['stack', 'currentBet', 'totalCommitted', 'bigBlind', 'pot', 'toCall', 'waitingToCall', 'minRaiseTo', 'maxRaiseTo', 'minimumIncrement', 'allInRaiseTo', 'chipsWon', 'amount', 'raiseTo', 'quotedToCall']);

/** Explicit monetary fields only: seat numbers, sequences, ranks and timestamps are never scaled. */
export function chipsFromEngine<T>(value: T, scale: number): T {
  if (scale === 1) return value;
  if (Array.isArray(value)) return value.map((entry) => chipsFromEngine(entry, scale)) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    moneyKeys.has(key) && typeof entry === 'number' ? entry / scale : chipsFromEngine(entry, scale),
  ])) as T;
}
