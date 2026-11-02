export function hand(overrides = {}) {
  return { key: 'hand-0', number: 1, bigBlind: 2, dealerSeat: 1, ownPlayerId: 'hero', position: 'BTN', dealt: true,
    ownCards: [{ rank: 'A', suit: 'spades' }, { rank: 'K', suit: 'spades' }],
    players: [{ playerId: 'hero', seatNumber: 1, displayName: 'אני', folded: false, holeCards: [] },
      { playerId: 'opponent', seatNumber: 2, displayName: 'יריב', folded: true, holeCards: [null, null] }],
    actions: [], decisions: [], board: [], sawFlop: false, wentToShowdown: false, won: false, net: -2, warnings: [], ...overrides };
}
export function action(sequence, playerId, type, overrides = {}) {
  return { sequence, playerId, type, amount: type === 'call' ? 2 : type === 'raise' ? 6 : 0, raiseTo: type === 'raise' ? 6 : 0,
    street: 'preflop', pot: 3, toCall: 2, canRaise: true, activePlayers: 3, ...overrides };
}
export function decision(id = 'hand-0:1', overrides = {}) {
  return { id, handKey: id.split(':')[0], playerId: 'hero', street: 'preflop', position: 'BTN', board: [], ownCards: hand().ownCards,
    pot: 3, stack: 98, stackBB: 49, toCall: 2, activePlayers: 2, currentBet: 2, bigBlind: 2, canRaise: true, seats: [], minRaiseTo: 4, maxRaiseTo: 98, priorActions: [], action: action(1, 'hero', 'call'), ...overrides };
}
export function evaluation(decisionId, overrides = {}) {
  return { decisionId, rating: 'reasonable', confidence: 'medium', dimensions: ['preflop'], explanation: 'התשלום נבחן מול טווח סביר, בלי לדעת מה ייפתח בהמשך.',
    alternative: 'אפשר לשקול העלאה בהתאם לעמדה.', assumptions: 'אין קריאה אמינה על היריב ואין Solver.', nextTime: 'לבחון את העמדה ואת גודל ההימור לפני תשלום.', ...overrides };
}
export const narrative = { summary: 'הניתוח מתמקד בהחלטות ולא בתוצאה.', style: 'אין מספיק ידיים לקביעה יציבה.', strengths: [], improvements: [], nextGame: [], opponents: [] };
