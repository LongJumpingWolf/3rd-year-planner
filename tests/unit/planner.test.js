import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_TASKS } from '../../js/data.js';
import {
  DEFAULT_PLAN_CONFIG, DEFAULT_SETTINGS, dayCapacity, fixedBlocks, generatePlan, inTrip, plannedSec,
  simulate, taskPlannedSec, validatePlanConfig, weekSummary, weekdayCapacity, weeklyLoad,
} from '../../js/planner.js';
import { dateISO, fromISO } from '../../js/utils.js';

const S = { ...DEFAULT_SETTINGS };
const C = { ...DEFAULT_PLAN_CONFIG };
const fresh = () => INITIAL_TASKS.map((t) => ({ ...t, scheduledDate: null, selected: false }));

test('embedded data is sane', () => {
  assert.equal(INITIAL_TASKS.length, 270);
  assert.equal(new Set(INITIAL_TASKS.map((t) => t.id)).size, 270);
  assert.ok(INITIAL_TASKS.every((t) => t.durationSec > 0 && t.title && t.subject));
  assert.equal(INITIAL_TASKS.filter((t) => t.type === 'dataset_placeholder').length, 2);
});

test('plannedSec applies speed, annotation and recall', () => {
  const t = { durationSec: 3600 };
  assert.ok(Math.abs(plannedSec(t, { speed: 1, annotation: 25, recall: 7 }) - 3600 * 1.32) < 1e-6);
  assert.equal(plannedSec(t, { speed: 2, annotation: 0, recall: 0 }), 1800);
  assert.equal(plannedSec(t, { speed: 0, annotation: 0, recall: 0 }), 3600); // never divides by zero
});

test('weekday capacity comes from settings', () => {
  assert.equal(weekdayCapacity(S), 4);
  assert.equal(weekdayCapacity({ ...S, studyHours: 3, collegeHours: 0.5 }), 3.5);
});

test('dayCapacity: trip, weekends, DAMS weekends and the Nov break', () => {
  const cap = (iso) => dayCapacity(fromISO(iso), C, S);
  assert.equal(cap('2026-12-01'), 0);
  assert.equal(cap('2026-12-15'), 0);
  assert.equal(cap('2026-12-16'), 4); // Wed after trip
  assert.equal(cap('2026-10-17'), 6); // Saturday before DAMS
  assert.equal(cap('2026-10-18'), 6); // Sunday before DAMS
  assert.equal(cap('2026-11-14'), 0.5); // Saturday, DAMS
  assert.equal(cap('2026-11-15'), 0.5); // Sunday, DAMS
  assert.equal(cap('2026-11-02'), 6); // weekday in the college break -> at least 6
  assert.equal(cap('2026-10-13'), 4);
  assert.ok(inTrip('2026-12-10', C));
  assert.ok(!inTrip('2026-11-30', C));
});

test('validatePlanConfig rejects bad input', () => {
  assert.equal(validatePlanConfig(C), null);
  assert.match(validatePlanConfig({ ...C, start: '' }), /valid date/);
  assert.match(validatePlanConfig({ ...C, start: '2026-02-31' }), /valid date/);
  assert.match(validatePlanConfig({ ...C, end: '2026-10-01' }), /target finish/);
  assert.match(validatePlanConfig({ ...C, backstop: '2026-12-01' }), /backstop/);
  assert.match(validatePlanConfig({ ...C, tripEnd: '2026-11-01' }), /trip end/);
  assert.match(validatePlanConfig({ ...C, weekendLight: -1 }), /Weekend capacities/);
  assert.match(validatePlanConfig({ ...C, weekendFocus: NaN }), /Weekend capacities/);
});

test('fixedBlocks: nothing lands in the trip; catch-up and post-end follow it', () => {
  const blocks = fixedBlocks(C, S);
  assert.ok(blocks.length > 20);
  assert.ok(blocks.every((b) => !inTrip(b.date, C)));
  const catchup = blocks.filter((b) => b.id.startsWith('CATCHUP'));
  assert.equal(catchup[0].date, '2026-12-16');
  assert.equal(catchup.at(-1).date, '2026-12-31');
  assert.ok(catchup.every((b) => { const d = fromISO(b.date).getDay(); return d >= 1 && d <= 5; }));
  assert.ok(blocks.filter((b) => b.id.startsWith('POSTEND')).every((b) => b.date >= '2026-12-16' && b.date <= '2027-01-07'));
  assert.ok(blocks.filter((b) => b.id.startsWith('DAMS')).every((b) => b.date >= '2026-11-13'));
  assert.ok(blocks.filter((b) => b.id.startsWith('REVIEW')).every((b) => fromISO(b.date).getDay() === 0));
  assert.equal(new Set(blocks.map((b) => b.id)).size, blocks.length);
});

