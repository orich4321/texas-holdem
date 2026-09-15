# Phase A durable checkpoint

## Current slice: durable authoritative player-action persistence/recovery, Socket.IO wiring, and first playable browser table (complete; uncommitted)

**Preserved baseline:** signed durable private hand snapshots are complete in committed `727b915`.

### Delivered
- Authenticated server inputs rebuild only the latest HMAC-verified snapshot, apply one strict allowlisted action, and atomically write minimal `PLAYER_ACTION` metadata plus the signed successor snapshot. A room-row lock serializes concurrent actions before the latest snapshot is read.
- Socket.IO reconnect emits exactly the authenticated player-safe view; action fan-out sends each recipient only their own projection, never a room-wide private payload.
- A host-only, cookie-authenticated start endpoint deals only through the server CSPRNG boundary, stores the signed initial hand, and exposes no cards/deck in its public response.
- The room route now progresses from lobby to a responsive Hebrew browser table. It loads the Socket.IO client from the configured game server, reconnects safely, displays only the recipient’s two hole cards, and sends turn-aware actions.
- Database integration coverage now verifies a real PostgreSQL concurrent-action race produces exactly one successor event/snapshot and confirms authenticated start behavior.

### Final verification
- `pnpm lint`: pass.
- `pnpm test`: 166 pass, 15 intentional persistence/integration skips, 0 fail.
- `pnpm typecheck`: pass.
- `pnpm e2e` (optimized web build): pass.
- `pnpm test:persistence`: 15/15 pass against the Docker PostgreSQL test environment.
- `git diff --check`: pass.

### Fresh review
- No private cards, deck state, signing material, or access tokens enter public events, room responses, or cross-player Socket.IO broadcasts.
- The first browser table completes one hand through showdown. Multi-hand rotation/settlement and showdown-result presentation are a separate next slice.

## Prior completed slice: signed durable private hand snapshots

**Status: independently reviewed, fully verified, and ready to commit.**

### Delivered
- Browser package entry no longer exports deck construction or `startHand`; trusted Node code imports the explicit `@texas-holdem/poker-core/server` entry instead.
- New signed snapshots MAC-bind both configured blinds. `startGameAtomically` verifies the small blind, big blind, and dealer in the public `GAME_STARTED` metadata against the authenticated private hand before changing room state.
- Historical signed v1 initial snapshots from commit `c065229` that lack `smallBlindAmount` remain recoverable: only after HMAC/context verification, only at sequence 0/preflop, recovery derives the amount from the authenticated small-blind contribution. New snapshots always persist the explicit configured value.
- TDD coverage covers browser/server authority separation, public metadata mismatch rejection, authenticated legacy recovery, and rejection of unsigned legacy-shaped state.

### Final verification
- Fresh independent GPT quality/security review: **APPROVE** (no leakage or blocker found).
- `pnpm lint`: pass.
- `pnpm test`: 160 pass, 13 intentional persistence/integration skips, 0 fail.
- `pnpm typecheck`: pass.
- `pnpm e2e` (optimized web build): pass.
- `git diff --check`: pass.

### Next slice
Implement durable authoritative player-action persistence/recovery and Socket.IO wiring only after this slice has been committed. Keep server-only CSPRNG dealing and per-player safe projections intact.
