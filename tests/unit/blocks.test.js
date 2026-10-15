// Light work vs focused work: capacities, assignment, splitting, overrides, exceptions, regeneration, migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_TASKS } from '../../js/data.js';
import {
  BLOCKS, DEFAULT_PLAN_CONFIG, DEFAULT_SETTINGS, blockOf, dayBlocks, dayStats, fmtClock, generatePlan, intensityOf, isCompatible,
  lectureKey, lectureStats, taskPlannedSec, usageMap, validateSettingsTimes, weeklyLoad,
} from '../../js/planner.js';
import { assignTask, autoPlaceTask, fixOverflow, reclassifyTask, setDayException, splitInState, unscheduleTask } from '../../js/taskOps.js';
import { freshState, sanitizeState } from '../../js/store.js';
import { fromISO } from '../../js/utils.js';

const S = { ...DEFAULT_SETTINGS };
const C = { ...DEFAULT_PLAN_CONFIG, exceptions: {} };
const planned = () => {
  const st = freshState();
  const res = generatePlan(st.tasks, st.planConfig, st.settings);
  st.tasks = res.tasks; st.backlog = res.backlog; st.planMeta = res.meta;
  return st;
};
const lecture = (id, minutes, extra = {}) => ({ id, subject: 'T', category: 'T', title: `Lecture ${id}`, durationSec: minutes * 60, status: 'provided', type: 'video', done: false, scheduledDate: null, ...extra });
const settingsNoOverhead = { ...S, annotation: 0, recall: 0 };
// A calendar where no day can hold a 2.5 h lecture whole when focused work is 1 h: no college break, short weekends.
const TIGHT = { ...C, weekendFocus: 1, weekendLight: 1, breakStart: '2025-01-01', breakEnd: '2025-01-02' };
const keys = (tasks) => new Set(tasks.filter((t) => t.type === 'video').map((t) => t.parentId || t.id));

test('1. normal weekday: both blocks are filled, independently, within their own capacities', () => {
  const st = planned();
  const d = dayStats(st.tasks, '2026-10-14', st.planConfig, st.settings);
  assert.equal(d.blocks.light.cap, 1.5);
  assert.equal(d.blocks.focus.cap, 2.5);
  assert.ok(d.blocks.light.planned > 1.4 && d.blocks.light.planned <= 1.5 + 1e-6);
  assert.ok(d.blocks.focus.planned > 2 && d.blocks.focus.planned <= 2.5 + 1e-6);
  assert.ok(d.blocks.light.tasks.length >= 3, 'light work has several short tasks');
  // lectures are only in focused work; light work holds only prep tasks
  assert.ok(d.blocks.focus.tasks.some((t) => t.type === 'video'));
  assert.ok(d.blocks.light.tasks.every((t) => t.generated || intensityOf(t) === 'light'));
  assert.equal(d.blocks.light.over, 0);
  assert.equal(d.blocks.focus.over, 0);
});

test('1b. the plan never over-books any block on any day', () => {
  const st = planned();
  for (let d = fromISO('2026-10-12'); d <= fromISO('2027-01-07'); d.setDate(d.getDate() + 1)) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const s = dayStats(st.tasks, iso, st.planConfig, st.settings);
    for (const b of BLOCKS) assert.ok(s.blocks[b].over < 0.001, `${iso} ${b} over by ${s.blocks[b].over}`);
  }
});

test('2. a weekday with less college-gap time gets a smaller light block and the plan adapts', () => {
  const st = planned();
  setDayException(st, '2026-10-14', { light: 0.5 });
  assert.equal(dayBlocks(fromISO('2026-10-14'), st.planConfig, st.settings).light, 0.5);
  // regenerate with the exception in place: light work is trimmed to 30 minutes, focused unchanged
  const res = generatePlan(st.tasks, st.planConfig, st.settings);
  const d = dayStats(res.tasks, '2026-10-14', st.planConfig, st.settings);
  assert.ok(d.blocks.light.planned <= 0.5 + 1e-6);
  assert.equal(d.blocks.light.over, 0);
  assert.ok(d.blocks.focus.planned > 2);
  assert.equal(dayStats(res.tasks, '2026-10-15', st.planConfig, st.settings).blocks.light.cap, 1.5, 'other days untouched');
});