test('fixedBlocks: no catch-up when the trip is outside the plan', () => {
  const blocks = fixedBlocks({ ...C, tripStart: '2026-01-01', tripEnd: '2026-01-05' }, S);
  assert.equal(blocks.filter((b) => b.id.startsWith('CATCHUP') || b.id.startsWith('POSTEND')).length, 0);
});

test('generatePlan: default plan respects trip, backstop, capacity and never mutates input', () => {
  const input = fresh();
  const snapshot = JSON.stringify(input);
  const res = generatePlan(input, C, S, new Date('2026-10-11T00:00:00Z'));
  assert.equal(JSON.stringify(input), snapshot, 'input must not be mutated');
  assert.ok(!res.error);
  const { tasks, backlog, meta } = res;
  const vids = tasks.filter((t) => t.type === 'video');
  const scheduled = vids.filter((t) => t.scheduledDate);
  assert.equal(scheduled.length + backlog.length, vids.length, 'every video is either placed or reported');
  assert.equal(meta.placed, scheduled.length);
  assert.ok(scheduled.length > 200, 'most of the library fits');
  for (const t of tasks) {
    if (!t.scheduledDate) continue;
    assert.ok(!inTrip(t.scheduledDate, C), `${t.id} scheduled in trip`);
    assert.ok(t.scheduledDate >= C.start && t.scheduledDate <= C.backstop, `${t.id} outside window`);
  }
  // Video work never pushes a day past its capacity (fixed blocks are allowed to exceed it on their own).
  for (const iso of new Set(scheduled.map((t) => t.scheduledDate))) {
    const fixed = tasks.filter((t) => t.generated && t.scheduledDate === iso).reduce((s, t) => s + t.durationSec / 3600, 0);
    const vid = scheduled.filter((t) => t.scheduledDate === iso).reduce((s, t) => s + plannedSec(t, S) / 3600, 0);
    const cap = dayCapacity(fromISO(iso), C, S);
    assert.ok(fixed + vid <= Math.max(cap, fixed) + 0.002, `${iso}: ${fixed + vid} > ${cap}`);
  }
  // Placeholders (verified totals only) are never scheduled as videos.
  assert.ok(tasks.filter((t) => t.type === 'dataset_placeholder').every((t) => !t.scheduledDate));
  // Subject order: PSM before Ophthalmology.
  const first = (subject) => scheduled.filter((t) => t.subject === subject).map((t) => t.scheduledDate).sort()[0];
  assert.ok(first('PSM') <= first('Ophthalmology'));
});

test('generatePlan is deterministic and idempotent', () => {
  const a = generatePlan(fresh(), C, S, new Date(0));
  const b = generatePlan(a.tasks, C, S, new Date(0));
  const view = (r) => r.tasks.map((t) => [t.id, t.scheduledDate]).sort((x, y) => x[0].localeCompare(y[0]));
  assert.deepEqual(view(b), view(a));
  assert.deepEqual(b.backlog, a.backlog);
});

test('generatePlan keeps completed tasks and manually pinned tasks exactly where they are', () => {
  const tasks = fresh();
  tasks[0].done = true; tasks[0].scheduledDate = '2026-10-12';
  tasks[1].pinned = true; tasks[1].scheduledDate = '2026-10-20';
  const res = generatePlan(tasks, C, S);
  const byId = Object.fromEntries(res.tasks.map((t) => [t.id, t]));
  assert.equal(byId[tasks[0].id].scheduledDate, '2026-10-12');
  assert.equal(byId[tasks[0].id].done, true);
  assert.equal(byId[tasks[1].id].scheduledDate, '2026-10-20');
  assert.equal(byId[tasks[1].id].pinned, true);
});

test('generatePlan preserves completed generated blocks across regeneration', () => {
  const first = generatePlan(fresh(), C, S);
  const review = first.tasks.find((t) => t.id.startsWith('REVIEW-'));
  review.done = true;
  const second = generatePlan(first.tasks, C, S);
  assert.equal(second.tasks.find((t) => t.id === review.id).done, true);
});

