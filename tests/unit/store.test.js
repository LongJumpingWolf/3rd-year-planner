import test from 'node:test';
import assert from 'node:assert/strict';
import { freshState, newId, sanitizeState } from '../../js/store.js';
import { tasksFromCSV } from '../../js/actions.js';
import { toCSV } from '../../js/utils.js';

test('freshState has the full library and defaults', () => {
  const s = freshState();
  assert.equal(s.tasks.length, 377);
  assert.equal(s.settings.annotation, 25);
  assert.equal(s.planConfig.start, '2026-10-12');
  assert.equal(s.version, 2);
});

test('sanitizeState round-trips a real state', () => {
  const s = freshState();
  s.tasks[0].done = true;
  s.tasks[1].scheduledDate = '2026-10-13';
  const out = sanitizeState(JSON.parse(JSON.stringify(s)));
  assert.equal(out.tasks.length, 377);
  assert.equal(out.tasks[0].done, true);
  assert.equal(out.tasks[1].scheduledDate, '2026-10-13');
});

test('sanitizeState rejects things that are not backups', () => {
  for (const bad of [null, undefined, 5, 'x', [], {}, { tasks: 'no' }, { tasks: [] }, { tasks: [null, 3, {}] }]) {
    assert.equal(sanitizeState(bad), null, JSON.stringify(bad));
  }
});

test('sanitizeState repairs partial / old backups (v1 files without planConfig)', () => {
  const out = sanitizeState({
    tasks: [
      { id: 'A', title: 'One', durationSec: 600, scheduledDate: '2026-02-31' },
      { id: 'A', title: 'Duplicate id', durationSec: 600 },
      { id: 'B', title: '', durationSec: 600 },
      { id: 'C', title: 'Negative', durationSec: -5 },
      { id: 'D', title: 'Two', durationSec: 900, done: 1, selected: true },
    ],
    settings: { annotation: 'oops', speed: 1.5 },
    backlog: [{ taskId: 'D' }, { taskId: 'GONE' }, null],
  });
  assert.deepEqual(out.tasks.map((t) => t.id), ['A', 'D']);
  assert.equal(out.tasks[0].scheduledDate, null);
  assert.equal(out.tasks[1].done, true);
  assert.equal(out.tasks[1].selected, false);
  assert.equal(out.settings.annotation, 25);
  assert.equal(out.settings.speed, 1.5);
  assert.equal(out.planConfig.backstop, '2027-01-07');
  assert.deepEqual(out.backlog.map((b) => b.taskId), ['D']);
});

test('newId is unique', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newId()));
  assert.equal(ids.size, 500);
});

test('tasksFromCSV: valid rows, defaults, duplicates and skipped rows', () => {
  const csv = toCSV([
    ['id', 'subject', 'category', 'title', 'durationSec'],
    ['FMT-01', 'FMT', 'Toxicology', 'Poisoning basics', '1800'],
    ['PSM-01', 'PSM', 'PSM', 'Clashes with existing id', '600'],
    ['', 'ENT', 'Ear', 'No duration given', ''],
    ['', 'ENT', 'Ear', '', '900'],
  ]);
  const { rows, skipped } = tasksFromCSV(csv, ['PSM-01']);
  assert.equal(rows.length, 3);
  assert.equal(skipped, 1);
  assert.equal(rows[0].id, 'FMT-01');
  assert.equal(rows[0].durationSec, 1800);
  assert.equal(rows[1].id, 'PSM-01-IMPORTED');
  assert.equal(rows[2].durationSec, 1200);
  assert.equal(rows[2].status, 'estimated_missing');
  assert.equal(new Set(rows.map((r) => r.id)).size, 3);
});

test('tasksFromCSV: errors for missing title column or empty file', () => {
  assert.match(tasksFromCSV('subject,durationSec\nPSM,60', []).error, /title/);
  assert.match(tasksFromCSV('', []).error, /no data/);
  assert.match(tasksFromCSV('title\n', []).error, /no data/);
});

test('tasksFromCSV is case-insensitive about headers and ignores junk durations', () => {
  const { rows } = tasksFromCSV('Title,DurationSec\nHello,abc\nWorld,45', []);
  assert.equal(rows[0].durationSec, 1200);
  assert.equal(rows[1].durationSec, 45);
});

test('library: ENT and FMT ship as full lecture lists (verified ENT total, ordered ids, a category each)', async () => {
  const { INITIAL_TASKS } = await import('../../js/data.js');
  const ent = INITIAL_TASKS.filter((t) => t.subject === 'ENT');
  const fmt = INITIAL_TASKS.filter((t) => t.subject === 'FMT');
  assert.equal(ent.length, 65);
  assert.equal(fmt.length, 44);
  assert.equal(ent.reduce((s, t) => s + t.durationSec, 0), 47 * 3600 + 23 * 60, 'ENT adds up to the recorded 47h 23m');
  assert.deepEqual(ent.map((t) => t.id), Array.from({ length: 65 }, (_, i) => `ENT-${String(i + 1).padStart(2, '0')}`));
  assert.ok([...ent, ...fmt].every((t) => t.type === 'video' && t.category && t.durationSec > 0));
});

test('old saved data with the ENT/FMT placeholders gets the real lectures, flagged for one plan rebuild', () => {
  const old = JSON.parse(JSON.stringify(freshState()));
  old.tasks = old.tasks.filter((t) => t.subject !== 'ENT' && t.subject !== 'FMT');
  old.tasks.push({ id: 'ENT-DATA', subject: 'ENT', category: 'Data status', title: 'placeholder', durationSec: 100, type: 'dataset_placeholder' });
  old.tasks.push({ id: 'FMT-DATA', subject: 'FMT', category: 'Data status', title: 'placeholder', durationSec: 100, type: 'dataset_placeholder' });
  old.tasks.find((t) => t.id === 'PSM-01').done = true;
  const out = sanitizeState(old);
  assert.equal(out.tasks.length, 377);
  assert.ok(!out.tasks.some((t) => t.type === 'dataset_placeholder'));
  assert.equal(out.tasks.filter((t) => t.fresh).length, 109);
  assert.equal(out.tasks.find((t) => t.id === 'PSM-01').done, true, 'existing progress is untouched');
  assert.ok(!out.tasks.find((t) => t.id === 'PSM-01').fresh);
});

test('placeholder is left alone when the saved data already has its own lectures for that subject', () => {
  const old = JSON.parse(JSON.stringify(freshState()));
  old.tasks = old.tasks.filter((t) => t.subject !== 'ENT');
  old.tasks.push({ id: 'ENT-DATA', subject: 'ENT', category: 'Data status', title: 'placeholder', durationSec: 100, type: 'dataset_placeholder' });
  old.tasks.push({ id: 'MY-ENT-1', subject: 'ENT', category: 'Ear', title: 'My own import', durationSec: 600, type: 'video' });
  const out = sanitizeState(old);
  assert.equal(out.tasks.filter((t) => t.subject === 'ENT').length, 2, 'no duplicates added');
  assert.ok(out.tasks.some((t) => t.id === 'ENT-DATA'));
});