test('3. deep lectures are never placed in light work, even when focused work is completely full', () => {
  const tasks = Array.from({ length: 40 }, (_, i) => lecture(`D${String(i).padStart(2, '0')}`, 90));
  const res = generatePlan(tasks, { ...C, end: '2026-10-20', backstop: '2026-10-22' }, settingsNoOverhead);
  const lectures = res.tasks.filter((t) => t.type === 'video');
  assert.ok(res.backlog.length > 0, 'overflow is reported');
  assert.ok(res.meta.overflow.focus > 0);
  assert.ok(lectures.filter((t) => t.scheduledDate).every((t) => blockOf(t) === 'focus'));
  assert.equal(keys(res.tasks).size, 40, 'nothing silently discarded');
  const placedKeys = new Set(lectures.filter((t) => t.scheduledDate).map((t) => t.parentId || t.id));
  assert.equal(res.backlog.length + placedKeys.size, 40, 'every lecture is either placed or listed in the backlog');
  // light work stayed free of lectures
  for (const t of res.tasks.filter((x) => x.scheduledDate && blockOf(x) === 'light')) assert.ok(t.generated);
});

test('3b. manual placement of deep work into light work needs an explicit override and is flagged', () => {
  const st = planned();
  const t = st.tasks.find((x) => x.type === 'video' && !x.scheduledDate) || st.tasks.find((x) => x.type === 'video' && x.scheduledDate === '2026-10-20');
  assert.equal(isCompatible(t, 'light'), false);
  const refused = assignTask(st, t.id, '2026-10-21', 'light');
  assert.equal(refused.error, 'incompatible');
  assert.equal(refused.recommended, 'focus');
  assert.notEqual(t.block, 'light', 'nothing changed silently');
  const ok = assignTask(st, t.id, '2026-10-21', 'light', { override: true });
  assert.equal(ok.override, true);
  const s = dayStats(st.tasks, '2026-10-21', st.planConfig, st.settings).blocks.light;
  assert.ok(s.mismatched.some((x) => x.id === t.id), 'flagged as a mismatch');
});

test('3c. reclassifying a scheduled lecture as light keeps its block until moved; light work may sit in focused work', () => {
  const st = planned();
  const t = st.tasks.find((x) => x.type === 'video' && x.scheduledDate === '2026-10-20');
  assert.equal(blockOf(t), 'focus');
  const r = reclassifyTask(st, t.id, 'light');
  assert.equal(r.mismatch, false, 'light work is allowed in the focused block');
  assert.equal(blockOf(t), 'focus');
  // deep work left in light block after reclassifying is reported, never moved silently
  const l = st.tasks.find((x) => x.generated && x.id.startsWith('LIGHT-RECALL'));
  assert.equal(intensityOf(l), 'light');
  const mine = lecture('MINE', 20, { intensity: 'light', block: 'light', scheduledDate: '2026-10-22', pinned: true });
  st.tasks.push(mine);
  const r2 = reclassifyTask(st, 'MINE', 'deep');
  assert.equal(r2.mismatch, true);
  assert.equal(mine.block, 'light', 'not moved without being asked');
  const r3 = reclassifyTask(st, 'MINE', 'deep', { moveToSuitable: true });
  assert.equal(r3.mismatch, false);
  assert.equal(mine.block, 'focus');
});

test('4. a lecture too long for any focused block is split into sessions across days', () => {
  const settings = { ...settingsNoOverhead, studyHours: 1 };
  const tasks = [lecture('LONG', 150)]; // 2.5 h, but focused work is only 1 h per day
  const res = generatePlan(tasks, TIGHT, settings);
  const parts = res.tasks.filter((t) => t.parentId === 'LONG');
  assert.ok(parts.length >= 3, `parts: ${parts.length}`);
  assert.ok(parts.every((p) => p.autoSplit && p.partCount === parts.length && blockOf(p) === 'focus' && p.scheduledDate));
  assert.equal(parts.reduce((s, p) => s + p.durationSec, 0), 150 * 60, 'total runtime preserved exactly');
  assert.equal(new Set(parts.map((p) => p.id)).size, parts.length);
  assert.equal(parts[0].id, 'LONG');
  const days = parts.map((p) => p.scheduledDate);
  assert.ok(new Set(days).size >= 2, 'on different days');
  for (const p of parts) {
    const s = dayStats(res.tasks, p.scheduledDate, TIGHT, settings).blocks.focus;
    assert.ok(s.over < 0.001);
    assert.ok(taskPlannedSec(p, settings) >= 20 * 60 - 1, 'never shorter than 20 minutes');
  }
  assert.deepEqual(lectureStats(res.tasks), { total: 1, done: 0, open: 1, scheduled: 1, unscheduled: 0, asleep: 0 });
  assert.equal(res.meta.splitLectures, 1);
});

