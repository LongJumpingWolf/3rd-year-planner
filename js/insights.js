// Pure progress analytics for the dashboard (no DOM, unit-tested).
import { isVideo, lectureKey } from './planner.js';
import { addDays, dateISO, fromISO } from './utils.js';

/**
 * Treat split sessions as one lecture everywhere progress is reported.
 * A lecture counts as complete only when every part is marked done.
 */
function lectureGroups(tasks) {
  const groups = new Map();
  for (const t of tasks) {
    if (!isVideo(t)) continue;
    const key = lectureKey(t);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups.values()];
}

function completedOn(parts) {
  if (!parts.length || !parts.every((part) => part.done)) return '';
  // For a split lecture, the completion date is the date its final part was completed.
  return parts.map((part) => part.doneAt || '').filter(Boolean).sort().at(-1) || '';
}

/** Done / total whole lectures per subject, in library order. Split parts count as one lecture. */
export function subjectProgress(tasks) {
  const map = new Map();
  for (const parts of lectureGroups(tasks)) {
    const first = parts[0];
    const s = map.get(first.subject) || { subject: first.subject, total: 0, done: 0, sec: 0, doneSec: 0 };
    const duration = parts.reduce((sum, part) => sum + part.durationSec, 0);
    s.total += 1;
    s.sec += duration;
    if (parts.every((part) => part.done)) {
      s.done += 1;
      s.doneSec += duration;
    }
    map.set(first.subject, s);
  }
  return [...map.values()].map((s) => ({ ...s, pct: s.total ? Math.round((s.done / s.total) * 100) : 0 }));
}

/** Whole lectures completed per day for the `days` days ending at `todayIso` (oldest first). */
export function recentActivity(tasks, todayIso, days = 7) {
  const counts = new Map();
  for (const parts of lectureGroups(tasks)) {
    const iso = completedOn(parts);
    if (iso) counts.set(iso, (counts.get(iso) || 0) + 1);
  }
  const end = fromISO(todayIso);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const iso = dateISO(addDays(end, -i));
    out.push({ iso, count: counts.get(iso) || 0 });
  }
  return out;
}

/** Consecutive days with at least one whole lecture completed, ending today (or yesterday). */
export function streak(tasks, todayIso) {
  const days = new Set(lectureGroups(tasks).map(completedOn).filter(Boolean));
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

/** Pace needed to finish: remaining whole lectures per day until the target date. */
export function requiredPace(tasks, todayIso, targetIso) {
  const remaining = lectureGroups(tasks).filter((parts) => !parts.every((part) => part.done)).length;
  const days = daysUntil(todayIso, targetIso);
  return { remaining, days, perDay: days > 0 ? remaining / days : null };
}
