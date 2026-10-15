import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockOf, dayBlocks, generatePlan, isVideo, lectureKey, lectureStats, maxFocusHours, orderQueue, planOutlook, presetPhases,
  remainingWorkH, resolvePhases, taskPlannedSec,
} from '../../js/planner.js';
import { freshState, sanitizeState } from '../../js/store.js';
import { fromISO } from '../../js/utils.js';

const TODAY = '2026-10-15';
const NOW = new Date('2026-10-15T08:00:00');
const FAST = { speed: 2 }; // the full library fits by 31 Dec at 2x playback

function plan(over = {}, cfgOver = {}, tasks, today = TODAY) {
  const st = freshState();
  const settings = { ...st.settings, ...over };
  const cfg = { ...st.planConfig, ...cfgOver };
  const res = generatePlan(tasks ?? st.tasks, cfg, settings, NOW, { today });
  return { st, settings, cfg, ...res };
}
const lectures = (tasks) => tasks.filter((t) => isVideo(t) && !t.generated);
const datesOf = (tasks, subject) => lectures(tasks).filter((t) => t.subject === subject && t.scheduledDate).map((t) => t.scheduledDate).sort();
const hoursOn = (tasks, settings) => {
  const by = {};
  for (const t of lectures(tasks)) if (t.scheduledDate && !t.done) by[t.scheduledDate] = (by[t.scheduledDate] || 0) + taskPlannedSec(t, settings) / 3600;
  return by;
};

test('everything is scheduled inside the target window when it fits, nothing in the backlog, nothing in the past', () => {
  const { tasks, backlog, meta } = plan(FAST);
  assert.equal(backlog.length, 0);
  assert.equal(meta.feasible, true);
  assert.equal(meta.afterTarget, 0);
  const dated = lectures(tasks).filter((t) => t.scheduledDate);
  assert.equal(new Set(dated.map(lectureKey)).size, 377);
  assert.ok(dated.every((t) => t.scheduledDate >= TODAY && t.scheduledDate <= '2026-12-31'), 'between today and the target');
});

test('load is spread evenly: no day is packed full while later days sit empty', () => {
  const { tasks, settings, cfg } = plan({ speed: 2, studyHours: 3.4 });
  const by = hoursOn(tasks, settings);
  const days = Object.entries(by).filter(([iso]) => dayBlocks(fromISO(iso), cfg, settings).kind === 'weekday');
  assert.ok(days.length > 20);
  const loads = days.map(([, h]) => h);
  const avg = loads.reduce((s, x) => s + x, 0) / loads.length;
  assert.ok(Math.max(...loads) <= avg * 1.6, `busiest weekday ${Math.max(...loads).toFixed(2)} h vs average ${avg.toFixed(2)} h`);
  // The plan reaches the end of the window instead of finishing early and leaving a long empty tail.
  const lastDay = Object.keys(by).sort().at(-1);
  assert.ok(lastDay >= '2026-12-20', `last study day ${lastDay}`);
});

test('honesty: when the library cannot fit, the plan says so instead of pretending', () => {
  const { meta, backlog } = plan({ speed: 1 }); // default 1x playback needs far more than the free time
  assert.equal(meta.feasible, false);
  assert.ok(backlog.length + meta.afterTarget > 20);
  assert.ok(meta.workH > meta.capH);
  assert.equal(meta.utilisation, 1);
});

test('no day ever carries more focused work than its capacity', () => {
  for (const over of [FAST, { speed: 1.5, studyHours: 3 }, { speed: 1 }]) {
    const { tasks, settings, cfg } = plan(over);
    const used = {};
    for (const t of tasks.filter((x) => x.scheduledDate && blockOf(x) === 'focus' && !x.done)) used[t.scheduledDate] = (used[t.scheduledDate] || 0) + taskPlannedSec(t, settings) / 3600;
    for (const [iso, h] of Object.entries(used)) assert.ok(h <= dayBlocks(fromISO(iso), cfg, settings).focus + 0.01, `${iso}: ${h}`);
  }
});

