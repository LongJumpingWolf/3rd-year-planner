import test from 'node:test';
import assert from 'node:assert/strict';
import { agoText, pendingView, reminderMessage, statusView, streakView, targetView, todayView, whatsappUrl } from '../../js/viewerModel.js';

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

test('todayView shows how much of today\'s work is done, a rest day, or that the update is old', () => {
  const base = { asOf: '2026-10-20', today: { plannedLectures: 3, doneLectures: 2, pct: 62, plannedH: 4, doneH: 2.5 } };
  const v = todayView(base, '2026-10-20');
  assert.equal(v.headline, '62%');
  assert.equal(v.pct, 62);
  assert.match(v.line, /2 of 3 lectures done · 2\.5 of 4 study hours/);
  assert.equal(todayView({ ...base, today: { ...base.today, pct: 95 } }, '2026-10-20').tone, 'good');
  assert.equal(todayView({ ...base, today: { ...base.today, pct: 0 } }, '2026-10-20').headline, '0%');
  assert.equal(todayView({ ...base, today: { plannedLectures: 0, doneLectures: 0, pct: null } }, '2026-10-20').headline, 'Rest day');
  assert.equal(todayView(base, '2026-10-21').headline, 'Waiting');
  // Summaries saved before this field existed only had lecture counts.
  assert.equal(todayView({ asOf: '2026-10-20', today: { plannedLectures: 4, doneLectures: 1 } }, '2026-10-20').headline, '25%');
});

test('streakView explains the 90% rule', () => {
  assert.deepEqual(streakView({ streak: 6, streakPct: 90 }), { num: '6 days', line: "in a row with 90% or more of the day's work done" });
  assert.match(streakView({ streak: 0 }).line, /Reach 90% of a day's work to start a streak/);
  assert.equal(streakView({ streak: 1 }).num, '1 day');
});

const PEND = {
  name: 'Asha', phone: '919876543210', pendingTotal: 4,
  pending: [{ subject: 'PSM', title: 'Cohort Study', date: '2026-10-12' }, { subject: 'ENT', title: 'Basics of Ear (part 1/2)', date: '2026-10-13' }],
};

test('pendingView lists the overdue lectures and how many more there are', () => {
  const v = pendingView(PEND);
  assert.equal(v.total, 4);
  assert.equal(v.more, 2);
  assert.deepEqual(v.items.map((i) => [i.subject, i.title]), [['PSM', 'Cohort Study'], ['ENT', 'Basics of Ear (part 1/2)']]);
  assert.deepEqual(pendingView({}), { items: [], more: 0, total: 0 });
});

test('the WhatsApp reminder is pre-typed, names every pending lecture and goes to the owner\'s number when shared', () => {
  const msg = reminderMessage(PEND);
  assert.match(msg, /^Hi Asha, a gentle reminder/);
  assert.match(msg, /1\. PSM: Cohort Study \(planned (12 Oct|Oct 12)\)/);
  assert.match(msg, /2\. ENT: Basics of Ear \(part 1\/2\) \(planned (13 Oct|Oct 13)\)/);
  assert.match(msg, /\.\.\.and 2 more/);
  const url = whatsappUrl(PEND);
  assert.ok(url.startsWith('https://wa.me/919876543210?text='));
  assert.equal(decodeURIComponent(url.split('?text=')[1]), msg);
  // No number shared: WhatsApp lets the viewer choose the contact.
  assert.ok(whatsappUrl({ ...PEND, phone: '' }).startsWith('https://wa.me/?text='));
  assert.ok(whatsappUrl({ ...PEND, phone: '+91 (98765) 43210' }).startsWith('https://wa.me/919876543210?text='), 'a messy number is reduced to digits');
  assert.match(reminderMessage({ ...PEND, name: '' }), /^A gentle reminder/);
});

test('targetView counts days from the viewer’s today and hides once everything is done', () => {
  const snap = { done: 1, total: 5, target: { date: '2026-10-30' } };
  assert.equal(targetView(snap, '2026-10-20').num, '10');
  assert.equal(targetView(snap, '2026-10-30').num, '0');
  assert.match(targetView(snap, '2026-11-02').label, /past the target/);
  assert.equal(targetView({ ...snap, done: 5 }, '2026-10-20'), null);
});
