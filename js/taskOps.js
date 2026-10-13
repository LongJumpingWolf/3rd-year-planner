// Operations on tasks that keep the light/focused distinction intact. They mutate the `st` object passed in
// (the live state in the app, a fresh state in tests) and return a small result describing what happened.
import {
  MIN_SESSION_H, blockOf, dayStats, findSlot, isCompatible, isSchedulable, recommendedBlock,
  splitTask, taskPlannedSec, usageMap, DEFAULT_PLAN_CONFIG,
} from './planner.js';
import { addDays, dateISO, fromISO, isValidISO } from './utils.js';

const find = (st, id) => st.tasks.find((t) => t.id === id);
const cfgOf = (st) => ({ ...DEFAULT_PLAN_CONFIG, ...st.planConfig });
const plannedH = (st, t) => taskPlannedSec(t, st.settings) / 3600;
const searchLimit = (st) => dateISO(addDays(fromISO(cfgOf(st).backstop), 60));

export function nextSeq(st, iso, block) {
  return 1 + st.tasks.filter((t) => t.scheduledDate === iso && blockOf(t) === block).reduce((m, t) => Math.max(m, Number(t.seq) || 0), 0);
}

function dropFromBacklog(st, id) {
  st.backlog = st.backlog.filter((b) => b.taskId !== id);
}
function addToBacklog(st, id, reason) {
  if (!st.backlog.some((b) => b.taskId === id)) st.backlog.push({ taskId: id, reason });
}

/**
 * Put a task on a date in a block (manual placement, so it is pinned).
 * Deep work in the light block is refused unless override is true.
 */
export function assignTask(st, id, iso, block, { override = false } = {}) {
  const t = find(st, id);
  if (!t) return { error: 'Task not found.' };
  if (!isValidISO(iso)) return { error: 'Please enter a valid date.' };
  if (block !== 'light' && block !== 'focus') return { error: 'Choose light or focused work.' };
  if (!isCompatible(t, block) && !override) return { error: 'incompatible', recommended: recommendedBlock(t) };
  t.scheduledDate = iso;
  t.block = block;
  t.seq = nextSeq(st, iso, block);
  t.pinned = true;
  dropFromBacklog(st, id);
  return { ok: true, override: !isCompatible(t, block) };
}

export function unscheduleTask(st, id, reason = 'Manually unscheduled') {
  const t = find(st, id);
  if (!t) return { error: 'Task not found.' };
  t.scheduledDate = null;
  t.block = null;
  t.seq = null;
  t.pinned = false;
  addToBacklog(st, id, reason);
  return { ok: true };
}

/** Change a task's cognitive intensity. A scheduled deep task left in light work is reported as a mismatch (never moved silently). */
export function reclassifyTask(st, id, intensity, { moveToSuitable = false } = {}) {
  const t = find(st, id);
  if (!t) return { error: 'Task not found.' };
  if (intensity !== 'light' && intensity !== 'deep') return { error: 'Choose light or deep.' };
  t.intensity = intensity;
  const mismatch = !!t.scheduledDate && !isCompatible(t, blockOf(t));
  if (mismatch && moveToSuitable) {
    const r = autoPlaceTask(st, id, { from: t.scheduledDate, block: 'focus' });
    return { ok: true, mismatch: !r.ok, moved: r.ok ? r.iso : null };
  }
  return { ok: true, mismatch };
}

export function setDuration(st, id, minutes) {
  const t = find(st, id);
  const m = Number(minutes);
  if (!t) return { error: 'Task not found.' };
  if (!Number.isFinite(m) || m < 1 || m > 1000) return { error: 'Runtime must be between 1 and 1000 minutes.' };
  t.durationSec = Math.round(m * 60);
  if (t.status === 'estimated_missing') t.status = 'custom_estimate';
  return { ok: true };
}

/**
 * Earliest free slot for the task in its block, from `from` onward (up to 60 days beyond the hard backstop).
 * The task is pinned there. Returns {ok, iso, beyondBackstop} or {error}.
 */
export function autoPlaceTask(st, id, { from, block } = {}) {
  const t = find(st, id);
  if (!t) return { error: 'Task not found.' };
  const cfg = cfgOf(st);
  const b = block && isCompatible(t, block) ? block : isCompatible(t, blockOf(t)) && t.block ? blockOf(t) : recommendedBlock(t);
  const used = usageMap(st.tasks, st.settings, id);
  const iso = findSlot(used, plannedH(st, t), b, from || cfg.start, searchLimit(st), cfg, st.settings);
  if (!iso) return { error: `No free ${b === 'focus' ? 'focused' : 'light'}-work slot in the next few months. Raise the capacity or shorten the task.` };
  t.scheduledDate = iso;
  t.block = b;
  t.seq = nextSeq(st, iso, b);
  t.pinned = true;
  dropFromBacklog(st, id);
  return { ok: true, iso, block: b, beyondBackstop: iso > cfg.backstop };
}

