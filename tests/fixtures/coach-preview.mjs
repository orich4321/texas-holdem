// Explicitly test-only UI fixture. No Gemini call and no production database.
import { createServer } from 'node:http';
import { hand, action, decision, evaluation, narrative } from './coach.mjs';
import { buildFinalReport } from '../../apps/server/src/coach/analysis.ts';
let status = 'COMPLETED';
const stored = Array.from({ length: 12 }, (_, i) => {
  const key = `hand-${i}`, seq = i + 1;
  const d = decision(`${key}:${seq}`, { handKey: key, action: action(seq, 'hero', i % 3 === 0 ? 'raise' : 'call') });
  return { hand: hand({ key, number: i + 1, decisions: [d], actions: [d.action], net: i % 3 === 0 ? 25 : -2 }),
    analysis: { handKey: key, summary: 'ניתוח בדיקה חזותית — אינו דוח Gemini אמיתי.', evaluations: [evaluation(d.id, { rating: i % 4 === 0 ? 'major_mistake' : 'good' })] } };
});
const report = buildFinalReport(stored, { playerId: 'hero', displayName: 'אורי', participants: 6, date: '2026-11-02T10:00:00Z', net: 345 },
  { ...narrative, strengths: [{ title: 'הקפדה על בחירת עמדה', explanation: 'ביד השנייה נבחר תשלום בהתאם לעומק הערימה. זהו טקסט בדיקה לממשק בלבד.', exercise: 'לבחון את גודל הקופה לפני הפעולה.', decisionIds: ['hand-1:2'] }] }, 'test-fixture-not-live-gemini');
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3100'); res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url.startsWith('/fixture/')) { status = req.url.split('/').at(-1); res.end('{}'); return; }
  if (req.url.endsWith('/coach/report')) { res.end(JSON.stringify(report)); return; }
  if (req.url.endsWith('/coach')) { res.end(JSON.stringify({ status, available: status !== 'NOT_GENERATED', totalHands: 12, completedHands: status === 'PENDING' ? 4 : 12, privacyNotice: 'נתוני בדיקה מקומיים בלבד.' })); return; }
  if (req.url === '/auth/history') { res.end(JSON.stringify({ games: [{ joinId: 'fixture', status: 'COMPLETED', createdAt: report.identity.date, yourNet: 345, handCount: 12, coach: { status, overallScore: report.scores.overall.score } }] })); return; }
  res.writeHead(404); res.end('{}');
});
server.listen(3101, '127.0.0.1');
