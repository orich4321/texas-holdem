'use client';

import { useEffect, useState } from 'react';

export const IDLE_TIMEOUT_MS = 10 * 60 * 1_000;

export function isInactive(lastInteraction: number, now: number): boolean {
  return now - lastInteraction >= IDLE_TIMEOUT_MS;
}

/** Suspends network activity without changing the durable room or player seat. */
export function usePageActivity() {
  const [visible, setVisible] = useState(true);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let lastInteraction = Date.now();
    const check = () => {
      const isVisible = document.visibilityState === 'visible';
      setVisible(isVisible);
      if (isInactive(lastInteraction, Date.now())) setPaused(true);
    };
    const interact = () => {
      lastInteraction = Date.now();
      setPaused(false);
    };
    check();
    const timer = window.setInterval(check, 15_000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    window.addEventListener('pointerdown', interact, { passive: true });
    window.addEventListener('keydown', interact);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
      window.removeEventListener('pointerdown', interact);
      window.removeEventListener('keydown', interact);
    };
  }, []);

  return { networkActive: visible && !paused, paused, resume: () => setPaused(false) };
}
