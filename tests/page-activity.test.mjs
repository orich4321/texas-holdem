import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDLE_TIMEOUT_MS, isInactive } from '../apps/web/app/use-page-activity.ts';

test('table activity pauses precisely after ten minutes without a user interaction', () => {
  assert.equal(IDLE_TIMEOUT_MS, 600_000);
  assert.equal(isInactive(1000, 1000 + IDLE_TIMEOUT_MS - 1), false);
  assert.equal(isInactive(1000, 1000 + IDLE_TIMEOUT_MS), true);
  assert.equal(isInactive(1000 + 500_000, 1000 + IDLE_TIMEOUT_MS), false);
});
