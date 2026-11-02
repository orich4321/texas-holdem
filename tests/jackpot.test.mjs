import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import { startHand } from '../packages/poker-core/src/index.ts';
import { ServerGameLifecycle } from '../apps/server/src/game-lifecycle.ts';
import { signPrivateHandSnapshot, hydrateSignedPrivateHandSnapshot } from '../apps/server/src/persistence/private-hand-snapshot.ts';
import { isSevenDeuceOffsuit, jackpotWinners } from '../apps/server/src/persistence/jackpot.ts';
import { createChipTray, selectAllChips, chipTotal, displayChipCounts } from '../apps/web/app/betting-chips.ts';

test('only an unfolded 2-7 offsuit winner of a real main or side pot qualifies', () => {
  const offsuit = [{ rank: '2', suit: 'hearts' }, { rank: '7', suit: 'diamonds' }];
  assert.equal(isSevenDeuceOffsuit(offsuit), true, 'different red suits still count as offsuit');
  assert.equal(isSevenDeuceOffsuit([{ rank: '7', suit: 'clubs' }, { rank: '2', suit: 'clubs' }]), false);
  const hand = { dealerSeat: 1, seats: [
    { seatNumber: 1, playerId: 'a', holeCards: offsuit },
    { seatNumber: 2, playerId: 'b', holeCards: offsuit, isFolded: true },
    { seatNumber: 3, playerId: 'c', holeCards: [{ rank: 'A', suit: 'clubs' }, { rank: 'K', suit: 'clubs' }] },
  ] };
  assert.deepEqual(jackpotWinners(hand, [{ winnerSeatNumbers: [3] }, { winnerSeatNumbers: [1, 2] }]).map((seat) => seat.playerId), ['a']);
  assert.deepEqual(jackpotWinners(hand, [{ winnerSeatNumbers: [3] }]), [], 'an uncalled-bet refund is not a winning pot');
});

test('tenths stay exact through chip piles, all-in, signed recovery, calls and raises', () => {
  for (const value of [0.1, 0.9, 1.1, 499.9, 500.3, 999999.9]) {
    assert.equal(chipTotal(displayChipCounts(value)), value);
    assert.equal(chipTotal(selectAllChips(createChipTray(value)).selected), value);
  }
  const key = Buffer.from('a deterministic test-only key at least thirty two bytes');
  const keyring = new Map([['test', key]]);
  const hand = startHand({ seats: [{ playerId: 'a', seatNumber: 1, stack: 4999 }, { playerId: 'b', seatNumber: 2, stack: 4999 }], dealerSeat: 1, smallBlind: 10, bigBlind: 20, randomInt: () => 0 });
  const signed = signPrivateHandSnapshot(hand, { roomId: 'room', sequence: 0, keyId: 'test', chipScale: 10 }, key);
  const recovery = hydrateSignedPrivateHandSnapshot(signed, { roomId: 'room', sequence: 0 }, keyring);
  assert.equal(recovery.chipScale, 10);
  assert.throws(() => hydrateSignedPrivateHandSnapshot({ ...signed, chipScale: undefined }, { roomId: 'room', sequence: 0 }, keyring));
  const lifecycle = ServerGameLifecycle.fromVerifiedRecoveredHand({ seats: hand.seats.map((seat) => ({ ...seat, playerName: seat.playerId })), dealerSeat: 1, smallBlind: 1, bigBlind: 2 }, recovery);
  assert.equal(lifecycle.viewFor('a').toCall, 1);
  assert.equal(lifecycle.viewFor('a').seats[0].stack, 498.9);
  assert.throws(() => lifecycle.applyAction('a', { type: 'raise', raiseTo: 4.55 }));
  lifecycle.applyAction('a', { type: 'raise', raiseTo: 4.5 });
  assert.equal(lifecycle.viewFor('b').toCall, 2.5);
  assert.equal(lifecycle.handForDurableSnapshot().seats[0].currentBet, 45);
});

test('a short all-in blind does not force its sole opponent to check or pay an unmatched bet', () => {
  const hand = startHand({ seats: [{ playerId: 'a', seatNumber: 1, stack: 100 }, { playerId: 'b', seatNumber: 2, stack: 4 }], dealerSeat: 1, smallBlind: 5, bigBlind: 10, randomInt: () => 0 });
  assert.equal(hand.pot, 9);
  assert.equal(hand.currentBet, 5);
  assert.deepEqual(hand.pendingActorSeats, []);
});
