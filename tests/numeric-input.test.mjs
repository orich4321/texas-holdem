import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePositiveInteger } from '../apps/web/app/numeric-input.ts';

test('editable chip and blind fields can be empty without becoming zero', () => {
  assert.equal(parsePositiveInteger(''), undefined);
  assert.equal(parsePositiveInteger('0'), undefined);
  assert.equal(parsePositiveInteger('-1'), undefined);
  assert.equal(parsePositiveInteger('1.5'), undefined);
  assert.equal(parsePositiveInteger('1'), 1);
  assert.equal(parsePositiveInteger('500'), 500);
});
