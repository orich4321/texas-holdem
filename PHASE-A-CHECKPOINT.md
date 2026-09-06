# Phase A durable checkpoint

## Current slice: signed durable private hand snapshots (complete)

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
