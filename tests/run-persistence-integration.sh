#!/usr/bin/env bash
set -euo pipefail

readonly TEST_DATABASE_URL='postgresql://persistence_test:persistence_test_only@127.0.0.1:55432/texas_holdem_persistence_test'
compose=(docker compose -p texas-holdem-persistence-test -f docker-compose.persistence-test.yml)

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans
}
trap cleanup EXIT

"${compose[@]}" up --wait
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @texas-holdem/server exec prisma generate --schema prisma/schema.prisma
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @texas-holdem/server exec prisma migrate deploy --schema prisma/schema.prisma
env NODE_ENV=test TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm exec tsx --test tests/server-*.integration.test.mjs
