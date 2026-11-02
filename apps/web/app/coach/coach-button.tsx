import Link from 'next/link';
import React from 'react';
import { coachLabels } from './coach-api';

export function CoachButton({ joinId, status = 'NOT_GENERATED', score }: { joinId: string; status?: string; score?: number | null }) {
  return <Link className="coach-button" href={`/coach/${encodeURIComponent(joinId)}`}><span aria-hidden="true">✧</span> {coachLabels[status] ?? 'יועץ AI'}{status === 'COMPLETED' && score != null ? <b dir="ltr">{score}/100</b> : null}</Link>;
}
