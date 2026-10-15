import test from 'node:test';
import assert from 'node:assert/strict';
import { agoText, statusView, targetView, todayView } from '../../js/viewerModel.js';

const NOW = new Date('2026-10-20T12:00:00Z');

test('agoText: just now, minutes, hours, days', () => {
  assert.equal(agoText('2026-10-20T11:59:40Z', NOW), 'just now');
  assert.equal(agoText('2026-10-20T11:59:00Z', NOW), '1 minute ago');
  assert.equal(agoText('2026-10-20T09:00:00Z', NOW), '3 hours ago');
  assert.equal(agoText('2026-10-17T12:00:00Z', NOW), '3 days ago');
  assert.equal(agoText('garbage', NOW), '');
});

test('statusView words and tones', () => {
  assert.equal(statusView({ code: 'ontrack', behind: 0 }).tone, 'good');
  assert.match(statusView({ code: 'slightly', behind: 1 }).text, /1 lecture$/);
  assert.match(statusView({ code: 'behind', behind: 7 }).text, /Behind: 7 lectures/);
  assert.equal(statusView({ code: 'behind', behind: 7 }).tone, 'bad');
  assert.equal(statusView({ code: 'done', behind: 0 }).tone, 'good');
  assert.equal(statusView(undefined).tone, 'neutral');
});

test('todayView: studied, planned but not yet, rest day, stale update', () => {
  const base = { asOf: '2026-10-20', today: { plannedLectures: 3, doneLectures: 2 } };
  assert.equal(todayView(base, '2026-10-20').headline, 'Yes');
  assert.equal(todayView({ ...base, today: { plannedLectures: 3, doneLectures: 0 } }, '2026-10-20').headline, 'Not yet');
  assert.equal(todayView({ ...base, today: { plannedLectures: 0, doneLectures: 0 } }, '2026-10-20').headline, 'Rest day');
  assert.equal(todayView(base, '2026-10-21').headline, 'Waiting');
});

test('targetView counts days from the viewer’s today and hides once everything is done', () => {
  const snap = { done: 1, total: 5, target: { date: '2026-10-30' } };
  assert.equal(targetView(snap, '2026-10-20').num, '10');
  assert.equal(targetView(snap, '2026-10-30').num, '0');
  assert.match(targetView(snap, '2026-11-02').label, /past the target/);
  assert.equal(targetView({ ...snap, done: 5 }, '2026-10-20'), null);
});
