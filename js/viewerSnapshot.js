// The small summary that is shared with a viewer link (pure, no DOM, unit-tested).
// It contains counts, percentages, the owner's own day notes, and the titles of lectures that are overdue (so the viewer can
// remind the owner). It never contains the plan, settings or the rest of the library.
import { dayStats, isVideo } from './planner.js';
import { daysUntil, recentActivity, subjectProgress } from './insights.js';
import { addDays, dateISO, fromISO } from './utils.js';

export const SNAPSHOT_VERSION = 1;
export const STREAK_PCT = 90; // a day counts towards the streak when at least this share of its planned work is ticked off
const BEHIND_SLIGHT = 3;
const MAX_PENDING = 12;

/** Open lectures that were planned for a day that is already over (paused subjects excluded), oldest first. */
export function pendingLectures(tasks, todayIso, asleepList = []) {
  const asleep = new Set(asleepList);
  return tasks
    .filter((t) => isVideo(t) && !t.done && !asleep.has(t.subject) && t.scheduledDate && t.scheduledDate < todayIso)
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** Completion of one day's planned work, counting hours that were missed and later moved forward. pct is null on a day with no plan. */
export function dayCompletion(state, iso) {
  const d = dayStats(state.tasks, iso, state.planConfig, state.settings);
  const planned = d.planned + (state.missLog?.[iso] || 0);
  return { planned, done: d.done, pct: planned > 0.001 ? Math.round((d.done / planned) * 100) : null };
}

/**
 * Days in a row (ending today) on which at least STREAK_PCT of the planned work was ticked off. Days with nothing planned are
 * skipped; today only counts once it reaches the bar, and does not break the streak before that.
 */
export function completionStreak(state, todayIso, lookback = 150) {
  let n = 0;
  const today = dayCompletion(state, todayIso);
  if (today.pct !== null && today.pct >= STREAK_PCT) n++;
  for (let i = 1; i <= lookback; i++) {
    const iso = dateISO(addDays(fromISO(todayIso), -i));
    if (iso < state.planConfig.start) break;
    const c = dayCompletion(state, iso);
    if (c.pct === null) continue;
    if (c.pct >= STREAK_PCT) n++; else break;
  }
  return n;
}

/** 'done' | 'notstarted' | 'ontrack' | 'slightly' | 'behind' plus the lectures that were planned before today but are still open. */
export function trackStatus(tasks, todayIso, startIso, asleepList = []) {
  const asleep = new Set(asleepList);
  const lectures = tasks.filter((t) => isVideo(t) && !asleep.has(t.subject)); // paused subjects are not part of the plan
  if (lectures.length && lectures.every((t) => t.done)) return { code: 'done', behind: 0 };
  if (startIso && todayIso < startIso) return { code: 'notstarted', behind: 0 };
  const behind = pendingLectures(tasks, todayIso, asleepList).length;
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
  const todayWork = dayCompletion(state, todayIso);
  const pending = pendingLectures(state.tasks, todayIso, asleep);

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
    today: { plannedLectures: plannedToday, doneLectures: doneToday, pct: todayWork.pct, plannedH: Math.round(todayWork.planned * 10) / 10, doneH: Math.round(todayWork.done * 10) / 10 },
    streak: completionStreak(state, todayIso),
    streakPct: STREAK_PCT,
    pending: pending.slice(0, MAX_PENDING).map((t) => ({ subject: t.subject, title: `${t.title}${t.partCount ? ` (part ${t.partIndex}/${t.partCount})` : ''}`, date: t.scheduledDate })),
    pendingTotal: pending.length,
    phone: state.viewer?.phone || '',
    week: recentActivity(state.tasks, todayIso, 7),
    subjects: subjectProgress(state.tasks).map((s) => ({ subject: s.subject, done: s.done, total: s.total, pct: s.pct, ...(asleep.includes(s.subject) && s.done < s.total ? { paused: true } : {}) })),
    target: { date: state.planConfig.end, daysLeft: daysUntil(todayIso, state.planConfig.end) },
    extras,
  };
}