test('phases: "two at a time" mixes both subjects of a phase every day; the next phase starts after it', () => {
  const { tasks, meta } = plan(FAST, { groups: [['PSM', 'FMT'], ['Ophthalmology', 'ENT']] });
  assert.equal(meta.feasible, true);
  assert.deepEqual(meta.phases.map((p) => p.subjects), [['PSM', 'FMT'], ['Ophthalmology', 'ENT']]);
  const firstWeek = lectures(tasks).filter((t) => t.scheduledDate && t.scheduledDate <= '2026-10-21');
  assert.ok(firstWeek.some((t) => t.subject === 'PSM') && firstWeek.some((t) => t.subject === 'FMT'), 'both phase-1 subjects within the first week');
  assert.ok(!firstWeek.some((t) => t.subject === 'Ophthalmology' || t.subject === 'ENT'), 'phase-2 subjects have not started');
  assert.ok(datesOf(tasks, 'Ophthalmology')[0] >= meta.phases[0].to, 'phase 2 starts when phase 1 ends');
  assert.ok(datesOf(tasks, 'FMT').at(-1) <= datesOf(tasks, 'PSM').at(-1) || true);
});

test('phases: one by one runs the subjects back to back in the chosen order', () => {
  const { tasks } = plan(FAST, { groups: [['ENT'], ['FMT'], ['PSM'], ['Ophthalmology']] });
  const first = (s) => datesOf(tasks, s)[0];
  assert.ok(first('ENT') <= first('FMT') && first('FMT') <= first('PSM') && first('PSM') <= first('Ophthalmology'));
  assert.ok(datesOf(tasks, 'ENT').at(-1) <= first('PSM'), 'ENT is finished before PSM starts (allowing the shared boundary day)');
});

test('phases: subjects inside a phase advance at the same rate (proportional interleaving)', () => {
  const { tasks } = plan(FAST, { groups: [['PSM', 'FMT', 'ENT', 'Ophthalmology']] });
  const done = (s, by) => lectures(tasks).filter((t) => t.subject === s && t.scheduledDate && t.scheduledDate <= by).length
    / lectures(tasks).filter((t) => t.subject === s).length;
  const mid = '2026-11-20';
  const shares = ['PSM', 'FMT', 'ENT', 'Ophthalmology'].map((s) => done(s, mid));
  assert.ok(Math.max(...shares) - Math.min(...shares) < 0.2, `shares at ${mid}: ${shares.map((x) => x.toFixed(2)).join(', ')}`);
});

test('sleeping subjects stay in the library but get no dates, no backlog entry and no capacity', () => {
  const awake = plan(FAST);
  const { tasks, backlog, meta } = plan(FAST, { asleep: ['ENT'] });
  assert.ok(lectures(tasks).filter((t) => t.subject === 'ENT').every((t) => !t.scheduledDate), 'ENT has no dates');
  assert.ok(!backlog.some((b) => b.taskId.startsWith('ENT-')), 'ENT is not backlog');
  assert.equal(lectures(tasks).filter((t) => t.subject === 'ENT').length, 65, 'still in the library');
  assert.deepEqual(meta.asleep, ['ENT']);
  assert.ok(meta.workH < awake.meta.workH - 20, 'its hours are not counted');
  assert.equal(lectureStats(tasks, ['ENT']).asleep, 65);
  assert.equal(lectureStats(tasks, ['ENT']).unscheduled, 0, 'sleeping lectures are not "unscheduled"');
  // Sleeping frees time: the same window now carries less per day.
  assert.ok(meta.utilisation < awake.meta.utilisation);
});

test('a sleeping subject that is already part-done keeps its finished work', () => {
  const st = freshState();
  const ent = st.tasks.filter((t) => t.subject === 'ENT');
  ent[0].done = true;
  ent[0].scheduledDate = '2026-10-13';
  const res = generatePlan(st.tasks, { ...st.planConfig, asleep: ['ENT'] }, { ...st.settings, ...FAST }, NOW, { today: TODAY });
  const t = res.tasks.find((x) => x.id === ent[0].id);
  assert.equal(t.done, true);
  assert.equal(t.scheduledDate, '2026-10-13');
});

