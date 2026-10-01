/** Aggregate only public settlement accounting; never expose settlement cards here. */
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function chips(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function buildGameRecap(settlements: readonly { result: unknown }[], playerIds: readonly string[]) {
  const stats = new Map(playerIds.map((id) => [id, { playerId: id, handsPlayed: 0, handsWon: 0 }]));
  let largestPot: { handNumber: number; amount: number } | null = null;
  let biggestWin: { handNumber: number; playerId: string; amount: number } | null = null;

  settlements.forEach((settlement, index) => {
    const result = record(settlement.result) ?? {};
    const players = (Array.isArray(result.players) ? result.players : []).map(record).filter((player): player is Record<string, unknown> => player !== null);
    const playerBySeat = new Map(players.filter((player) => typeof player.seatNumber === 'number' && typeof player.playerId === 'string')
      .map((player) => [player.seatNumber, player.playerId as string]));
    for (const player of players) {
      const stat = stats.get(player.playerId as string);
      if (stat && Array.isArray(player.holeCards) && player.holeCards.length === 2) stat.handsPlayed += 1;
    }
    let potTotal = 0;
    const payouts = new Map<string, number>();
    for (const value of Array.isArray(result.pots) ? result.pots : []) {
      const pot = record(value);
      if (!pot) continue;
      potTotal += chips(pot.amount);
      for (const valueOfPayout of Array.isArray(pot.payouts) ? pot.payouts : []) {
        const payout = record(valueOfPayout);
        const playerId = playerBySeat.get(payout?.seatNumber);
        if (playerId && payout) payouts.set(playerId, (payouts.get(playerId) ?? 0) + chips(payout.amount));
      }
    }
    const handNumber = index + 1;
    if (potTotal > (largestPot?.amount ?? 0)) largestPot = { handNumber, amount: potTotal };
    for (const [playerId, amount] of payouts) {
      if (amount <= 0) continue;
      const stat = stats.get(playerId);
      if (stat) stat.handsWon += 1;
      if (amount > (biggestWin?.amount ?? 0)) biggestWin = { handNumber, playerId, amount };
    }
  });

  return { largestPot, biggestWin, playerStats: [...stats.values()] };
}
