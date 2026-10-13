import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_EXPORT_DAYS, PLANNER_CSV_HEADER, plannerCSV, plannerRows } from '../../js/exportPlan.js';
import { generatePlan } from '../../js/planner.js';
import { freshState } from '../../js/store.js';
import { assignTask } from '../../js/taskOps.js';
import { parseCSV } from '../../js/utils.js';

const planned = () => {
  const st = freshState();
  const r = generatePlan(st.tasks, st.planConfig, st.settings);
  st.tasks = r.tasks; st.backlog = r.backlog;
  return st;
};
const rowsOf = (st, a, b) => parseCSV(plannerCSV(st, a, b).csv);

test('every day in the span appears, each with a light and a focused block', () => {
  const rows = rowsOf(planned(), '2026-10-12', '2026-10-18');
  assert.equal(new Set(rows.map((r) => r.Date)).size, 7);
  for (const d of new Set(rows.map((r) => r.Date))) {
    assert.deepEqual([...new Set(rows.filter((r) => r.Date === d).map((r) => r.Block))].sort(), ['Focused work', 'Light work']);
  }
  assert.deepEqual(Object.keys(rows[0]), PLANNER_CSV_HEADER);
});

test('tasks sit in the right block with order, clock times for focused work and study minutes', () => {
  const rows = rowsOf(planned(), '2026-10-14', '2026-10-14');
  const light = rows.filter((r) => r.Block === 'Light work');
  const focus = rows.filter((r) => r.Block === 'Focused work');
  assert.ok(light.length >= 3 && focus.length >= 2);
  assert.ok(light.every((r) => r.Start === '' && r['Work type'] === 'Light'));
  assert.equal(focus[0].Start, '6:30 PM');
  assert.deepEqual(focus.map((r) => r.Order), focus.map((_, i) => String(i + 1)));
  assert.ok(focus.every((r) => Number(r['Study time (min)']) > 0 && r.Status === 'To do'));
  assert.equal(light[0]['Block capacity (h)'], '1.50');
  assert.equal(focus[0]['Block capacity (h)'], '2.50');
});

test('empty, DAMS and trip days are still listed with an explanation', () => {
  const st = planned();
  const trip = rowsOf(st, '2026-12-05', '2026-12-05');
  assert.equal(trip.length, 2);
  assert.ok(trip.every((r) => r['Day type'] === 'Trip (protected)' && r.Task === '' && /Trip/.test(r.Notes)));
  const dams = rowsOf(st, '2026-11-14', '2026-11-14');
  assert.ok(dams.every((r) => r['Day type'] === 'DAMS class day'));
  assert.equal(dams.find((r) => r.Block === 'Focused work').Task, '');
  assert.match(dams.find((r) => r.Block === 'Light work').Task, /DAMS/);
});

test('done, split parts, overrides and overloads are reflected', () => {
  const st = planned();
  const lec = st.tasks.find((t) => t.type === 'video' && t.scheduledDate === '2026-10-14');
  lec.done = true;
  const t2 = st.tasks.find((t) => t.type === 'video' && t.scheduledDate === '2026-10-20');
  assignTask(st, t2.id, '2026-10-14', 'light', { override: true });
  const rows = rowsOf(st, '2026-10-14', '2026-10-14');
  assert.equal(rows.find((r) => r.Task === lec.title).Status, 'Done');
  const o = rows.find((r) => r.Task === t2.title);
  assert.equal(o.Block, 'Light work');
  assert.match(o.Notes, /override/);
  assert.ok(rows.some((r) => /over capacity/.test(r.Notes)));
});

test('span validation', () => {
  const st = planned();
  assert.match(plannerCSV(st, '', '2026-10-18').error, /valid/);
  assert.match(plannerCSV(st, '2026-10-18', '2026-10-12').error, /on or after/);
  assert.match(plannerCSV(st, '2026-01-01', '2029-01-01').error, new RegExp(String(MAX_EXPORT_DAYS)));
  assert.equal(plannerRows(st, '2026-10-12', '2026-10-12').rows.length > 1, true);
});

test('the whole plan exports and text with commas, quotes and formulas is escaped safely', () => {
  const st = planned();
  st.tasks.find((t) => t.type === 'video' && t.scheduledDate === '2026-10-14').title = '=SUM(A1), "quoted"';
  const r = plannerCSV(st, '2026-10-12', '2027-01-07');
  assert.ok(r.rowCount >= 88 * 2);
  const rows = parseCSV(r.csv);
  assert.equal(new Set(rows.map((x) => x.Date)).size, 88);
  assert.ok(rows.some((x) => x.Task === "'=SUM(A1), \"quoted\""));
});