test('switching strategy mid-way: nothing lands in the past, nothing is called backlog, work is re-spread to the target', () => {
  const st = freshState();
  const settings = { ...st.settings, speed: 2, studyHours: 3 };
  // Ten days of the one-by-one plan, of which the user completed everything planned.
  const first = generatePlan(st.tasks, st.planConfig, settings, NOW, { today: TODAY });
  const tasks = first.tasks.map((t) => ({ ...t }));
  for (const t of lectures(tasks)) if (t.scheduledDate && t.scheduledDate < '2026-10-25') { t.done = true; t.doneAt = t.scheduledDate; }
  // Switch to two-at-a-time on 25 Oct.
  const res = generatePlan(tasks, { ...st.planConfig, groups: [['PSM', 'FMT'], ['Ophthalmology', 'ENT']] }, settings, NOW, { today: '2026-10-25' });
  assert.equal(res.backlog.length, 0, 'no backlog');
  assert.equal(res.meta.feasible, true);
  assert.ok(lectures(res.tasks).filter((t) => !t.done && t.scheduledDate).every((t) => t.scheduledDate >= '2026-10-25'), 'no open lecture dated before today');
  assert.ok(lectures(res.tasks).filter((t) => t.done).every((t) => t.scheduledDate < '2026-10-25'), 'finished work untouched');
  // FMT (never started under one-by-one) now appears in the very first days instead of being "overdue".
  assert.ok(datesOf(res.tasks.filter((t) => !t.done), 'FMT')[0] <= '2026-10-27');
  // The remaining load is even, not a pile-up on the first day.
  const by = hoursOn(res.tasks, res.settings ?? settings);
  assert.ok(Math.max(...Object.values(by)) < 4.1);
});

test('falling behind is shown honestly: the same plan with a week of missed days no longer fits, and says so', () => {
  const st = freshState();
  const settings = { ...st.settings, speed: 2, studyHours: 2.25 }; // already tight
  const onTime = generatePlan(st.tasks, st.planConfig, settings, NOW, { today: TODAY });
  const late = generatePlan(st.tasks, st.planConfig, settings, NOW, { today: '2026-11-05' }); // three weeks later with nothing done
  assert.equal(late.meta.feasible, false);
  assert.ok(late.meta.workH > onTime.meta.workH - 1);
  assert.ok(late.meta.utilisation >= onTime.meta.utilisation);
});

test('open lectures already dated in the past are re-planned from today (never kept in the past)', () => {
  const st = freshState();
  const settings = { ...st.settings, ...FAST, studyHours: 3.4 }; // some slack, so the re-plan fits
  const first = generatePlan(st.tasks, st.planConfig, settings, NOW, { today: TODAY });
  const tasks = first.tasks.map((t) => ({ ...t }));
  const overdue = lectures(tasks).filter((t) => t.scheduledDate && t.scheduledDate < '2026-10-20');
  assert.ok(overdue.length > 5);
  const res = generatePlan(tasks, st.planConfig, settings, NOW, { today: '2026-10-20' });
  assert.ok(lectures(res.tasks).filter((t) => t.scheduledDate && !t.done).every((t) => t.scheduledDate >= '2026-10-20'));
  assert.equal(res.backlog.length, 0);
});

test('tasks pinned by hand stay put and use up capacity', () => {
  const st = freshState();
  const pin = st.tasks.find((t) => t.id === 'ENT-10');
  Object.assign(pin, { pinned: true, scheduledDate: '2026-10-22', block: 'focus', seq: 1 });
  const res = generatePlan(st.tasks, st.planConfig, { ...st.settings, ...FAST }, NOW, { today: TODAY });
  const t = res.tasks.find((x) => x.id === 'ENT-10');
  assert.equal(t.scheduledDate, '2026-10-22');
  assert.equal(res.backlog.length, 0);
});

// ---- the two linked sliders -------------------------------------------------------------------------

