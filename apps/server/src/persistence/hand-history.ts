/** A deliberately narrow projection of the stored settlement. Never return raw result JSON. */
type Card = { rank: string; suit: string };
type Event = { sequence: number; type: string; payload: unknown; createdAt: Date };
export type ReplayFrame = {
  sequence: number;
  street: string;
  board: readonly Card[];
  pot: number;
  seats: readonly { playerId: string; seatNumber: number; stack: number; currentBet: number; totalCommitted: number; isFolded: boolean }[];
  allInCardsPublic: boolean;
  reveals: readonly { playerId: string; cardIndexes: readonly number[] }[];
};

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

/** Only verified server snapshot metadata enters this projector; no deck or private hand is returned. */
export function projectHandReplay(result: unknown, ownPlayerIds: ReadonlySet<string>, events: readonly Event[], frames: readonly ReplayFrame[]) {
  const final = projectHandHistory(result, ownPlayerIds, events);
  const eventBySequence = new Map(events.map((event) => [event.sequence, event]));
  const resultData = record(result) ?? {};
  const finalStacks = new Map((Array.isArray(resultData.stacks) ? resultData.stacks : []).map(record)
    .filter((seat): seat is Record<string, unknown> => seat !== null && typeof seat.playerId === 'string')
    .map((seat) => [seat.playerId as string, int(seat.stack)]));
  const steps: {
    sequence: number; kind: string; street: string; board: Card[]; pot: number;
    actorPlayerId: string; action: { type: string; amount: number; raiseTo: number; raiseKind: string } | null;
    players: { playerId: string; stack: number; currentBet: number; totalCommitted: number; folded: boolean; holeCards: (Card | null)[] }[];
  }[] = [];
  let settled = false;

  function append(frame: ReplayFrame, kind: string, board = frame.board, street = frame.street) {
    const event = eventBySequence.get(frame.sequence);
    const payload = record(event?.payload) ?? {};
    const action = record(payload.action) ?? {};
    const publicCards = street === 'showdown' && final.players.filter((player) => !player.folded).length >= 2;
    const revealedByPlayer = new Map(frame.reveals.map((reveal) => [reveal.playerId, reveal.cardIndexes]));
    steps.push({
      sequence: frame.sequence, kind, street,
      board: board.map((value) => ({ ...value })),
      pot: settled || kind === 'result' ? 0 : frame.pot,
      actorPlayerId: typeof payload.actorPlayerId === 'string' ? payload.actorPlayerId : typeof payload.playerId === 'string' ? payload.playerId : '',
      action: event?.type === 'PLAYER_ACTION' ? {
        type: typeof action.type === 'string' ? action.type : 'unknown',
        amount: int(payload.amount), raiseTo: int(action.raiseTo),
        raiseKind: typeof payload.raiseKind === 'string' ? payload.raiseKind : '',
      } : null,
      players: frame.seats.map((seat) => {
        const finalPlayer = final.players.find((player) => player.playerId === seat.playerId);
        const visibleIndices = revealedByPlayer.get(seat.playerId) ?? [];
        const showBoth = ownPlayerIds.has(seat.playerId)
          || (!seat.isFolded && (publicCards || frame.allInCardsPublic));
        return {
          playerId: seat.playerId,
          stack: settled || kind === 'result' ? finalStacks.get(seat.playerId) ?? seat.stack : seat.stack,
          currentBet: settled || kind === 'result' ? 0 : seat.currentBet,
          totalCommitted: seat.totalCommitted,
          folded: seat.isFolded,
          holeCards: [0, 1].map((index) => showBoth || visibleIndices.includes(index) ? finalPlayer?.holeCards[index] ?? null : null),
        };
      }),
    });
  }

  const ordered = [...frames].sort((left, right) => left.sequence - right.sequence);
  for (const [index, frame] of ordered.entries()) {
    const previous = ordered[index - 1];
    const event = eventBySequence.get(frame.sequence);
    const boardAdvanced = previous && frame.board.length > previous.board.length;
    if (boardAdvanced && event?.type === 'PLAYER_ACTION') append(frame, 'action', previous.board, previous.street);
    if (boardAdvanced) append(frame, event?.type === 'UNCONTESTED_RUNOUT_ADVANCED' ? 'rabbit' : frame.street === 'showdown' ? 'showdown' : 'board');
    else if (event?.type === 'SHOWDOWN_CARD_REVEALED') append(frame, 'reveal');
    else if (event?.type === 'PLAYER_ACTION') append(frame, 'action', frame.board, previous?.street ?? frame.street);
    else if (index === 0) append(frame, 'deal');
    if (!settled && frame.street === 'showdown') {
      append(frame, 'result');
      settled = true;
    }
  }
  return steps;
}