test('4b. regenerating merges automatic splits back first, so sessions never multiply', () => {
  const settings = { ...settingsNoOverhead, studyHours: 1 };
  const a = generatePlan([lecture('LONG', 150)], TIGHT, settings);
  const b = generatePlan(a.tasks, TIGHT, settings);
  const c = generatePlan(b.tasks, TIGHT, settings);
  const ids = (r) => r.tasks.filter((t) => t.parentId === 'LONG').map((t) => `${t.id}@${t.scheduledDate}`);
  assert.deepEqual(ids(b), ids(a));
  assert.deepEqual(ids(c), ids(a));
  // with capacity restored the lecture is whole again
  const whole = generatePlan(c.tasks, TIGHT, settingsNoOverhead);
  assert.equal(whole.tasks.filter((t) => t.id.startsWith('LONG')).length, 1);
  assert.equal(whole.tasks.find((t) => t.id === 'LONG').durationSec, 150 * 60);
  assert.equal(whole.tasks.find((t) => t.id === 'LONG').parentId, undefined);
});

test('4c. a part that is already done keeps its slot when the plan is rebuilt', () => {
  const settings = { ...settingsNoOverhead, studyHours: 1 };
  const a = generatePlan([lecture('LONG', 150)], TIGHT, settings);
  const first = a.tasks.find((t) => t.id === 'LONG');
  first.done = true;
  const b = generatePlan(a.tasks, TIGHT, settings);
  const parts = b.tasks.filter((t) => t.parentId === 'LONG');
  assert.equal(parts.length, a.tasks.filter((t) => t.parentId === 'LONG').length);
  const f = parts.find((p) => p.id === 'LONG');
  assert.equal(f.done, true);
  assert.equal(f.scheduledDate, first.scheduledDate);
  assert.equal(lectureStats(b.tasks).done, 0, 'lecture is not done until every part is');
  parts.forEach((p) => { p.done = true; });
  assert.equal(lectureStats(parts).done, 1);
});

test('4d. manual split places the extra sessions in the same block on later days', () => {
  const st = planned();
  const t = st.tasks.find((x) => x.type === 'video' && x.scheduledDate === '2026-10-14');
  const before = st.tasks.length;
  const original = t.durationSec;
  const r = splitInState(st, t.id, 3);
  assert.ok(r.ok);
  assert.equal(st.tasks.length, before + 2);
  const parts = st.tasks.filter((x) => x.parentId === t.id);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => blockOf(p) === 'focus' && p.scheduledDate >= '2026-10-14'));
  assert.equal(parts.reduce((s, p) => s + p.durationSec, 0), original, 'runtime preserved');
  const days = parts.map((p) => p.scheduledDate);
  assert.equal(days[0], '2026-10-14');
  assert.ok(days[1] > days[0] && days[2] > days[1]);
  assert.equal(r.unplaced.length, 0);
  assert.equal(lectureStats(st.tasks).total, 377, 'still 377 lectures');
  // guard rails
  assert.match(splitInState(st, t.id, 1).error, /2 and 8/);
  assert.match(splitInState(st, 'LIGHT-RECALL-2026-10-14', 2).error, /cannot be split/);
});

test('5. completing a task is reflected in the day, week and lecture totals without double counting', () => {
  const st = planned();
  const day = dayStats(st.tasks, '2026-10-14', st.planConfig, st.settings);
  const t = day.blocks.focus.tasks.find((x) => x.type === 'video');
  const l = day.blocks.light.tasks[0];
  const weekBefore = weeklyLoad(st.tasks, st.settings).find((w) => w.week === '2026-10-12');
  t.done = true;
  const after = dayStats(st.tasks, '2026-10-14', st.planConfig, st.settings);
  assert.ok(Math.abs(after.blocks.focus.done - taskPlannedSec(t, st.settings) / 3600) < 1e-9);
  assert.equal(after.blocks.light.done, 0, 'light block unaffected');
  assert.equal(after.planned, day.planned, 'planned total unchanged');
  l.done = true;
  const both = dayStats(st.tasks, '2026-10-14', st.planConfig, st.settings);
  assert.ok(Math.abs(both.done - (after.blocks.focus.done + taskPlannedSec(l, st.settings) / 3600)) < 1e-9);
  assert.equal(both.pct, Math.round((both.done / both.planned) * 100));
  const weekAfter = weeklyLoad(st.tasks, st.settings).find((w) => w.week === '2026-10-12');
  assert.equal(weekAfter.done, weekBefore.done + 2);
  assert.equal(weekAfter.hours, weekBefore.hours, 'completing never changes planned hours');
  assert.equal(lectureStats(st.tasks).done, 1);
});

