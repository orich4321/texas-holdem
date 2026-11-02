import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { URL } from 'node:url';
import { CoachButton } from '../apps/web/app/coach/coach-button.tsx';
import { CoachScreen } from '../apps/web/app/coach/coach-screen.tsx';
import { filterCoachHands } from '../apps/web/app/coach/coach-view.ts';
import { coachProgressText } from '../apps/web/app/coach/coach-api.ts';
import { hand, decision, evaluation } from './fixtures/coach.mjs';
const requireWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const React = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');

test('coach UI: every state uses the same private report route; completed button only opens saved report', () => {
  const labels = { NOT_GENERATED: 'יועץ AI', PENDING: 'ממתין לניתוח', PROCESSING: 'מנתח את המשחק', COMPLETED: 'צפה בדוח AI', FAILED: 'נסה שוב', RATE_LIMITED: 'ממתין למכסת AI' };
  for (const [status, label] of Object.entries(labels)) {
    const markup = renderToStaticMarkup(React.createElement(CoachButton, { joinId: 'same-game', status, score: 84 }));
    assert.ok(markup.includes(label));
    assert.ok(markup.includes('href="/coach/same-game"'));
    assert.equal(markup.includes('84/100'), status === 'COMPLETED');
    assert.equal(markup.includes('Regenerate'), false);
  }
});
test('coach UI: loading renders accessibly without starting inference during server render', () => {
  const markup = renderToStaticMarkup(React.createElement(CoachScreen, { joinId: 'game' }));
  assert.match(markup, /role="status"/);
  assert.match(markup, /טוענים את היועץ האישי/);
  assert.match(markup, /dir="rtl"/);
});

test('coach UI: queued, active, quota and retry states explain the actual wait', () => {
  assert.match(coachProgressText({ status: 'PENDING', queueState: 'WAITING' }), /בתור לעיבוד/);
  assert.match(coachProgressText({ status: 'PROCESSING', queueState: 'RUNNING' }), /מנתחים כעת/);
  assert.match(coachProgressText({ status: 'PENDING', queueState: 'QUOTA_WAIT' }), /מכסה החינמית/);
  assert.match(coachProgressText({ status: 'PENDING', queueState: 'RETRY_WAIT' }), /לניסיון נוסף/);
});
test('coach UI: hand filters and severity ordering preserve all-hand coverage and never mutate stored data', () => {
  const hs = [hand({ number: 1, key: 'a', position: 'BB', decisions: [decision('a:1', { street: 'river' })], analysis: { evaluations: [evaluation('a:1', { rating: 'good', confidence: 'high' })] } }),
    hand({ number: 2, key: 'b', position: 'BTN', decisions: [decision('b:1')], analysis: { evaluations: [evaluation('b:1', { rating: 'severe_mistake', confidence: 'medium' })] } }),
    hand({ number: 3, key: 'c', decisions: [], analysis: { evaluations: [] } })];
  const base = { filter: 'all', street: 'all', position: 'all', certainty: 'all', sort: 'number' };
  const before = JSON.stringify(hs);
  assert.deepEqual(filterCoachHands(hs, base).map((h) => h.key), ['a', 'b', 'c']);
  assert.deepEqual(filterCoachHands(hs, { ...base, filter: 'errors' }).map((h) => h.key), ['b']);
  assert.deepEqual(filterCoachHands(hs, { ...base, street: 'river', certainty: 'high', position: 'BB' }).map((h) => h.key), ['a']);
  assert.deepEqual(filterCoachHands(hs, { ...base, sort: 'severity' }).map((h) => h.key), ['b', 'a', 'c']);
  assert.equal(JSON.stringify(hs), before);
});
