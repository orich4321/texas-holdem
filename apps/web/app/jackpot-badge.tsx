'use client';

import { useEffect, useState } from 'react';
import { SERVER_URL } from './account-api';

export function JackpotBadge({ active = true, revision }: { active?: boolean; revision?: string | number }) {
  const [balance, setBalance] = useState<number>();
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const response = await fetch(`${SERVER_URL}/jackpot`, { signal: controller.signal });
        if (!response.ok) throw new Error();
        const body = await response.json() as { balance: number };
        if (Number.isFinite(body.balance) && !controller.signal.aborted) setBalance(body.balance);
      } catch { /* Keep the last balance; jackpot failures never prevent play. */ }
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 20_000);
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, revision]);
  return <span className="jackpot-badge" title="ג׳קפוט משותף לכל השולחנות. כל שחקן שמקבל קלפים תורם 0.1 צ׳יפ. זכייה בכל קופה עם 2–7 בצורות שונות מזכה בג׳קפוט."><span>ג׳קפוט <b dir="ltr">2–7</b></span><strong>{balance === undefined ? '…' : balance.toLocaleString('he-IL', { maximumFractionDigits: 1 })}</strong></span>;
}
