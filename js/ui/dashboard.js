import { dayStats, isVideo, lectureStats, taskPlannedSec, weekSummary } from '../planner.js';
import { state } from '../store.js';
import { dateISO, fmtDate, fmtDur, fmtHours, fromISO, isValidISO } from '../utils.js';
import { blockSectionHTML } from './blocks.js';
import { $, setProgress } from './dom.js';
import { renderInsights } from './insights.js';

export function renderDashboard() {
  const videos = state.tasks.filter(isVideo);
  const stats = lectureStats(state.tasks);
  const runtime = videos.reduce((s, t) => s + t.durationSec, 0);
  const planned = videos.reduce((s, t) => s + taskPlannedSec(t, state.settings), 0);

  $('#mTasks').textContent = stats.total;
  $('#mSubjects').textContent = `${new Set(videos.map((t) => t.subject)).size} subjects represented`;
  $('#mDone').textContent = `${stats.done} / ${stats.total}`;
  setProgress($('#pDoneBar'), $('#pDone'), stats.total ? (stats.done / stats.total) * 100 : 0);
  $('#mRuntime').textContent = fmtHours(runtime);
  $('#mPlanned').textContent = fmtHours(planned);

  const dateInput = $('#focusDate');
  if (!isValidISO(dateInput.value)) dateInput.value = dateISO(new Date());
  const date = dateInput.value;
  const day = dayStats(state.tasks, date, state.planConfig, state.settings);
  $('#openDayLink').setAttribute('href', `#day/${date}`);
  $('#todaySummary').textContent = `${fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · ${fmtDur(day.planned * 3600)} planned · ${fmtDur(day.done * 3600)} completed (${day.pct}%)`;
  $('#todayTasks').innerHTML = day.kind === 'trip' || day.kind === 'off'
    ? `<div class="empty">${day.note}. No study is planned on this day.</div>`
    : ['light', 'focus'].map((b) => blockSectionHTML(day, b, 'dash', { headingLevel: 4 })).join('');

  const back = state.backlog.map((b) => state.tasks.find((t) => t.id === b.taskId)).filter(Boolean);
  $('#backlogCount').textContent = back.length;
  $('#backlogTime').textContent = fmtHours(back.reduce((s, t) => s + taskPlannedSec(t, state.settings), 0));

  const w = weekSummary(state.tasks, fromISO(date), state.planConfig, state.settings);
  const free = Math.max(0, w.free);
  $('#bufferMetric').textContent = `${free.toFixed(1)} h of ${w.buffer} h target`;
  const pct = w.buffer > 0 ? (free / w.buffer) * 100 : 100;
  const color = w.free < 0 ? 'var(--bad)' : pct < 100 ? 'var(--warn)' : 'var(--good)';
  setProgress($('#bufferBarWrap'), $('#bufferBar'), pct, color);
  $('#bufferCopy').textContent = w.free < 0
    ? `This week is over-booked by ${(-w.free).toFixed(1)} h (${w.planned.toFixed(1)} h planned vs ${w.capacity.toFixed(1)} h available). Move something or use the simulator.`
    : pct < 100
      ? `${w.planned.toFixed(1)} h planned of ${w.capacity.toFixed(1)} h available. Your reserve is below the ${w.buffer} h target.`
      : `${w.planned.toFixed(1)} h planned of ${w.capacity.toFixed(1)} h available. Your reserve target is intact.`;
  renderInsights();
}
