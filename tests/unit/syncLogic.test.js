import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSync, hasLocalProgress } from '../../js/syncLogic.js';
import { freshState } from '../../js/store.js';

const meta = (o = {}) => ({ uid: 'u1', rev: 3, dirty: false, ...o });

test('no cloud data yet: upload this device', () => {
  assert.equal(decideSync({ meta: null, uid: 'u1', remoteRev: null, localHasProgress: false }), 'push');
});

test('same account: nothing changed, only local changed, only cloud changed, both changed', () => {
  assert.equal(decideSync({ meta: meta(), uid: 'u1', remoteRev: 3 }), 'none');
  assert.equal(decideSync({ meta: meta({ dirty: true }), uid: 'u1', remoteRev: 3 }), 'push');
  assert.equal(decideSync({ meta: meta(), uid: 'u1', remoteRev: 4 }), 'pull');
  assert.equal(decideSync({ meta: meta({ dirty: true }), uid: 'u1', remoteRev: 4 }), 'conflict');
});

test('new account on this device: pull unless local work would be lost', () => {
  assert.equal(decideSync({ meta: null, uid: 'u1', remoteRev: 2, localHasProgress: false }), 'pull');
  assert.equal(decideSync({ meta: null, uid: 'u1', remoteRev: 2, localHasProgress: true }), 'conflict');
  assert.equal(decideSync({ meta: meta({ uid: 'other' }), uid: 'u1', remoteRev: 2, localHasProgress: true }), 'conflict');
});

test('hasLocalProgress: untouched library is not progress; ticked or added tasks are', () => {
  const s = freshState();
  const n = s.tasks.length;
  assert.equal(hasLocalProgress(s, n), false);
  s.tasks[0].done = true;
  assert.equal(hasLocalProgress(s, n), true);
  s.tasks[0].done = false;
  s.tasks.pop();
  assert.equal(hasLocalProgress(s, n), true);
});
