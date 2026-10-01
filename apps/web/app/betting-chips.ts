export const CHIP_VALUES = [100, 50, 25, 5, 1] as const;
export type ChipValue = (typeof CHIP_VALUES)[number];
export type ChipCounts = Record<ChipValue, number>;
export type ChipTray = { available: ChipCounts; selected: ChipCounts };

const emptyCounts = (): ChipCounts => ({ 100: 0, 50: 0, 25: 0, 5: 0, 1: 0 });

/** A visual denomination of the authoritative stack, never a second balance. */
export function createChipTray(stack: number): ChipTray {
  const available = emptyCounts();
  let remainder = Number.isSafeInteger(stack) && stack > 0 ? stack : 0;
  for (const [value, target] of [[1, 5], [5, 4], [25, 1], [50, 1]] as const) {
    const count = Math.min(target, Math.floor(remainder / value));
    available[value] = count;
    remainder -= count * value;
  }
  for (const value of CHIP_VALUES) {
    const count = Math.floor(remainder / value);
    available[value] += count;
    remainder -= count * value;
  }
  return { available, selected: emptyCounts() };
}

export function chipTotal(counts: ChipCounts): number {
  return CHIP_VALUES.reduce((total, value) => total + value * counts[value], 0);
}

export function selectChip(tray: ChipTray, value: ChipValue): ChipTray {
  if (tray.available[value] < 1) return tray;
  return {
    available: { ...tray.available, [value]: tray.available[value] - 1 },
    selected: { ...tray.selected, [value]: tray.selected[value] + 1 },
  };
}

export function returnChip(tray: ChipTray, value: ChipValue): ChipTray {
  if (tray.selected[value] < 1) return tray;
  return {
    available: { ...tray.available, [value]: tray.available[value] + 1 },
    selected: { ...tray.selected, [value]: tray.selected[value] - 1 },
  };
}

export function clearChipSelection(tray: ChipTray): ChipTray {
  const available = emptyCounts();
  for (const value of CHIP_VALUES) available[value] = tray.available[value] + tray.selected[value];
  return { available, selected: emptyCounts() };
}

export function selectAllChips(tray: ChipTray): ChipTray {
  const selected = emptyCounts();
  for (const value of CHIP_VALUES) selected[value] = tray.available[value] + tray.selected[value];
  return { available: emptyCounts(), selected };
}

/** Breaks one available chip into the next smaller denomination. */
export function breakChip(tray: ChipTray, value: ChipValue): ChipTray {
  const index = CHIP_VALUES.indexOf(value);
  if (index < 0 || index === CHIP_VALUES.length - 1 || tray.available[value] < 1) return tray;
  const smaller = CHIP_VALUES[index + 1];
  return {
    ...tray,
    available: {
      ...tray.available,
      [value]: tray.available[value] - 1,
      [smaller]: tray.available[smaller] + value / smaller,
    },
  };
}
