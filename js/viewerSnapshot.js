// The small, numbers-only summary that is shared with a viewer link (pure, no DOM, unit-tested).
// It deliberately contains no task titles, settings or plan details: only counts, percentages and the owner's own day notes.
import { isVideo } from './planner.js';
import { daysUntil, recentActivity, streak, subjectProgress } from './insights.js';
import { addDays, dateISO, fromISO } from './utils.js';

export const SNAPSHOT_VERSION = 1;
const BEHIND_SLIGHT = 3;

/** 'done' | 'notstarted' | 'ontrack' | 'slightly' | 'behind' plus the lectures that were planned before today but are still open. */
export function trackStatus(tasks, todayIso, startIso, asleepList = []) {
  const asleep = new Set(asleepList);
  const lectures = tasks.filter((t) => isVideo(t) && !asleep.has(t.subject)); // paused subjects are not part of the plan
  if (lectures.length && lectures.every((t) => t.done)) return { code: 'done', behind: 0 };
  if (startIso && todayIso < startIso) return { code: 'notstarted', behind: 0 };
  const behind = lectures.filter((t) => !t.done && t.scheduledDate && t.scheduledDate < todayIso).length;
  return { code: behind === 0 ? 'ontrack' : behind <= BEHIND_SLIGHT ? 'slightly' : 'behind', behind };
}

/**
 * @param state    app state
 * @param todayIso the owner's local date (YYYY-MM-DD)
 * @param opts     { name: first name or '', now: Date }
 */
export function buildSnapshot(state, todayIso, { name = '', now = new Date() } = {}) {
  const lectures = state.tasks.filter(isVideo);
  const done = lectures.filter((t) => t.done).length;
  const total = lectures.length;
  const asleep = state.planConfig.asleep || [];
  const status = trackStatus(state.tasks, todayIso, state.planConfig.start, asleep);
  const plannedToday = lectures.filter((t) => t.scheduledDate === todayIso).length;
  const doneToday = lectures.filter((t) => t.done && t.doneAt === todayIso).length;

  const extras = [];
  for (let i = 0; i < 7; i++) {
    const iso = dateISO(addDays(fromISO(todayIso), -i));
    const items = state.extras?.[iso];
    if (items?.length) extras.push({ date: iso, items: items.slice() });
  }

  return {
    v: SNAPSHOT_VERSION,
    name: String(name).slice(0, 40),
    updatedAt: now.toISOString(),
    asOf: todayIso,
    startsOn: state.planConfig.start,
    done,
    total,
    pct: total ? Math.round((done / total) * 100) : 0,
    status,
    today: { plannedLectures: plannedToday, doneLectures: doneToday },
    streak: streak(state.tasks, todayIso),
    week: recentActivity(state.tasks, todayIso, 7),
    subjects: subjectProgress(state.tasks).map((s) => ({ subject: s.subject, done: s.done, total: s.total, pct: s.pct, ...(asleep.includes(s.subject) && s.done < s.total ? { paused: true } : {}) })),
    target: { date: state.planConfig.end, daysLeft: daysUntil(todayIso, state.planConfig.end) },
    extras,
  };
}