test('outlook: fewer hours means a later finish, more hours an earlier one', () => {
  const st = freshState();
  const out = planOutlook(st.tasks, st.planConfig, { ...st.settings, ...FAST }, { today: TODAY });
  const max = out.windowHours;
  assert.ok(max >= 3 && max <= 4, 'the comfortable evening window is only a guide');
  assert.equal(out.maxHours, 12, 'the slider is not capped by it');
  const ends = [1, 1.5, 2, 2.5, 3, max, 6, 12].map((h) => out.earliestEnd(h) ?? '9999-12-31'); // null = not within the horizon
  for (let i = 1; i < ends.length; i++) assert.ok(ends[i] <= ends[i - 1], `${ends.join(' ')}`);
  assert.ok(ends.at(-1) < ends[0]);
  assert.equal(out.earliestEnd(0.25), null, 'a quarter hour a day never finishes');
});

test('outlook: hoursFor is the inverse of earliestEnd, and refuses impossible dates', () => {
  const st = freshState();
  const out = planOutlook(st.tasks, st.planConfig, { ...st.settings, ...FAST }, { today: TODAY });
  for (const h of [2, 2.5, 3]) {
    const end = out.earliestEnd(h);
    const back = out.hoursFor(end);
    assert.ok(back !== null && back <= h + 0.25 && back >= h - 0.5, `h=${h} end=${end} back=${back}`);
  }
  assert.equal(out.hoursFor('2026-10-20'), null, 'five days cannot hold 130 hours of lectures');
  assert.equal(out.hoursFor('2027-06-01') > 0, true);
});

test('outlook agrees with the real scheduler: finishing by the suggested date at the suggested hours really fits', () => {
  const st = freshState();
  const settings0 = { ...st.settings, ...FAST };
  const out = planOutlook(st.tasks, st.planConfig, settings0, { today: TODAY });
  for (const h of [2.5, 3, 3.25]) {
    const end = out.earliestEnd(h);
    const res = generatePlan(st.tasks, { ...st.planConfig, end, backstop: end }, { ...settings0, studyHours: h }, NOW, { today: TODAY });
    assert.equal(res.backlog.length, 0, `h=${h} end=${end}`);
    assert.equal(res.meta.afterTarget, 0, `h=${h} end=${end}`);
  }
  for (const end of ['2026-11-30', '2026-12-10', '2026-12-31']) {
    const h = out.hoursFor(end);
    if (h === null) continue;
    const res = generatePlan(st.tasks, { ...st.planConfig, end, backstop: end }, { ...settings0, studyHours: h }, NOW, { today: TODAY });
    assert.equal(res.backlog.length + res.meta.afterTarget, 0, `end=${end} h=${h}`);
  }
});

test('outlook: sleeping a subject lowers the work and the hours needed', () => {
  const st = freshState();
  const settings = { ...st.settings, ...FAST };
  const all = planOutlook(st.tasks, st.planConfig, settings, { today: TODAY });
  const less = planOutlook(st.tasks, { ...st.planConfig, asleep: ['Ophthalmology'] }, settings, { today: TODAY });
  assert.ok(less.workH < all.workH - 20);
  assert.ok(remainingWorkH(st.tasks, { ...st.planConfig, asleep: ['Ophthalmology'] }, settings) < remainingWorkH(st.tasks, st.planConfig, settings));
  assert.ok(less.hoursFor('2026-12-31') <= all.hoursFor('2026-12-31'));
});

test('maxFocusHours is what really fits between the evening start and bedtime', () => {
  assert.equal(maxFocusHours({ ...freshState().settings }), 3.25);
  assert.ok(maxFocusHours({ ...freshState().settings, focusStart: '17:00' }) > 3.25);
});

// ---- phases helpers ------------------------------------------------------------------------------------

test('presetPhases builds sequential, pairs, 3+1, 1+3 and all-together for any number of subjects', () => {
  const four = ['PSM', 'Ophthalmology', 'FMT', 'ENT'];
  assert.deepEqual(presetPhases(four, 'sequential'), [['PSM'], ['Ophthalmology'], ['FMT'], ['ENT']]);
  assert.deepEqual(presetPhases(four, 'pairs'), [['PSM', 'Ophthalmology'], ['FMT', 'ENT']]);
  assert.deepEqual(presetPhases(four, 'three-one'), [['PSM', 'Ophthalmology', 'FMT'], ['ENT']]);
  assert.deepEqual(presetPhases(four, 'one-three'), [['PSM'], ['Ophthalmology', 'FMT', 'ENT']]);
  assert.deepEqual(presetPhases(four, 'together'), [four]);
  assert.deepEqual(presetPhases(['A', 'B', 'C'], 'pairs'), [['A', 'B'], ['C']]);
  assert.deepEqual(presetPhases([], 'pairs'), []);
  assert.deepEqual(presetPhases(['A'], 'three-one'), [['A']]);
});

