import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, trackStatus } from '../../js/viewerSnapshot.js';
import { freshState } from '../../js/store.js';

const TODAY = '2026-10-20';
const lectures = (s) => s.tasks.filter((t) => t.type === 'video');

test('snapshot has counts only: no task titles or ids anywhere', () => {
  const s = freshState();
  lectures(s)[0].done = true;
  lectures(s)[0].doneAt = TODAY;
  const snap = buildSnapshot(s, TODAY, { name: 'Asha' });
  const json = JSON.stringify(snap);
  for (const t of s.tasks.slice(0, 40)) assert.ok(!json.includes(t.title), `leaked title: ${t.title}`);
  assert.equal(snap.done, 1);
  assert.equal(snap.total, lectures(s).length);
  assert.equal(snap.today.doneLectures, 1);
  assert.equal(snap.name, 'Asha');
  assert.equal(snap.week.length, 7);
});

test('trackStatus: not started, on track, slightly behind, behind, done', () => {
  const s = freshState();
  const ls = lectures(s);
  ls.forEach((t) => { t.scheduledDate = null; });
  assert.equal(trackStatus(s.tasks, '2026-10-01', '2026-10-12').code, 'notstarted');
  assert.equal(trackStatus(s.tasks, TODAY, '2026-10-12').code, 'ontrack');
  ls.slice(0, 2).forEach((t) => { t.scheduledDate = '2026-10-18'; });
  assert.deepEqual(trackStatus(s.tasks, TODAY, '2026-10-12'), { code: 'slightly', behind: 2 });
  ls.slice(0, 6).forEach((t) => { t.scheduledDate = '2026-10-18'; });
  assert.equal(trackStatus(s.tasks, TODAY, '2026-10-12').code, 'behind');
  ls.forEach((t) => { t.done = true; });
  assert.equal(trackStatus(s.tasks, TODAY, '2026-10-12').code, 'done');
});

test('lectures planned for today do not count as behind; done ones never do', () => {
  const s = freshState();
  lectures(s).forEach((t) => { t.scheduledDate = null; });
  lectures(s)[0].scheduledDate = TODAY;
  lectures(s)[1].scheduledDate = '2026-10-10';
  lectures(s)[1].done = true;
  assert.equal(trackStatus(s.tasks, TODAY, '2026-10-12').behind, 0);
});

test('extras: only the last 7 days are included, newest first', () => {
  const s = freshState();
  s.extras = { '2026-10-20': ['40 MCQs'], '2026-10-18': ['Revised notes'], '2026-10-10': ['too old'] };
  const snap = buildSnapshot(s, TODAY);
  assert.deepEqual(snap.extras.map((e) => e.date), ['2026-10-20', '2026-10-18']);
  assert.deepEqual(snap.extras[0].items, ['40 MCQs']);
});

test('sanitizeState keeps valid extras and drops junk', async () => {
  const { sanitizeState } = await import('../../js/store.js');
  const raw = JSON.parse(JSON.stringify(freshState()));
  raw.extras = { '2026-10-20': ['  ok  ', '', 5, 'x'.repeat(500)], 'bad-date': ['no'], '2026-10-21': 'nope' };
  const out = sanitizeState(raw);
  assert.deepEqual(Object.keys(out.extras), ['2026-10-20']);
  assert.equal(out.extras['2026-10-20'][0], 'ok');
  assert.equal(out.extras['2026-10-20'].at(-1).length, 100);
});
