// Pure progress analytics for the dashboard (no DOM, unit-tested).
import { isVideo } from './planner.js';
import { addDays, dateISO, fromISO } from './utils.js';

/** Done / total lectures per subject, in library order. */
export function subjectProgress(tasks) {
  const map = new Map();
  for (const t of tasks) {
    if (!isVideo(t)) continue;
    const s = map.get(t.subject) || { subject: t.subject, total: 0, done: 0, sec: 0, doneSec: 0 };
    s.total += 1;
    s.sec += t.durationSec;
    if (t.done) { s.done += 1; s.doneSec += t.durationSec; }
    map.set(t.subject, s);
  }
  return [...map.values()].map((s) => ({ ...s, pct: s.total ? Math.round((s.done / s.total) * 100) : 0 }));
}

/** Lectures completed per day for the `days` days ending at `todayIso` (oldest first). */
export function recentActivity(tasks, todayIso, days = 7) {
  const counts = new Map();
  for (const t of tasks) if (t.done && t.doneAt) counts.set(t.doneAt, (counts.get(t.doneAt) || 0) + 1);
  const end = fromISO(todayIso);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const iso = dateISO(addDays(end, -i));
    out.push({ iso, count: counts.get(iso) || 0 });
  }
  return out;
}

/** Consecutive days with at least one completion, ending today (or yesterday, so an unfinished today keeps the streak). */
export function streak(tasks, todayIso) {
  const days = new Set(tasks.filter((t) => t.done && t.doneAt).map((t) => t.doneAt));
  let d = fromISO(todayIso);
  if (!days.has(dateISO(d))) d = addDays(d, -1);
  let n = 0;
  while (days.has(dateISO(d))) { n += 1; d = addDays(d, -1); }
  return n;
}

/** Whole days from `fromIso` to `toIso` (negative when past). */
export function daysUntil(fromIso, toIso) {
  return Math.round((fromISO(toIso) - fromISO(fromIso)) / 86400000);
}

/** Pace needed to finish: remaining lectures per day until the target date (null when the date has passed). */
export function requiredPace(tasks, todayIso, targetIso) {
  const remaining = tasks.filter((t) => isVideo(t) && !t.done).length;
  const days = daysUntil(todayIso, targetIso);
  return { remaining, days, perDay: days > 0 ? remaining / days : null };
}
