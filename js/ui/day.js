// Daily view: one date, two clearly separated work blocks.
import { BLOCKS, BLOCK_INFO, dayStats } from '../planner.js';
import { state } from '../store.js';
import { addDays, dateISO, esc, fmtDate, fmtDur, fromISO, isValidISO } from '../utils.js';
import { blockSectionHTML } from './blocks.js';
import { $ } from './dom.js';

export function currentDayISO() {
  const inp = $('#dayDate');
  if (!isValidISO(inp.value)) inp.value = $('#focusDate').value || dateISO(new Date());
  return inp.value;
}

export function setDay(iso) {
  $('#dayDate').value = isValidISO(iso) ? iso : dateISO(new Date());
}

export function shiftDay(n) {
  setDay(dateISO(addDays(fromISO(currentDayISO()), n)));
}

export function renderDay() {
  const iso = currentDayISO();
  const day = dayStats(state.tasks, iso, state.planConfig, state.settings);
  $('#dayLabel').textContent = fmtDate(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const notice = $('#dayNotice');
  const messages = {
    trip: 'Protected trip day: no study is planned.',
    off: `${day.note}. No study is planned on this day.`,
    dams: 'DAMS class day (9 AM – 9 PM). Only a short light-work recap is planned; no focused work.',
    break: 'College break: both blocks use the free-day capacities.',
    weekend: 'Free weekend: no college gaps, so both blocks use the weekend capacities.',
  };
  const msg = messages[day.kind] || '';
  const custom = day.custom ? `Custom capacity for this day${state.planConfig.exceptions?.[iso]?.note ? `: ${state.planConfig.exceptions[iso].note}` : ''}.` : '';
  notice.hidden = !(msg || custom);
  notice.textContent = [msg, custom].filter(Boolean).join(' ');

  $('#daySummary').innerHTML = `
    <div class="kpi"><span class="small muted">Overall completion</span><strong>${day.pct}%</strong>
      <span class="small muted">${fmtDur(day.done * 3600)} of ${fmtDur(day.planned * 3600)} planned</span></div>
    ${BLOCKS.map((b) => {
      const x = day.blocks[b];
      return `<div class="kpi kpi-${b} ${x.over > 0.001 ? 'bad' : ''}"><span class="small muted">${esc(BLOCK_INFO[b].name)} — ${esc(BLOCK_INFO[b].where)}</span>
        <strong>${fmtDur(x.planned * 3600)} / ${fmtDur(x.cap * 3600)}</strong>
        <span class="small muted">${fmtDur(x.done * 3600)} completed</span></div>`;
    }).join('')}`;

  const closed = day.kind === 'trip' || day.kind === 'off';
  $('#dayBlocks').innerHTML = BLOCKS.map((b) => blockSectionHTML(day, b, 'day')).join('');
  $('#dayBlocks').classList.toggle('closed', closed);
}
