import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, csvEscape, dateISO, esc, fmtHours, fmtTime, fromISO, isValidISO, num, parseCSV, toCSV, weekStart } from '../../js/utils.js';

test('isValidISO accepts real dates only', () => {
  assert.equal(isValidISO('2026-10-12'), true);
  assert.equal(isValidISO('2028-02-29'), true);
  assert.equal(isValidISO('2026-02-29'), false);
  assert.equal(isValidISO('2026-02-31'), false);
  assert.equal(isValidISO('2026-13-01'), false);
  assert.equal(isValidISO('12/10/2026'), false);
  assert.equal(isValidISO(''), false);
  assert.equal(isValidISO(null), false);
});

test('dateISO / fromISO round-trip and addDays crosses month and year boundaries', () => {
  assert.equal(dateISO(fromISO('2026-12-31')), '2026-12-31');
  assert.equal(dateISO(addDays(fromISO('2026-12-31'), 1)), '2027-01-01');
  assert.equal(dateISO(addDays(fromISO('2027-03-01'), -1)), '2027-02-28');
});

test('weekStart returns the Monday (Sunday belongs to the previous week)', () => {
  assert.equal(dateISO(weekStart(fromISO('2026-10-12'))), '2026-10-12'); // Monday
  assert.equal(dateISO(weekStart(fromISO('2026-10-18'))), '2026-10-12'); // Sunday
  assert.equal(dateISO(weekStart(fromISO('2026-10-14'))), '2026-10-12');
});

test('fmtTime / fmtHours', () => {
  assert.equal(fmtTime(0), '0s');
  assert.equal(fmtTime(90), '1m 30s');
  assert.equal(fmtTime(3600), '1h 0m');
  assert.equal(fmtTime(-5), '0s');
  assert.equal(fmtHours(7200), '2 h');
  assert.equal(fmtHours(5400), '1.5 h');
});

test('esc neutralises HTML', () => {
  assert.equal(esc('<img src=x onerror="a()">&\''), '&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
  assert.equal(esc(null), '');
});

test('num keeps a real zero but falls back on blanks and junk', () => {
  assert.equal(num('0', 5), 0);
  assert.equal(num('', 5), 5);
  assert.equal(num('abc', 5), 5);
  assert.equal(num(undefined, 5), 5);
  assert.equal(num('2.5'), 2.5);
});

test('CSV escaping, formula-injection guard and round trip', () => {
  assert.equal(csvEscape('a"b'), '"a""b"');
  assert.equal(csvEscape('=SUM(A1)'), '"\'=SUM(A1)"');
  assert.equal(csvEscape('-5'), '"-5"');
  const rows = [['id', 'title'], ['1', 'Has, comma'], ['2', 'Has "quotes"'], ['3', 'Line\nbreak']];
  const parsed = parseCSV(toCSV(rows));
  assert.deepEqual(parsed, [
    { id: '1', title: 'Has, comma' },
    { id: '2', title: 'Has "quotes"' },
    { id: '3', title: 'Line\nbreak' },
  ]);
});

test('parseCSV handles CRLF, BOM, blank lines and ragged rows', () => {
  const out = parseCSV('﻿title,subject\r\nA,PSM\r\n\r\nB\r\n');
  assert.deepEqual(out, [{ title: 'A', subject: 'PSM' }, { title: 'B', subject: '' }]);
  assert.deepEqual(parseCSV(''), []);
});