test('6. moving a task to another date/block does not duplicate it and updates both days', () => {
  const st = planned();
  const t = dayStats(st.tasks, '2026-10-14', st.planConfig, st.settings).blocks.focus.tasks.find((x) => x.type === 'video');
  const n = st.tasks.length;
  const r = assignTask(st, t.id, '2026-10-24', 'focus');
  assert.ok(r.ok);
  assert.equal(st.tasks.length, n);
  assert.equal(st.tasks.filter((x) => x.id === t.id).length, 1);
  assert.equal(t.scheduledDate, '2026-10-24');
  assert.equal(t.pinned, true);
  assert.ok(!dayStats(st.tasks, '2026-10-14', st.planConfig, st.settings).blocks.focus.tasks.includes(t));
  const dst = dayStats(st.tasks, '2026-10-24', st.planConfig, st.settings).blocks.focus;
  assert.equal(dst.tasks.at(-1), t, 'appended at the end of the block');
  // unscheduling puts it in the backlog exactly once
  unscheduleTask(st, t.id);
  unscheduleTask(st, t.id);
  assert.equal(st.backlog.filter((b) => b.taskId === t.id).length, 1);
  assert.equal(t.scheduledDate, null);
  assert.equal(t.block, null);
  assert.match(assignTask(st, 'nope', '2026-10-24', 'focus').error, /not found/);
  assert.match(assignTask(st, t.id, 'garbage', 'focus').error, /valid date/);
});

test('7. regenerating preserves completed work, pinned moves and creates no duplicates', () => {
  const st = planned();
  const lectures = st.tasks.filter((t) => t.type === 'video' && t.scheduledDate).slice(0, 6);
  lectures.slice(0, 3).forEach((t) => { t.done = true; });
  const gen = st.tasks.find((t) => t.id === 'LIGHT-RECALL-2026-10-15');
  gen.done = true;
  assignTask(st, lectures[4].id, '2026-10-25', 'focus');
  const snapshot = Object.fromEntries(lectures.slice(0, 3).map((t) => [t.id, [t.scheduledDate, blockOf(t), t.done]]));
  const res = generatePlan(st.tasks, st.planConfig, st.settings);
  const ids = res.tasks.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
  for (const [id, [date, block, done]] of Object.entries(snapshot)) {
    const t = res.tasks.find((x) => x.id === id);
    assert.deepEqual([t.scheduledDate, blockOf(t), t.done], [date, block, done]);
  }
  assert.equal(res.tasks.find((t) => t.id === gen.id).done, true, 'completed generated task stays completed');
  const pinned = res.tasks.find((t) => t.id === lectures[4].id);
  assert.equal(pinned.scheduledDate, '2026-10-25');
  assert.equal(new Set(res.tasks.filter((t) => t.type === 'video').map(lectureKey)).size, 377, 'every lecture exactly once (split sessions share a key)');
  const again = generatePlan(res.tasks, st.planConfig, st.settings);
  assert.deepEqual(again.tasks.map((t) => [t.id, t.scheduledDate, t.block]).sort(), res.tasks.map((t) => [t.id, t.scheduledDate, t.block]).sort());
});

test('8. DAMS weekend: no focused work, a short light recap only, no lectures scheduled', () => {
  const st = planned();
  for (const iso of ['2026-11-14', '2026-11-15']) {
    const cap = dayBlocks(fromISO(iso), st.planConfig, st.settings);
    assert.equal(cap.kind, 'dams');
    assert.equal(cap.focus, 0);
    assert.equal(cap.light, 0.5);
    const d = dayStats(st.tasks, iso, st.planConfig, st.settings);
    assert.equal(d.blocks.focus.tasks.length, 0);
    assert.ok(d.blocks.light.tasks.every((t) => t.generated));
    assert.equal(d.blocks.light.over, 0);
    assert.ok(d.blocks.light.tasks.some((t) => t.id.startsWith('DAMS-')));
  }
  // a free weekend before DAMS uses the weekend capacities instead of the weekday ones
  const free = dayBlocks(fromISO('2026-10-17'), st.planConfig, st.settings);
  assert.deepEqual([free.light, free.focus, free.kind], [2, 4, 'weekend']);
});

