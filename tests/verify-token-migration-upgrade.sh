#!/usr/bin/env bash
set -euo pipefail

readonly UPGRADE_DATABASE=texas_holdem_token_upgrade_test
readonly POSTGRES=(docker compose -p texas-holdem-persistence-test -f docker-compose.persistence-test.yml exec -T postgres psql -v ON_ERROR_STOP=1 -U persistence_test)

"${POSTGRES[@]}" -d postgres -c "CREATE DATABASE ${UPGRADE_DATABASE};" >/dev/null
cat apps/server/prisma/migrations/20260904143241_init/migration.sql | "${POSTGRES[@]}" -d "$UPGRADE_DATABASE" >/dev/null
"${POSTGRES[@]}" -d "$UPGRADE_DATABASE" -c "INSERT INTO \"Room\" (\"id\", \"joinId\", \"status\", \"updatedAt\") VALUES ('00000000-0000-0000-0000-000000000001', 'upgrade-room', 'WAITING', CURRENT_TIMESTAMP); INSERT INTO \"Player\" (\"id\", \"roomId\", \"displayName\", \"initialStack\", \"currentStack\", \"updatedAt\") VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Existing player', 1000, 1000, CURRENT_TIMESTAMP);" >/dev/null
cat apps/server/prisma/migrations/20260904150000_add_player_access_token_hash/migration.sql | "${POSTGRES[@]}" -d "$UPGRADE_DATABASE" >/dev/null
"${POSTGRES[@]}" -d "$UPGRADE_DATABASE" -Atc 'SELECT ("accessTokenHash" IS NOT NULL AND length("accessTokenHash") = 64)::text FROM "Player";' | grep -qx 'true'
