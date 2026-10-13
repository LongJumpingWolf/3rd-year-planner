import test from 'node:test';
import assert from 'node:assert/strict';
import { daysUntil, recentActivity, requiredPace, streak, subjectProgress } from '../../js/insights.js';

const T = (id, subject, done, doneAt) => ({ id, subject, title: id, type: 'video', durationSec: 600, done, doneAt });

test('subjectProgress counts done and total per subject', () => {
  const p = subjectProgress([T('a', 'PSM', true), T('b', 'PSM', false), T('c', 'ENT', false)]);
  assert.deepEqual(p.map((x) => [x.subject, x.done, x.total, x.pct]), [['PSM', 1, 2, 50], ['ENT', 0, 1, 0]]);
});

test('streak counts consecutive days and tolerates an unfinished today', () => {
  const tasks = [T('a', 'X', true, '2026-10-12'), T('b', 'X', true, '2026-10-11'), T('c', 'X', true, '2026-10-09')];
  assert.equal(streak(tasks, '2026-10-12'), 2);
  assert.equal(streak(tasks, '2026-10-13'), 2, 'yesterday still counts');
  assert.equal(streak(tasks, '2026-10-14'), 0);
});

test('recentActivity returns a fixed window oldest first', () => {
  const a = recentActivity([T('a', 'X', true, '2026-10-12'), T('b', 'X', true, '2026-10-12')], '2026-10-12', 3);
  assert.deepEqual(a.map((d) => [d.iso, d.count]), [['2026-10-10', 0], ['2026-10-11', 0], ['2026-10-12', 2]]);
});

test('daysUntil and requiredPace', () => {
  assert.equal(daysUntil('2026-10-12', '2026-10-22'), 10);
  assert.equal(daysUntil('2026-10-12', '2026-10-02'), -10);
  const p = requiredPace([T('a', 'X', false), T('b', 'X', false), T('c', 'X', true)], '2026-10-12', '2026-10-14');
  assert.deepEqual(p, { remaining: 2, days: 2, perDay: 1 });
  assert.equal(requiredPace([], '2026-10-12', '2026-10-01').perDay, null);
});