test('generatePlan reports overflow instead of hiding it', () => {
  const res = generatePlan(fresh(), { ...C, end: '2026-10-20', backstop: '2026-10-25' }, S);
  assert.ok(res.backlog.length > 150 && res.backlog.length < 268);
  const ids = new Set(fresh().map((t) => t.id));
  assert.ok(res.backlog.every((b) => b.reason && ids.has(b.taskId)));
});

test('generatePlan: a non-splittable video longer than any focused block goes to the backlog', () => {
  const tasks = [{ id: 'BIG', subject: 'X', category: 'x', title: 'Huge', durationSec: 10 * 3600, status: 'provided', type: 'video', done: false, splittable: false }];
  const res = generatePlan(tasks, C, S);
  assert.equal(res.backlog.length, 1);
  assert.match(res.backlog[0].reason, /focused-work capacity/);
  assert.equal(res.tasks.find((t) => t.id === 'BIG').scheduledDate, null);
});

test('generatePlan returns an error for invalid config without touching tasks', () => {
  const res = generatePlan(fresh(), { ...C, end: '2020-01-01' }, S);
  assert.ok(res.error);
  assert.equal(res.tasks, undefined);
});

test('slower settings never fit more lectures (monotonic)', () => {
  const fast = generatePlan(fresh(), C, { ...S, speed: 2, annotation: 0, recall: 0 });
  const slow = generatePlan(fresh(), C, { ...S, speed: 1, annotation: 50, recall: 10 });
  assert.ok(fast.backlog.length <= slow.backlog.length);
});

test('weeklyLoad groups by Monday and counts completed', () => {
  const tasks = [
    { id: 'a', durationSec: 3600, scheduledDate: '2026-10-12', type: 'video', done: true },
    { id: 'b', durationSec: 3600, scheduledDate: '2026-10-18', type: 'video', done: false },
    { id: 'c', durationSec: 3600, scheduledDate: '2026-10-19', type: 'video', done: false },
    { id: 'd', durationSec: 3600, scheduledDate: null, type: 'video', done: false },
  ];
  const w = weeklyLoad(tasks, { speed: 1, annotation: 0, recall: 0 });
  assert.deepEqual(w.map((x) => [x.week, x.tasks, x.done]), [['2026-10-12', 2, 1], ['2026-10-19', 1, 0]]);
  assert.equal(w[0].hours, 2);
});

test('weekSummary: capacity minus open planned work', () => {
  const tasks = [{ id: 'a', durationSec: 3600, scheduledDate: '2026-10-13', type: 'video', done: false }];
  const s = { ...S, speed: 1, annotation: 0, recall: 0, weeklyBuffer: 6, studyHours: 2.5, collegeHours: 1.5 };
  const w = weekSummary(tasks, fromISO('2026-10-14'), C, s);
  assert.equal(w.capacity, 5 * 4 + 2 * 6); // 5 weekdays x (1.5 light + 2.5 focused) + 2 free weekend days x (2 + 4)
  assert.equal(w.planned, 1);
  assert.equal(w.free, 31);
  tasks[0].done = true; // done tasks no longer consume capacity
  assert.equal(weekSummary(tasks, fromISO('2026-10-14'), C, s).planned, 0);
});

test('simulate: reserve, per-day load and risk', () => {
  assert.equal(simulate({ hours: 2, reserve: 6, days: 3, existing: 1 }, 4).risk, 'Manageable');
  assert.equal(simulate({ hours: 8, reserve: 6, days: 3, existing: 1 }, 4).risk, 'Over reserve');
  assert.equal(simulate({ hours: 6, reserve: 10, days: 1, existing: 2 }, 4).risk, 'Overloaded');
  const r = simulate({ hours: '3', reserve: '6', days: '0', existing: '' }, 4);
  assert.equal(r.days, 1); // never divides by zero
  assert.equal(r.perDay, 3);
  assert.equal(simulate({ hours: -4, reserve: 6, days: 3, existing: 0 }, 4).hours, 0);
});

test('scheduled dates are valid ISO strings', () => {
  const res = generatePlan(fresh(), C, S);
  assert.ok(res.tasks.filter((t) => t.scheduledDate).every((t) => dateISO(fromISO(t.scheduledDate)) === t.scheduledDate));
});

test('taskPlannedSec does not inflate generated planning blocks', () => {
  assert.equal(taskPlannedSec({ generated: true, durationSec: 1800 }, S), 1800);
  assert.ok(taskPlannedSec({ type: 'video', durationSec: 1800 }, S) > 1800);
});