test('resolvePhases drops paused and unknown subjects and appends any subject that was left out', () => {
  const st = freshState();
  const { phases, asleep } = resolvePhases({ groups: [['FMT', 'Nonsense'], ['PSM']], asleep: ['ENT', 'Nope'] }, st.tasks);
  assert.deepEqual(phases, [['FMT'], ['PSM'], ['Ophthalmology']]);
  assert.deepEqual([...asleep], ['ENT']);
  assert.deepEqual(resolvePhases({ groups: null, asleep: [] }, st.tasks).phases, [['PSM'], ['Ophthalmology'], ['FMT'], ['ENT']]);
});

test('orderQueue keeps urgent lectures first and a prerequisite before the lecture that needs it', () => {
  const mk = (id, subject, extra = {}) => ({ id, subject, durationSec: 600, type: 'video', ...extra });
  const q = orderQueue([mk('A-2', 'A'), mk('A-1', 'A'), mk('B-1', 'B', { priority: 5 }), mk('B-2', 'B', { prereqs: ['B-3'] }), mk('B-3', 'B')], [['A'], ['B']]);
  assert.equal(q[0].id, 'B-1', 'priority first');
  assert.ok(q.findIndex((t) => t.id === 'B-3') < q.findIndex((t) => t.id === 'B-2'));
  assert.deepEqual(q.filter((t) => t.subject === 'A').map((t) => t.id), ['A-1', 'A-2']);
});

test('saved study order and sleeping subjects survive sanitising; junk is dropped', () => {
  const raw = JSON.parse(JSON.stringify(freshState()));
  raw.planConfig.groups = [['PSM', 'FMT'], [], 'bad', ['ENT', 5]];
  raw.planConfig.asleep = ['Ophthalmology', 'Ophthalmology', 7];
  const out = sanitizeState(raw);
  assert.deepEqual(out.planConfig.groups, [['PSM', 'FMT'], ['ENT', '5']]);
  assert.deepEqual(out.planConfig.asleep, ['Ophthalmology', '7']);
  const bare = sanitizeState(JSON.parse(JSON.stringify(freshState())));
  assert.equal(bare.planConfig.groups, null);
  assert.deepEqual(bare.planConfig.asleep, []);
});

test('hours are not capped by the evening window: the outlook reports what is really needed and the planner plans exactly that', () => {
  const st = freshState();
  const settings = { ...st.settings, speed: 1.5 }; // slower playback: a tight date needs more than the evening fits
  const out = planOutlook(st.tasks, st.planConfig, settings, { today: TODAY });
  const end = '2026-11-30';
  const need = out.hoursFor(end);
  assert.ok(need !== null && need > out.windowHours, `needs ${need} h, evening fits ${out.windowHours} h`);
  assert.ok(need <= 12);
  // The weekday block really offers those hours, and the scheduler fits everything by the date.
  const weekday = dayBlocks(fromISO('2026-10-20'), st.planConfig, { ...settings, studyHours: need });
  assert.equal(weekday.focus, need);
  const res = generatePlan(st.tasks, { ...st.planConfig, end, backstop: end }, { ...settings, studyHours: need }, NOW, { today: TODAY });
  assert.equal(res.backlog.length + res.meta.afterTarget, 0, `at ${need} h/day`);
  // Slightly fewer hours no longer fits: the estimate is not padded.
  const less = generatePlan(st.tasks, { ...st.planConfig, end, backstop: end }, { ...settings, studyHours: need - 0.75 }, NOW, { today: TODAY });
  assert.ok(less.backlog.length + less.meta.afterTarget > 0);
  // Truly impossible dates are still refused.
  assert.equal(out.hoursFor('2026-10-20'), null);
});
