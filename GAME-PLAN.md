# Private mobile Texas Hold'em — product plan

## Product promise

A host creates a private, mobile-first table in under a minute, shares a
guest-only link, and plays a fair no-cash poker night with friends. The server
is always the authority for cards, turns, chips, and results; a player only
ever sees their own hole cards.

## One game night

1. **Create a table.** The host enters a display name and chooses starting
   chips, small/big blinds, and the player cap. Recommended quick-play preset:
   1,000 chips, 5/10 blinds, six seats.
2. **Invite.** The host receives a management route; the copied link is always
   a guest route. A phone or browser session can claim one seat only.
3. **Lobby.** Everyone sees the roster, configured buy-in, blinds, and seat
   limit. Only the host sees the start control. The host can start once at
   least two players have joined.
4. **Hand.** The server shuffles and deals. Each phone polls an authenticated
   player-safe projection, highlights the active player, and offers only
   legal actions. The table advances through preflop, flop, turn, river, and
   showdown.
5. **Result.** At showdown the server evaluates all eligible hands, allocates
   main/side pots and odd chips, persists the settlement, updates stacks, and
   announces winners. Private opponent cards remain private by default.
6. **Next hand.** The host starts the next hand. Dealer/blinds rotate among
   players with chips; new cards are shuffled on the server.
7. **Finish.** When fewer than two players can cover the blinds, show a clear
   game-over result and allow the host to return to the lobby or start a new
   configured game.

## Delivery order

### Phase 1 — dependable core (current)

- Durable rooms, per-device seats, host and guest routes.
- Host-configured starting stack, blinds, and player cap.
- Server-only dealing, legal actions, side-pot settlement, chip persistence,
  and dealer rotation.
- Mobile table, winner panel, next-hand control, and reliable polling.

### Phase 2 — host controls and game flow

- Editable lobby settings while the room is still waiting.
- Presets: quick game, standard home game, deep stack.
- Blind schedule: fixed, then optional timed levels.
- Host pause/resume, remove a disconnected player before a hand, and end game.
- Explicit game-over screen with final standings and a rematch button.

### Phase 3 — play clarity

- Large mobile action controls with a bet slider and common raise shortcuts.
- Turn countdown with a clear automatic check/fold policy chosen by the host.
- Dealer, small-blind, big-blind, all-in, folded, and last-action indicators.
- Hand-history drawer: public board/actions/results, never another player's
  private cards without a reveal choice.
- Reconnect banner that restores the exact player state after refresh/network
  loss.

### Phase 4 — social polish

- Optional post-showdown reveal for each player.
- Reactions and lightweight table chat with host moderation.
- Share-sheet friendly invite card and QR code.
- Accessibility pass: reduced motion, high contrast, RTL/LTR names, screen
  reader announcements, and touch targets at least 44px.

### Phase 5 — operational readiness

- Real-device test matrix: iPhone Safari, Android Chrome, desktop Chrome,
  reconnects, backgrounded phones, and private browsing.
- Database migration/backup checks, rate limits, error monitoring, and a
  recovery drill using durable snapshots.
- End-to-end tests for create → join → start → showdown → next hand → game
  over, including ties, side pots, all-ins, and disconnects.

## Rules and safety decisions

- This is a chip-only home game: no deposits, withdrawals, payments, or real
  money accounting.
- Table configuration locks once the first hand starts, preventing a host from
  changing terms mid-game.
- The server validates every action and signs durable private hand snapshots;
  the browser never supplies a deck, a winner, or a chip total.
- Each player is represented by an httpOnly session cookie. Duplicate joins
  from the same device are rejected server-side, not merely hidden in the UI.
