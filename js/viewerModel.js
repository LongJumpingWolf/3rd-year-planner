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

/** Today's card: how much of today's planned work is ticked off. `todayIso` is the viewer's own date; an older update is called out. */
export function todayView(snap, todayIso) {
  const t = snap.today || { plannedLectures: 0, doneLectures: 0 };
  if (snap.asOf !== todayIso) {
    return { tone: 'neutral', pct: null, headline: 'Waiting', line: `Last update was on ${fmtDate(snap.asOf, { weekday: 'long', day: 'numeric', month: 'short' })}.` };
  }
  const pct = t.pct !== undefined ? t.pct : (t.plannedLectures ? Math.round((t.doneLectures / t.plannedLectures) * 100) : null); // older summaries only had counts
  if (pct === null || pct === undefined) return { tone: 'neutral', pct: null, headline: 'Rest day', line: 'Nothing is planned for today.' };
  const hours = t.plannedH ? ` · ${t.doneH ?? 0} of ${t.plannedH} study hours` : '';
  const lectures = t.plannedLectures ? `${t.doneLectures} of ${plural(t.plannedLectures, 'lecture')} done${hours}.` : `${hours.replace(/^ · /, '')}.`;
  return { tone: pct >= 90 ? 'good' : pct >= 40 ? 'warn' : 'neutral', pct, headline: `${pct}%`, line: lectures };
}

/** Study streak: days in a row with at least `streakPct` of the day's work ticked off. */
export function streakView(snap) {
  const bar = snap.streakPct || 90;
  const n = snap.streak || 0;
  return { num: plural(n, 'day'), line: n ? `in a row with ${bar}% or more of the day's work done` : `Reach ${bar}% of a day's work to start a streak` };
}

/** Lectures that are overdue, as lines the viewer can read, and a pre-typed WhatsApp reminder (to the owner's number when it was shared). */
export function pendingView(snap) {
  const items = (snap.pending || []).map((p) => ({ subject: p.subject, title: p.title, when: p.date ? fmtDate(p.date, { day: 'numeric', month: 'short' }) : '' }));
  const total = snap.pendingTotal || items.length;
  return { items, more: Math.max(0, total - items.length), total };
}

export function reminderMessage(snap) {
  const { items, more } = pendingView(snap);
  const hello = snap.name ? `Hi ${snap.name}, a` : 'A';
  const lines = items.map((p, i) => `${i + 1}. ${p.subject}: ${p.title}${p.when ? ` (planned ${p.when})` : ''}`);
  return [`${hello} gentle reminder: these are still pending in your study plan:`, '', ...lines, ...(more ? [`...and ${more} more`] : []), '', 'No pressure, just a nudge to catch up when you can.'].join('\n');
}

/** wa.me link with the message filled in. With a number it opens that chat; without one WhatsApp lets the viewer pick the contact. */
export function whatsappUrl(snap) {
  const digits = String(snap.phone || '').replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(reminderMessage(snap))}`;
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
