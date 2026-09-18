import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RoomRepository } from '../apps/server/src/persistence/room-repository.ts';

const roomId = 'room-db-id';
const joinId = '0123456789abcdef';
const hostId = '018f7b16-690c-4d1f-9d0b-a8c4a14ae000';
const guestId = '018f7b16-690c-4d1f-9d0b-a8c4a14ae001';
const richGuestId = '018f7b16-690c-4d1f-9d0b-a8c4a14ae002';

test('host management projection aggregates only pending chip additions', async () => {
  const db = {
    room: { findFirst: async () => ({
      smallBlind: 10, bigBlind: 20, nextHandIsFinal: true, hostPlayerId: hostId,
      players: [
        { id: hostId, displayName: 'מארח', currentStack: 0, leaveAfterHand: false },
        { id: guestId, displayName: 'אורח', currentStack: 800, leaveAfterHand: true },
      ],
      chipAdjustments: [{ playerId: guestId, amount: 200 }, { playerId: guestId, amount: 300 }],
    }) },
  };
  const repository = new RoomRepository(db);
  const management = await repository.getHostManagement(joinId, hostId);
  assert.deepEqual(management, {
    smallBlind: 10,
    bigBlind: 20,
    nextHandIsFinal: true,
    players: [
      { id: hostId, displayName: 'מארח', currentStack: 0, isHost: true, leaveAfterHand: false, pendingChips: 0 },
      { id: guestId, displayName: 'אורח', currentStack: 800, isHost: false, leaveAfterHand: true, pendingChips: 500 },
    ],
  });
});

test('a busted host can explicitly leave and atomically transfer authority to the richest active player', async () => {
  const calls = [];
  const tx = {
    room: {
      findUnique: async () => ({
        id: roomId, hostPlayerId: hostId, status: 'IN_PROGRESS',
        players: [
          { id: richGuestId, currentStack: 900, leaveAfterHand: false },
          { id: guestId, currentStack: 400, leaveAfterHand: false },
          { id: hostId, currentStack: 0, leaveAfterHand: false },
        ],
      }),
      update: async (args) => { calls.push(['room.update', args]); },
    },
    player: { update: async (args) => { calls.push(['player.update', args]); } },
    chipAdjustment: { updateMany: async (args) => { calls.push(['chipAdjustment.updateMany', args]); } },
  };
  const repository = new RoomRepository({ $transaction: async (callback) => callback(tx) });
  const result = await repository.transferHostForHost(joinId, hostId, undefined, true);
  assert.deepEqual(result, { hostPlayerId: richGuestId, previousHostLeaves: true });
  assert.equal(calls[0][1].data.hostPlayerId, richGuestId);
  assert.deepEqual(calls[1][1], { where: { id: hostId }, data: { leaveAfterHand: true } });
});

test('final accounting subtracts every applied rebuy from the player result', async () => {
  const requestedAt = new Date('2026-09-18T10:00:00Z');
  const appliedAt = new Date('2026-09-18T10:01:00Z');
  const db = {
    room: { findFirst: async () => ({
      joinId, initialStack: 1000, smallBlind: 5, bigBlind: 10,
      players: [{ id: guestId, displayName: 'אורח', initialStack: 1000, currentStack: 1700, leftAt: null }],
      chipAdjustments: [{ playerId: guestId, authorizedByPlayerId: hostId, amount: 500, stackBefore: 600, stackAfter: 1100, createdAt: requestedAt, appliedAt }],
      settlements: [], events: [],
    }) },
  };
  const repository = new RoomRepository(db);
  const summary = await repository.getFinalSummaryForPlayer(roomId, guestId);
  assert.equal(summary.version, 3);
  assert.deepEqual(summary.standings[0], {
    displayName: 'אורח', initialStack: 1000, addedChips: 500, totalBuyIn: 1500, finalStack: 1700, net: 200, leftAt: null,
  });
  assert.equal(summary.chipAdjustments[0].amount, 500);
});
