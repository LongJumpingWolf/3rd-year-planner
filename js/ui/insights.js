// Dashboard extras: subject progress, streak / countdown / pace, 7-day activity, focus timer.
import { daysUntil, recentActivity, requiredPace, streak, subjectProgress } from '../insights.js';
import { state } from '../store.js';
import { dateISO, esc, fmtDate } from '../utils.js';
import { $ } from './dom.js';
import { toast } from './toast.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function renderInsights() {
  const today = dateISO(new Date());
  $('#subjectBars').innerHTML = subjectProgress(state.tasks).map((s) => `
    <div class="sbar"><div class="sbar-head"><span>${esc(s.subject)}</span><span>${s.done} / ${s.total} · ${s.pct}%</span></div>
    <div class="progress" role="progressbar" aria-label="${esc(s.subject)} lectures completed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${s.pct}"><span style="width:${s.pct}%"></span></div></div>`).join('')
    || '<div class="empty">No lectures yet.</div>';

  $('#streakVal').textContent = plural(streak(state.tasks, today), 'day');
  const { end, backstop } = state.planConfig;
  const label = (d) => (d < 0 ? `${-d} d ago` : d === 0 ? 'Today' : plural(d, 'day'));
  $('#countFinish').textContent = label(daysUntil(today, end));
  $('#countBackstop').textContent = label(daysUntil(today, backstop));
  const pace = requiredPace(state.tasks, today, end);
  $('#paceCopy').textContent = pace.remaining === 0
    ? 'Every lecture is complete. Well done!'
    : pace.perDay === null
      ? `${plural(pace.remaining, 'lecture')} still open and the target finish (${fmtDate(end)}) has passed. Rebuild the plan or move the target.`
      : `${plural(pace.remaining, 'lecture')} left. About ${pace.perDay.toFixed(1)} lectures a day finishes by ${fmtDate(end)}.`;

  const act = recentActivity(state.tasks, today, 7);
  const max = Math.max(1, ...act.map((a) => a.count));
  $('#spark').innerHTML = act.map((a) => `<div class="spark-col" aria-hidden="true"><div class="spark-bar${a.count ? '' : ' zero'}" style="height:${Math.round((a.count / max) * 44)}px"></div><span class="spark-lbl">${esc(fmtDate(a.iso, { weekday: 'narrow' }))}</span></div>`).join('');
  $('#spark').setAttribute('aria-label', `Lectures completed per day, last 7 days: ${act.map((a) => a.count).join(', ')}`);
  const total = act.reduce((s, a) => s + a.count, 0);
  $('#sparkCopy').textContent = total ? `${plural(total, 'lecture')} completed in the last 7 days.` : 'Tick a lecture as done and your last-7-days activity appears here.';
}

// ---- focus timer (timestamp based, so it stays accurate in background tabs) --------------------

const TIMER_KEY = 'mbbsTimerSessions';
const baseTitle = document.title;
let endsAt = 0;
let remaining = 25 * 60;
let tick = null;

function sessionsToday() {
  try {
    const v = JSON.parse(localStorage.getItem(TIMER_KEY));
    return v && v.date === dateISO(new Date()) ? v.n : 0;
  } catch { return 0; }
}
function bumpSessions() {
  try { localStorage.setItem(TIMER_KEY, JSON.stringify({ date: dateISO(new Date()), n: sessionsToday() + 1 })); } catch { /* ignore */ }
}
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const secsLeft = () => Math.max(0, Math.round((endsAt - Date.now()) / 1000));

function paintTimer() {
  const full = Number($('#timerLen').value) * 60;
  $('#timerFace').textContent = mmss(remaining);
  $('#timerFace').classList.toggle('running', !!tick);
  $('#timerStart').textContent = tick ? 'Pause' : remaining < full ? 'Resume' : 'Start';
  $('#timerCount').textContent = sessionsToday();
  if (tick) document.title = `${mmss(remaining)} · Focus`;
}

function stopTick() {
  clearInterval(tick);
  tick = null;
  document.title = document.title.replace(/^\d\d:\d\d · Focus$/, baseTitle);
}

function onTick() {
  remaining = secsLeft();
  if (remaining === 0) {
    stopTick();
    bumpSessions();
    remaining = Number($('#timerLen').value) * 60;
    toast('Focus session finished. Take a 5-minute break.', { ms: 10000 });
    try { navigator.vibrate?.(200); } catch { /* ignore */ }
  }
  paintTimer();
}

export function initTimer() {
  const len = $('#timerLen');
  const reset = () => { stopTick(); remaining = Number(len.value) * 60; paintTimer(); };
  len.addEventListener('change', reset);
  $('#timerReset').addEventListener('click', reset);
  $('#timerStart').addEventListener('click', () => {
    if (tick) {
      remaining = secsLeft();
      stopTick();
    } else {
      endsAt = Date.now() + remaining * 1000;
      tick = setInterval(onTick, 500);
    }
    paintTimer();
  });
  paintTimer();
}