test('9. protected trip dates have no capacity and nothing is scheduled on them', () => {
  const st = planned();
  for (const iso of ['2026-12-01', '2026-12-08', '2026-12-15']) {
    const cap = dayBlocks(fromISO(iso), st.planConfig, st.settings);
    assert.deepEqual([cap.light, cap.focus, cap.kind], [0, 0, 'trip']);
    assert.equal(st.tasks.filter((t) => t.scheduledDate === iso).length, 0);
  }
  // manual placement onto a trip day is possible (with a warning in the UI) and shows as over capacity
  const t = st.tasks.find((x) => x.type === 'video' && x.scheduledDate);
  assignTask(st, t.id, '2026-12-05', 'focus');
  const s = dayStats(st.tasks, '2026-12-05', st.planConfig, st.settings);
  assert.equal(s.kind, 'trip');
  assert.ok(s.blocks.focus.over > 0);
});

test('10. insufficient capacity: overload is visible and "fix overflow" moves open work, never fixed blocks', () => {
  const st = planned();
  const lecturesOn = dayStats(st.tasks, '2026-10-20', st.planConfig, st.settings).blocks.focus.tasks.filter((t) => t.type === 'video');
  assert.ok(lecturesOn.length >= 2);
  setDayException(st, '2026-10-20', { focus: 1 }); // a very busy evening: this already moves the overflow away
  let s = dayStats(st.tasks, '2026-10-20', st.planConfig, st.settings).blocks.focus;
  assert.ok(s.over < 0.001);
  assert.ok(s.planned <= 1 + 1e-6);
  const moved = lecturesOn.filter((t) => t.scheduledDate !== '2026-10-20');
  assert.ok(moved.length >= 1);
  assert.ok(moved.every((t) => t.scheduledDate > '2026-10-20' && blockOf(t) === 'focus'));
  // forced overload then fix
  const extra = st.tasks.find((x) => x.type === 'video' && x.scheduledDate === '2026-10-27');
  assignTask(st, extra.id, '2026-10-20', 'focus');
  s = dayStats(st.tasks, '2026-10-20', st.planConfig, st.settings).blocks.focus;
  assert.ok(s.over > 0.001, 'overload is detected');
  const fix = fixOverflow(st, '2026-10-20', 'focus');
  assert.ok(fix.moved.length >= 1);
  assert.ok(dayStats(st.tasks, '2026-10-20', st.planConfig, st.settings).blocks.focus.over < 0.001);
  // an overload caused only by fixed planning blocks cannot be "fixed" by moving them
  const st2 = planned();
  setDayException(st2, '2026-10-18', { light: 0.25 });
  const f2 = fixOverflow(st2, '2026-10-18', 'light');
  assert.equal(f2.moved.length, 0);
  assert.equal(f2.stillOver, true);
});

test('10b. marking a day unavailable reschedules its open tasks into the same block on the next free slots', () => {
  const st = planned();
  const before = dayStats(st.tasks, '2026-10-21', st.planConfig, st.settings);
  const lectures = before.blocks.focus.tasks.filter((t) => t.type === 'video');
  const n = lectures.length;
  assert.ok(n >= 1);
  const res = setDayException(st, '2026-10-21', { unavailable: true, note: 'Holiday' });
  assert.equal(res.moved.length, n);
  const d = dayStats(st.tasks, '2026-10-21', st.planConfig, st.settings);
  assert.equal(d.kind, 'off');
  assert.equal(d.blocks.focus.tasks.length + d.blocks.light.tasks.length, 0);
  assert.ok(lectures.every((t) => t.scheduledDate > '2026-10-21' && blockOf(t) === 'focus' && t.pinned));
  assert.ok(res.dropped > 0, 'generated light prep for that day was dropped');
  assert.equal(new Set(st.tasks.map((t) => t.id)).size, st.tasks.length);
  // regeneration respects the exception and keeps it empty
  const regen = generatePlan(st.tasks, st.planConfig, st.settings);
  assert.equal(regen.tasks.filter((t) => t.scheduledDate === '2026-10-21').length, 0);
  // restoring the normal rules
  setDayException(st, '2026-10-21', null);
  assert.equal(dayBlocks(fromISO('2026-10-21'), st.planConfig, st.settings).kind, 'weekday');
});

