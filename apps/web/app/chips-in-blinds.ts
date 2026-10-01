export function formatChipsInBigBlinds(chips: number, bigBlind: number): string {
  if (!Number.isFinite(chips) || !Number.isFinite(bigBlind) || chips < 0 || bigBlind <= 0) return '—';
  const blinds = chips / bigBlind;
  if (blinds > 0 && blinds < 0.1) return '<0.1 BB';
  return `${new Intl.NumberFormat('he-IL', { maximumFractionDigits: 1 }).format(blinds)} BB`;
}
