import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHIP_VALUES, breakChip, chipTotal, clearChipSelection, createChipTray, displayChipCounts, returnChip, selectAllChips, selectChip } from '../apps/web/app/betting-chips.ts';

const total = (tray) => chipTotal(tray.available) + chipTotal(tray.selected);

test('chip piles represent exactly the authoritative stack across small and large balances', () => {
  for (const stack of [0, 1, 7, 75, 100, 500, 1_501]) {
    const tray = createChipTray(stack);
    assert.equal(total(tray), stack);
    assert.equal(chipTotal(tray.selected), 0);
    assert.ok(CHIP_VALUES.every((value) => Number.isInteger(tray.available[value]) && tray.available[value] >= 0));
  }
});

test('visible wagers and calls use compact denominations without changing their totals', () => {
  for (const amount of [0, 1, 7, 25, 50, 75, 150, 1_237]) {
    assert.equal(chipTotal(displayChipCounts(amount)), amount);
  }
  assert.equal(displayChipCounts(50)[50], 1);
  assert.equal(displayChipCounts(75)[25], 1);
  assert.equal(displayChipCounts(150)[100], 1);
  assert.equal(displayChipCounts(150)[50], 1);
});

test('players can compose 150 and 75 with different physical chip combinations', () => {
  const original = createChipTray(500);
  const oneFifty = selectChip(selectChip(original, 100), 50);
  assert.equal(chipTotal(oneFifty.selected), 150);
  const seventyFive = selectChip(selectChip(original, 50), 25);
  assert.equal(chipTotal(seventyFive.selected), 75);
  let threeGreens = original;
  threeGreens = breakChip(threeGreens, 100);
  threeGreens = breakChip(threeGreens, 50);
  threeGreens = breakChip(threeGreens, 50);
  for (let index = 0; index < 3; index += 1) threeGreens = selectChip(threeGreens, 25);
  assert.equal(chipTotal(threeGreens.selected), 75);
  assert.equal(total(threeGreens), 500);
});

test('splitting, returning, clearing and all-in never create or lose chips', () => {
  let tray = createChipTray(500);
  tray = breakChip(tray, 5);
  tray = selectChip(tray, 1);
  tray = selectChip(tray, 100);
  assert.equal(total(tray), 500);
  tray = returnChip(tray, 100);
  assert.equal(chipTotal(tray.selected), 1);
  tray = clearChipSelection(tray);
  assert.equal(chipTotal(tray.selected), 0);
  tray = selectAllChips(tray);
  assert.equal(chipTotal(tray.selected), 500);
  assert.equal(chipTotal(tray.available), 0);
  assert.equal(total(tray), 500);
});