test('autoPlaceTask finds the next free slot in the right block, respects pins and reports beyond-backstop', () => {
  const st = planned();
  const back = st.backlog[0];
  assert.ok(back, 'default plan leaves 2 lectures over');
  const r = autoPlaceTask(st, back.taskId, { from: '2026-10-12' });
  assert.ok(r.ok);
  assert.equal(r.block, 'focus');
  assert.equal(r.beyondBackstop, true, 'only slots after the hard backstop are left');
  assert.ok(r.iso > '2027-01-07');
  const t = st.tasks.find((x) => x.id === back.taskId);
  assert.equal(t.pinned, true);
  assert.equal(st.backlog.some((b) => b.taskId === back.taskId), false);
  const u = usageMap(st.tasks, st.settings)[r.iso].focus;
  assert.ok(u <= dayBlocks(fromISO(r.iso), st.planConfig, st.settings).focus + 1e-6);
});

test('focused work has clock times from 6:30 PM with breaks and flags anything past the wind-down time', () => {
  const st = planned();
  const f = dayStats(st.tasks, '2026-10-14', st.planConfig, st.settings).blocks.focus;
  assert.equal(fmtClock(f.clock[0].start), '6:30 PM');
  assert.equal(f.clock[1].start - f.clock[0].end, 10, 'ten-minute break between tasks');
  assert.ok(f.clock.every((c) => c.end <= 22 * 60 + 15), 'finishes by 10:15 PM');
  assert.equal(f.pastBedtime, false);
  assert.equal(dayStats(st.tasks, '2026-10-14', st.planConfig, st.settings).blocks.light.clock, null, 'light work has no clock times');
  // late start pushes the end past bedtime and the capacity shrinks to what fits
  const late = { ...st.settings, focusStart: '20:30' };
  assert.ok(dayBlocks(fromISO('2026-10-14'), st.planConfig, late).focus < 1.5);
  assert.ok(dayStats(st.tasks, '2026-10-14', st.planConfig, late).blocks.focus.pastBedtime || dayStats(st.tasks, '2026-10-14', st.planConfig, late).blocks.focus.over > 0);
  assert.equal(validateSettingsTimes({ ...S, bedtime: '25:00' }).field, 'bedtime');
  assert.equal(validateSettingsTimes({ ...S, focusStart: '23:00' }).field, 'focusStart');
  assert.equal(validateSettingsTimes(S), null);
});

test('capacities are independent: changing one block never changes the other', () => {
  const st = planned();
  const a = dayBlocks(fromISO('2026-10-14'), st.planConfig, { ...st.settings, collegeHours: 0.5 });
  const b = dayBlocks(fromISO('2026-10-14'), st.planConfig, { ...st.settings, studyHours: 1 });
  assert.deepEqual([a.light, a.focus], [0.5, 2.5]);
  assert.deepEqual([b.light, b.focus], [1.5, 1]);
});

test('prerequisites, priority and deadlines influence placement', () => {
  const tasks = [
    lecture('B', 60, { prereqs: ['A'] }),
    lecture('A', 60),
    lecture('Z', 60, { priority: 3 }),
    lecture('Y', 60, { deadline: '2026-10-13' }),
  ];
  const res = generatePlan(tasks, C, settingsNoOverhead);
  const at = (id) => res.tasks.find((t) => t.id === id);
  assert.ok(at('A').scheduledDate <= at('B').scheduledDate, 'prerequisite is not scheduled after its dependant');
  const order = ['Z', 'Y', 'A', 'B'].map((id) => `${at(id).scheduledDate}-${String(at(id).seq).padStart(2, '0')}`);
  assert.deepEqual(order, [...order].sort(), 'high priority first, then earliest deadline');
  const late = generatePlan([lecture('L', 60, { deadline: '2026-10-01' })], C, settingsNoOverhead);
  assert.equal(late.meta.lateCount, 1);
});

test('light-intensity tasks go to light work; user light tasks are placed before generated prep', () => {
  const tasks = [lecture('M1', 30, { intensity: 'light', type: 'custom', title: 'My MCQs' }), lecture('D1', 60)];
  const res = generatePlan(tasks, C, settingsNoOverhead);
  const m = res.tasks.find((t) => t.id === 'M1');
  assert.equal(blockOf(m), 'light');
  assert.equal(m.scheduledDate, '2026-10-12');
  assert.equal(blockOf(res.tasks.find((t) => t.id === 'D1')), 'focus');
  const d = dayStats(res.tasks, '2026-10-12', C, settingsNoOverhead);
  assert.ok(d.blocks.light.tasks.includes(m));
  assert.ok(d.blocks.light.over === 0);
});

