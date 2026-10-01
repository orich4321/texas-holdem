/** A deliberately narrow projection of the stored settlement. Never return raw result JSON. */
type Card = { rank: string; suit: string };
type Event = { sequence: number; type: string; payload: unknown; createdAt: Date };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function card(value: unknown): Card | null {
  const entry = record(value);
  return entry && typeof entry.rank === 'string' && typeof entry.suit === 'string'
    ? { rank: entry.rank, suit: entry.suit } : null;
}

function cards(value: unknown): (Card | null)[] {
  return Array.isArray(value) ? value.map(card) : [];
}

function int(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0;
}

export function projectHandHistory(result: unknown, ownPlayerIds: ReadonlySet<string>, events: readonly Event[]) {
  const stored = record(result) ?? {};
  const players = Array.isArray(stored.players) ? stored.players.map(record).filter((player): player is Record<string, unknown> => player !== null) : [];
  const showdownPlayers = players.filter((player) => player.folded === false);
  const publicShowdown = showdownPlayers.length >= 2;
  const revealed = new Map<string, Set<number>>();
  for (const event of events) {
    if (event.type !== 'SHOWDOWN_CARD_REVEALED') continue;
    const payload = record(event.payload);
    if (typeof payload?.playerId !== 'string' || (payload.cardIndex !== 0 && payload.cardIndex !== 1)) continue;
    const indices = revealed.get(payload.playerId) ?? new Set<number>();
    indices.add(payload.cardIndex);
    revealed.set(payload.playerId, indices);
  }
  return {
    board: cards(stored.board).filter((value): value is Card => value !== null),
    players: players.map((player) => {
      const playerId = typeof player.playerId === 'string' ? player.playerId : '';
      const actualCards = cards(player.holeCards);
      return {
        playerId,
        displayName: typeof player.playerName === 'string' ? player.playerName : 'שחקן',
        seatNumber: int(player.seatNumber),
        folded: player.folded === true,
        holeCards: [0, 1].map((index) => ownPlayerIds.has(playerId) || (publicShowdown && player.folded === false) || revealed.get(playerId)?.has(index)
          ? actualCards[index] ?? null : null),
      };
    }),
    pots: (Array.isArray(stored.pots) ? stored.pots : []).map(record).filter((pot): pot is Record<string, unknown> => pot !== null).map((pot) => ({
      amount: int(pot.amount),
      winnerSeatNumbers: Array.isArray(pot.winnerSeatNumbers) ? pot.winnerSeatNumbers.map(int) : [],
      payouts: (Array.isArray(pot.payouts) ? pot.payouts : []).map(record).filter((payout): payout is Record<string, unknown> => payout !== null).map((payout) => ({ seatNumber: int(payout.seatNumber), amount: int(payout.amount) })),
    })),
    actions: events.filter((event) => event.type === 'PLAYER_ACTION').map((event) => {
      const payload = record(event.payload) ?? {};
      const action = record(payload.action) ?? {};
      return {
        sequence: event.sequence,
        occurredAt: event.createdAt.toISOString(),
        playerId: typeof payload.actorPlayerId === 'string' ? payload.actorPlayerId : '',
        type: typeof action.type === 'string' ? action.type : 'unknown',
        amount: int(payload.amount),
        raiseTo: int(action.raiseTo),
      };
    }),
  };
}
