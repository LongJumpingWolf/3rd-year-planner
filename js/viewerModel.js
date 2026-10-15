// Turns a shared snapshot into plain-language strings for the viewer page (pure, no DOM, unit-tested).
// Imports only utils.js so the viewer page stays small and never loads any planner code.
import { fmtDate, fromISO } from './utils.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function agoText(updatedAt, now = new Date()) {
  const ms = now - new Date(updatedAt);
  if (!Number.isFinite(ms)) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${plural(min, 'minute')} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${plural(h, 'hour')} ago`;
  return `${plural(Math.floor(h / 24), 'day')} ago`;
}

export function statusView(status, startIso) {
  const n = status?.behind || 0;
  switch (status?.code) {
    case 'done': return { tone: 'good', icon: '✓', text: 'All lectures complete', detail: 'Everything planned is finished.' };
    case 'notstarted': return { tone: 'neutral', icon: '•', text: 'Not started yet', detail: startIso ? `The plan begins on ${fmtDate(startIso)}.` : '' };
    case 'ontrack': return { tone: 'good', icon: '✓', text: 'On track', detail: 'Keeping up with the plan.' };
    case 'slightly': return { tone: 'warn', icon: '!', text: `A little behind: ${plural(n, 'lecture')}`, detail: 'Planned for earlier days and not done yet.' };
    case 'behind': return { tone: 'bad', icon: '!', text: `Behind: ${plural(n, 'lecture')}`, detail: 'Planned for earlier days and not done yet.' };
    default: return { tone: 'neutral', icon: '•', text: 'No status yet', detail: '' };
  }
}

/** Today's card. `todayIso` is the viewer's own date; if the owner's last update is older, say so instead of guessing. */
export function todayView(snap, todayIso) {
  const t = snap.today || { plannedLectures: 0, doneLectures: 0 };
  if (snap.asOf !== todayIso) {
    return { tone: 'neutral', headline: 'Waiting', line: `Last update was on ${fmtDate(snap.asOf, { weekday: 'long', day: 'numeric', month: 'short' })}.` };
  }
  if (t.doneLectures > 0) {
    return { tone: 'good', headline: 'Yes', line: `${plural(t.doneLectures, 'lecture')} done today${t.plannedLectures ? ` (${t.plannedLectures} planned)` : ''}.` };
  }
  if (t.plannedLectures > 0) return { tone: 'warn', headline: 'Not yet', line: `${plural(t.plannedLectures, 'lecture')} planned for today.` };
  return { tone: 'neutral', headline: 'Rest day', line: 'No lectures planned today.' };
}

export function targetView(snap, todayIso) {
  if (!snap.target?.date) return null;
  const days = Math.round((fromISO(snap.target.date) - fromISO(todayIso)) / 86400000);
  const when = fmtDate(snap.target.date, { day: 'numeric', month: 'long', year: 'numeric' });
  if (snap.done === snap.total && snap.total > 0) return null;
  return days > 0 ? { num: String(days), label: `${days === 1 ? 'day' : 'days'} to the target finish (${when})` }
    : days === 0 ? { num: '0', label: `The target finish is today (${when})` }
    : { num: String(-days), label: `${-days === 1 ? 'day' : 'days'} past the target finish (${when})` };
}