/**
 * Split a not-yet-done task into `n` sessions. If it was scheduled, the extra sessions are placed in the next free
 * slots of the same block; otherwise they wait with the original. Returns {ok, parts} or {error}.
 */
export function splitInState(st, id, n) {
  const i = st.tasks.findIndex((t) => t.id === id);
  const t = st.tasks[i];
  if (!t) return { error: 'Task not found.' };
  if (t.done) return { error: 'Completed tasks cannot be split.' };
  if (t.generated || !isSchedulable(t)) return { error: 'This task cannot be split.' };
  const k = Math.round(Number(n));
  if (!Number.isFinite(k) || k < 2 || k > 8) return { error: 'Choose between 2 and 8 sessions.' };
  if (plannedH(st, t) / k < MIN_SESSION_H - 1e-9) return { error: `Sessions would be shorter than ${Math.round(MIN_SESSION_H * 60)} minutes. Choose fewer sessions.` };
  const parts = splitTask(t, k, false);
  st.tasks.splice(i, 1, ...parts);
  const wasScheduled = !!t.scheduledDate;
  const block = blockOf(t);
  let from = t.scheduledDate;
  const unplaced = [];
  for (const p of parts.slice(1)) {
    if (!wasScheduled) { addToBacklog(st, p.id, 'Split from another session'); continue; }
    const r = autoPlaceTask(st, p.id, { from: dateISO(addDays(fromISO(from), 1)), block });
    if (r.ok) from = r.iso;
    else { addToBacklog(st, p.id, 'No free slot for this session'); unplaced.push(p.id); }
  }
  return { ok: true, parts, unplaced };
}

/** Move overflow out of one block of one day into the next free slots. Generated planning blocks are never moved. */
export function fixOverflow(st, iso, block) {
  const moved = [];
  const stuck = [];
  for (let guard = 0; guard < 50; guard++) {
    const stats = dayStats(st.tasks, iso, st.planConfig, st.settings).blocks[block];
    if (stats.over <= 0.001) break;
    const cand = [...stats.tasks].reverse().find((t) => !t.done && !t.generated && isSchedulable(t));
    if (!cand) break;
    const r = autoPlaceTask(st, cand.id, { from: dateISO(addDays(fromISO(iso), 1)), block });
    if (r.ok) moved.push(cand.id);
    else { unscheduleTask(st, cand.id, 'No free slot after overload'); stuck.push(cand.id); }
  }
  const after = dayStats(st.tasks, iso, st.planConfig, st.settings).blocks[block];
  return { moved, stuck, stillOver: after.over > 0.001 };
}

/**
 * Mark a day unavailable, give it custom capacities, or (ex = null) restore the normal rules.
 * Open lectures that no longer fit are moved to the next free slots; generated planning blocks on an
 * unavailable day are dropped (they are rebuilt by the next regeneration).
 */
export function setDayException(st, iso, ex) {
  if (!isValidISO(iso)) return { error: 'Invalid date.' };
  const exceptions = { ...(st.planConfig.exceptions || {}) };
  if (ex && Object.keys(ex).length) exceptions[iso] = ex;
  else delete exceptions[iso];
  st.planConfig = { ...st.planConfig, exceptions };
  const res = { moved: [], stuck: [], dropped: 0 };
  if (ex?.unavailable) {
    const before = st.tasks.length;
    st.tasks = st.tasks.filter((t) => !(t.generated && t.scheduledDate === iso && !t.done));
    res.dropped = before - st.tasks.length;
  }
  for (const block of ['light', 'focus']) {
    const stats = dayStats(st.tasks, iso, st.planConfig, st.settings).blocks[block];
    if (stats.over <= 0.001 && !(ex?.unavailable && stats.tasks.some((t) => !t.done && !t.generated))) continue;
    if (ex?.unavailable) {
      for (const t of stats.tasks.filter((x) => !x.done && !x.generated && isSchedulable(x))) {
        const r = autoPlaceTask(st, t.id, { from: dateISO(addDays(fromISO(iso), 1)), block });
        if (r.ok) res.moved.push(t.id);
        else { unscheduleTask(st, t.id, 'Day marked unavailable and no later slot was free'); res.stuck.push(t.id); }
      }
    } else {
      const r = fixOverflow(st, iso, block);
      res.moved.push(...r.moved);
      res.stuck.push(...r.stuck);
    }
  }
  return { ok: true, ...res };
}