test('existing data is preserved: ids, durations, statuses and completion survive a rebuild', () => {
  const st = freshState();
  st.tasks[0].done = true;
  st.tasks[0].scheduledDate = '2026-10-12';
  // Fast playback so the whole library fits and nothing gets auto-split (an auto-split lecture is reported as sessions).
  const res = generatePlan(st.tasks, st.planConfig, { ...st.settings, speed: 2, studyHours: 3 });
  assert.equal(res.backlog.length, 0);
  for (const orig of INITIAL_TASKS) {
    const t = res.tasks.find((x) => x.id === orig.id);
    assert.ok(t, `${orig.id} still present`);
    assert.equal(t.durationSec, orig.durationSec);
    assert.equal(t.status, orig.status);
    assert.equal(t.title, orig.title);
  }
  assert.equal(res.tasks.find((t) => t.id === INITIAL_TASKS[0].id).done, true);
  assert.equal(res.tasks.filter((t) => t.status === 'estimated_missing').length, 8, 'missing durations stay flagged estimates');
  assert.ok(res.tasks.filter((t) => t.status === 'estimated_missing').every((t) => t.durationSec === 1200));
});

test('migration: v1 saved data (one weekend capacity, no blocks) becomes v2 with the same total and all progress', () => {
  const v1 = {
    tasks: INITIAL_TASKS.map((t, i) => ({ ...t, scheduledDate: i < 5 ? '2026-10-13' : null, done: i === 0 })),
    settings: { speed: 1.25, annotation: 20, recall: 5, weeklyBuffer: 6, studyHours: 3, collegeHours: 1 },
    planConfig: { start: '2026-10-12', end: '2026-12-31', backstop: '2027-01-07', tripStart: '2026-12-01', tripEnd: '2026-12-15', weekendCap: 6 },
    backlog: [],
  };
  const out = sanitizeState(v1);
  assert.equal(out.version, 1, 'flagged for migration');
  assert.equal(out.settings.studyHours, 3);
  assert.equal(out.settings.collegeHours, 1);
  assert.equal(out.settings.speed, 1.25);
  assert.equal(out.settings.focusStart, '18:30');
  assert.equal(out.settings.bedtime, '22:30');
  assert.equal(out.planConfig.weekendLight + out.planConfig.weekendFocus, 6);
  assert.deepEqual([out.planConfig.weekendLight, out.planConfig.weekendFocus], [2, 4]);
  assert.deepEqual(out.planConfig.exceptions, {});
  assert.equal(out.tasks.length, 377);
  assert.equal(out.tasks[0].done, true);
  assert.equal(out.tasks[1].scheduledDate, '2026-10-13');
  const migrated = generatePlan(out.tasks, out.planConfig, out.settings);
  assert.equal(migrated.tasks.find((t) => t.id === INITIAL_TASKS[0].id).done, true);
  assert.equal(sanitizeState({ ...JSON.parse(JSON.stringify(freshState())) }).version, 2);
});

test('sanitizeState keeps valid day exceptions and drops junk', () => {
  const st = freshState();
  const raw = JSON.parse(JSON.stringify(st));
  raw.planConfig.exceptions = {
    '2026-10-20': { unavailable: true, note: 'x'.repeat(500) },
    '2026-10-21': { light: 0.5, focus: 'abc' },
    '2026-02-31': { unavailable: true },
    '2026-10-22': 'nope',
    '2026-10-23': {},
  };
  raw.settings.focusStart = '25:99';
  raw.tasks[3].block = 'sideways';
  raw.tasks[3].intensity = 'extreme';
  const out = sanitizeState(raw);
  assert.deepEqual(Object.keys(out.planConfig.exceptions), ['2026-10-20', '2026-10-21']);
  assert.equal(out.planConfig.exceptions['2026-10-20'].note.length, 120);
  assert.deepEqual(out.planConfig.exceptions['2026-10-21'], { light: 0.5 });
  assert.equal(out.settings.focusStart, '18:30');
  assert.equal(out.tasks[3].block, null);
  assert.equal(out.tasks[3].intensity, undefined);
});
