import { BLOCKS, BLOCK_INFO, dayStats, isVideo, lectureStats, taskPlannedSec, weekdayCapacity, weeklyLoad } from '../planner.js';
import { state } from '../store.js';
import { addDays, dateISO, esc, fmtDate, fmtDur, fromISO, isValidISO, weekStart } from '../utils.js';
import { compactBlockHTML } from './blocks.js';
import { $ } from './dom.js';
import { taskCardHTML } from './taskCard.js';

export function currentWeekStart() {
  const inp = $('#weekDate');
  if (!isValidISO(inp.value)) inp.value = $('#focusDate').value || dateISO(new Date());
  return weekStart(fromISO(inp.value));
}

export function shiftWeek(days) {
  const inp = $('#weekDate');
  inp.value = dateISO(addDays(fromISO(inp.value), days));
}

function dayHTML(d) {
  const iso = dateISO(d);
  const todayIso = dateISO(new Date());
  const day = dayStats(state.tasks, iso, state.planConfig, state.settings);
  const closed = day.kind === 'trip' || day.kind === 'off';
  const label = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const over = BLOCKS.some((b) => day.blocks[b].over > 0.001);
  return `<section class="day ${iso === todayIso ? 'today' : ''} ${closed ? 'blocked' : ''}" aria-label="${esc(label)}">
    <div class="day-head">
      <h3><a href="#day/${iso}" title="Open the daily view for ${esc(label)}">${esc(d.toLocaleDateString(undefined, { weekday: 'short' }))} ${esc(fmtDate(iso, { day: 'numeric', month: 'short' }))}${iso === todayIso ? ' · Today' : ''}</a></h3>
      <span class="day-pct" title="Completed share of planned study time">${closed ? '' : `${day.pct}% done`}</span>
    </div>
    ${closed ? `<p class="day-meta">${esc(day.note)}</p>` : `<p class="day-meta ${over ? 'error-text' : ''}">${over ? '⚠ Over capacity · ' : ''}${fmtDur(day.planned * 3600)} of ${fmtDur(day.capacity * 3600)} planned${day.kind === 'dams' ? ' · DAMS day' : ''}${day.custom ? ' · custom' : ''}</p>
    ${BLOCKS.map((b) => compactBlockHTML(day, b)).join('')}`}
  </section>`;
}

export function renderCalendar() {
  const start = currentWeekStart();
  $('#weekLabel').textContent = `Week of ${fmtDate(dateISO(start), { day: 'numeric', month: 'long', year: 'numeric' })} – ${fmtDate(dateISO(addDays(start, 6)), { day: 'numeric', month: 'long', year: 'numeric' })}`;
  $('#weekGrid').innerHTML = Array.from({ length: 7 }, (_, i) => dayHTML(addDays(start, i))).join('');

  const rows = state.backlog.map((b) => ({ t: state.tasks.find((t) => t.id === b.taskId), reason: b.reason })).filter((x) => x.t);
  $('#backlogList').innerHTML = rows.length
    ? rows.map(({ t, reason }) => taskCardHTML(t, 'back', { reason })).join('')
    : '<div class="empty">Nothing in the backlog. Everything schedulable has a date.</div>';

  renderPlanForm();
  renderPlanReport();
  renderWeeklyLoad();
}

// The form is only re-filled when the saved config object changes (generate, import, reset),
// so half-typed edits are never overwritten by an unrelated re-render.
let filledFor = null;
export function renderPlanForm() {
  const form = $('#planForm');
  const s = state.settings;
  $('#weekdayCapShown').value = `Light ${s.collegeHours} h + Focused ${s.studyHours} h`;
  if (filledFor === state.planConfig) return;
  filledFor = state.planConfig;
  for (const k of ['start', 'end', 'backstop', 'tripStart', 'tripEnd', 'weekendLight', 'weekendFocus']) form.elements[k].value = state.planConfig[k];
}

export function renderPlanReport() {
  const box = $('#planReport');
  const stats = lectureStats(state.tasks);
  const vids = state.tasks.filter((t) => isVideo(t) && !t.done);
  const hours = vids.reduce((s, t) => s + taskPlannedSec(t, state.settings), 0) / 3600;
  const placedH = vids.filter((t) => t.scheduledDate).reduce((s, t) => s + taskPlannedSec(t, state.settings), 0) / 3600;
  const gen = { light: 0, focus: 0 };
  state.tasks.filter((t) => t.generated && !t.done).forEach((t) => { gen[t.block === 'light' ? 'light' : 'focus'] += t.durationSec / 3600; });
  const un = stats.unscheduled;
  box.innerHTML = `
    <div class="kpi"><span class="small muted">Lectures scheduled</span><strong>${stats.scheduled} / ${stats.open}</strong></div>
    <div class="kpi"><span class="small muted">Lecture study time</span><strong>${hours.toFixed(1)} h</strong></div>
    <div class="kpi"><span class="small muted">Placed in Focused work</span><strong>${placedH.toFixed(1)} h</strong></div>
    <div class="kpi ${un ? 'bad' : 'good'}"><span class="small muted">Unscheduled</span><strong>${un}</strong></div>
    <div class="kpi"><span class="small muted">Light prep &amp; fixed blocks</span><strong>${gen.light.toFixed(1)} h light · ${gen.focus.toFixed(1)} h focused</strong></div>`;
  if (state.planMeta) {
    const m = state.planMeta;
    const note = un
      ? `${un} lecture${un === 1 ? '' : 's'} do not fit before ${m.hard} (${m.overflow?.focus ?? 0} focused-work, ${m.overflow?.light ?? 0} light-work). Options: use “Next free slot” on a backlog item, raise the focused hours in Settings, move the hard backstop, or add capacity on a day with “Day settings”.`
      : 'All incomplete lectures fit under the current assumptions.';
    box.insertAdjacentHTML('beforeend', `<p class="small ${un ? 'error-text' : 'muted'}" style="flex-basis:100%;margin:0">${esc(note)}${m.splitLectures ? ` ${m.splitLectures} lecture${m.splitLectures === 1 ? ' was' : 's were'} split into sessions.` : ''}</p>`);
  } else {
    box.insertAdjacentHTML('beforeend', '<p class="small muted" style="flex-basis:100%;margin:0">No plan yet. Choose your dates above and generate one.</p>');
  }
}

export function renderWeeklyLoad() {
  const rows = weeklyLoad(state.tasks, state.settings);
  const weekly = (state.settings.studyHours + state.settings.collegeHours) * 5 + ((state.planConfig.weekendLight || 0) + (state.planConfig.weekendFocus || 0)) * 2;
  const max = Math.max(1, weekly);
  $('#weeklyLoad').innerHTML = rows.length
    ? `<table><thead><tr><th scope="col">Week starting</th><th scope="col">Tasks</th><th scope="col">${esc(BLOCK_INFO.light.name)}</th><th scope="col">${esc(BLOCK_INFO.focus.name)}</th><th scope="col">Completed</th><th scope="col">Load</th></tr></thead><tbody>${rows.map((x) => `<tr><th scope="row">${esc(fmtDate(x.week, { day: 'numeric', month: 'short', year: 'numeric' }))}</th><td>${x.tasks}</td><td>${x.light.toFixed(1)} h</td><td>${x.focus.toFixed(1)} h</td><td>${x.done}</td><td><div class="progress week-load" role="img" aria-label="${Math.min(100, Math.round((x.hours / max) * 100))}% of a typical week"><span style="width:${Math.min(100, (x.hours / max) * 100)}%"></span></div></td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">Generate a plan to see the weekly workload.</div>';
}
