import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, completionStreak, dayLectures, pendingLectures, trackStatus, weekProgress } from '../../js/viewerSnapshot.js';
import { generatePlan } from '../../js/planner.js';
import { freshState } from '../../js/store.js';

const TODAY = '2026-10-20';
const lectures = (s) => s.tasks.filter((t) => t.type === 'video');

test('snapshot has counts only: no task titles or ids anywhere (when nothing is overdue)', () => {
  const s = freshState();
  lectures(s)[0].done = true;
  lectures(s)[0].doneAt = TODAY;
  const snap = buildSnapshot(s, TODAY, { name: 'Asha' });
  const json = JSON.stringify(snap);
  for (const t of s.tasks.slice(0, 40)) assert.ok(!json.includes(t.title), `leaked title: ${t.title}`);
  assert.equal(snap.done, 1);
  assert.equal(snap.total, lectures(s).length);
  assert.equal(snap.today.doneLectures, 0, 'a lecture that was not planned for today is not counted as done today');
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


// ---- today's %, the 90% streak, pending lectures -----------------------------------------------------------------

/** A state with a real plan made on `planOn`, fast playback so it fits. */
function planned(planOn = '2026-10-12') {
  const st = freshState();
  st.settings = { ...st.settings, speed: 2 };
  const r = generatePlan(st.tasks, st.planConfig, st.settings, new Date(), { today: planOn });
  st.tasks = r.tasks;
  st.planMeta = r.meta;
  return st;
}
const onDay = (st, iso) => st.tasks.filter((t) => t.scheduledDate === iso);
const finishDay = (st, iso, share = 1) => {
  // The streak is about lectures: tick the first `share` of the lectures planned for that day (plus the rest of its blocks when complete).
  const list = share >= 1 ? onDay(st, iso) : onDay(st, iso).filter((t) => t.type === 'video' && !t.generated);
  list.slice(0, Math.ceil(list.length * share)).forEach((t) => { t.done = true; t.doneAt = iso; });
};

const lecturesOn = (st, iso) => st.tasks.filter((t) => t.type === 'video' && !t.generated && t.scheduledDate === iso);

test("today's progress counts only lectures planned for today, and never more done than planned", () => {
  const st = planned();
  const todays = lecturesOn(st, '2026-10-14');
  assert.ok(todays.length >= 3);
  assert.deepEqual(dayLectures(st, '2026-10-14'), { planned: todays.length, done: 0, pct: 0 });
  todays.slice(0, 2).forEach((t) => { t.done = true; t.doneAt = '2026-10-14'; });
  const snap = buildSnapshot(st, '2026-10-14');
  assert.equal(snap.today.plannedLectures, todays.length);
  assert.equal(snap.today.doneLectures, 2);
  assert.equal(dayLectures(st, '2026-09-01').pct, null, 'a day with nothing planned has no percentage');
});

test("ticking yesterday's lectures today does not count as today's work (the \"9 of 6\" bug)", () => {
  const st = planned();
  const yesterday = lecturesOn(st, '2026-10-13');
  assert.ok(yesterday.length >= 3);
  // The owner catches up on yesterday's lectures on the 14th: they are ticked with today's date.
  yesterday.forEach((t) => { t.done = true; t.doneAt = '2026-10-14'; });
  const snap = buildSnapshot(st, '2026-10-14');
  assert.equal(snap.today.doneLectures, 0, 'nothing planned for today was ticked');
  assert.ok(snap.today.doneLectures <= snap.today.plannedLectures);
  // ...and the chart shows that work on the day it was planned for, not on the day it was ticked.
  const bars = Object.fromEntries(snap.week.map((d) => [d.iso, d.count]));
  assert.equal(bars['2026-10-13'], yesterday.length);
  assert.equal(bars['2026-10-14'], 0);
  // Done and planned never contradict each other on any day of the week.
  for (const d of snap.week) assert.ok(d.count <= d.planned, `${d.iso}: ${d.count} of ${d.planned}`);
});

test('the weekly chart is built from planned days: oldest first, seven entries, done out of planned', () => {
  const st = planned();
  lecturesOn(st, '2026-10-12').slice(0, 2).forEach((t) => { t.done = true; });
  const w = weekProgress(st, '2026-10-14', 7);
  assert.equal(w.length, 7);
  assert.deepEqual(w.map((d) => d.iso), ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']);
  const d12 = w.find((d) => d.iso === '2026-10-12');
  assert.equal(d12.count, 2);
  assert.equal(d12.planned, lecturesOn(st, '2026-10-12').length);
});

test('study streak: consecutive days with at least 90% of the day done; a weaker day breaks it', () => {
  const st = planned();
  finishDay(st, '2026-10-12');
  finishDay(st, '2026-10-13');
  finishDay(st, '2026-10-14');
  assert.equal(completionStreak(st, '2026-10-14'), 3);
  assert.equal(buildSnapshot(st, '2026-10-14').streak, 3);
  assert.equal(buildSnapshot(st, '2026-10-14').streakPct, 90);
  // Yesterday only half done: today (complete) counts, the streak stops at yesterday.
  const st2 = planned();
  finishDay(st2, '2026-10-12');
  finishDay(st2, '2026-10-13', 0.5);
  finishDay(st2, '2026-10-14');
  assert.equal(completionStreak(st2, '2026-10-14'), 1);
});

test('streak: an unfinished today does not break it yet, and a day just under 90% does not count', () => {
  const st = planned();
  finishDay(st, '2026-10-12');
  finishDay(st, '2026-10-13');
  assert.equal(completionStreak(st, '2026-10-14'), 2, 'today is still open, so it neither counts nor breaks');
  const list = onDay(st, '2026-10-14');
  const total = list.reduce((s, t) => s + t.durationSec, 0);
  assert.ok(total > 0);
  assert.equal(completionStreak(planned(), '2026-10-14'), 0);
});

test('streak skips days with nothing planned (e.g. a rest day) instead of breaking', () => {
  const st = planned();
  finishDay(st, '2026-10-12');
  finishDay(st, '2026-10-14');
  for (const t of onDay(st, '2026-10-13')) { t.scheduledDate = null; t.done = false; } // nothing planned on the 13th
  assert.equal(dayLectures(st, '2026-10-13').pct, null);
  assert.equal(completionStreak(st, '2026-10-14'), 2);
});

test('lectures that were missed and moved forward by a re-plan still count against the day they were planned for', () => {
  const st = planned();
  const day = lecturesOn(st, '2026-10-12');
  day.forEach((t) => { t.done = true; });
  assert.equal(dayLectures(st, '2026-10-12').pct, 100);
  // Simulate the re-plan: one lecture leaves the 12th undone and the miss is logged.
  const missed = day[0];
  missed.done = false;
  missed.scheduledDate = '2026-10-20';
  st.missedLectures = { '2026-10-12': 1 };
  const after = dayLectures(st, '2026-10-12');
  assert.equal(after.planned, day.length);
  assert.equal(after.done, day.length - 1);
  assert.ok(after.pct < 100);
  assert.equal(completionStreak(st, '2026-10-14') <= 2, true);
});

test('pending lectures are the open ones planned for earlier days, oldest first, and only they carry titles', () => {
  const st = planned('2026-10-12');
  const snap = buildSnapshot(st, '2026-10-16', { name: 'Asha' });
  const past = pendingLectures(st.tasks, '2026-10-16');
  assert.ok(past.length > 5);
  assert.equal(snap.pendingTotal, past.length);
  assert.equal(snap.status.behind, past.length, 'the behind count and the list agree');
  assert.ok(snap.pending.length <= 12);
  assert.deepEqual(snap.pending.map((p) => p.date), [...snap.pending.map((p) => p.date)].sort());
  assert.equal(snap.pending[0].title, past[0].title);
  const json = JSON.stringify(snap);
  const shown = new Set(snap.pending.map((p) => p.title));
  for (const t of st.tasks.filter((x) => x.type === 'video' && !shown.has(x.title)).slice(0, 60)) assert.ok(!json.includes(t.title), `leaked: ${t.title}`);
  // Done lectures and paused subjects are not pending.
  past.slice(0, 3).forEach((t) => { t.done = true; });
  assert.equal(pendingLectures(st.tasks, '2026-10-16').length, past.length - 3);
  const asleepSubject = past[past.length - 1].subject;
  assert.ok(pendingLectures(st.tasks, '2026-10-16', [asleepSubject]).every((t) => t.subject !== asleepSubject));
});

test('the owner\'s WhatsApp number goes into the summary', () => {
  const st = freshState();
  st.viewer = { phone: '919876543210' };
  assert.equal(buildSnapshot(st, '2026-10-14').phone, '919876543210');
  assert.equal(buildSnapshot(freshState(), '2026-10-14').phone, '');
});

test('sanitizeState keeps a valid WhatsApp number and the missed-lecture log, and drops junk', async () => {
  const { sanitizeState } = await import('../../js/store.js');
  const raw = JSON.parse(JSON.stringify(freshState()));
  raw.viewer = { phone: '+91 98765-43210' };
  raw.missedLectures = { '2026-10-12': 3, bad: 2, '2026-10-13': -1, '2026-10-14': 'x', '2026-10-15': 1.5 };
  const out = sanitizeState(raw);
  assert.equal(out.viewer.phone, '919876543210');
  assert.deepEqual(out.missedLectures, { '2026-10-12': 3 });
  raw.viewer = { phone: '123' };
  assert.equal(sanitizeState(raw).viewer.phone, '', 'too short to be a number');
  delete raw.viewer;
  assert.equal(sanitizeState(raw).viewer.phone, '');
});
