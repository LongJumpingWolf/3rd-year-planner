// Daily view: today's committed plan plus a separate, optional use of spare capacity.
import { BLOCKS, BLOCK_INFO, blockOf, dayStats, isCompatible, isSchedulable, recommendedBlock, taskPlannedSec } from '../planner.js';
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

function recommendationHTML(iso, day) {
  const panel = $('#dayRecommendations');
  if (day.kind === 'trip' || day.kind === 'off') { panel.hidden = true; panel.innerHTML = ''; return; }

  const free = { light: day.blocks.light.free, focus: day.blocks.focus.free };
  const asleep = new Set(state.planConfig.asleep || []);
  const candidates = state.tasks
    .filter((t) => t.scheduledDate && t.scheduledDate > iso && !t.done && !t.generated && isSchedulable(t) && !asleep.has(t.subject))
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate) || (Number(a.seq) || 0) - (Number(b.seq) || 0));
  const suggestions = [];
  for (const task of candidates) {
    if (suggestions.length >= 3) break;
    const seconds = taskPlannedSec(task, state.settings);
    const hours = seconds / 3600;
    const preferred = recommendedBlock(task);
    const options = preferred === 'light' ? ['light', 'focus'] : ['focus'];
    const block = options.find((b) => isCompatible(task, b) && free[b] + 1e-6 >= hours);
    if (!block) continue;
    free[block] -= hours;
    suggestions.push({ task, block, hours, seconds });
  }

  if (!suggestions.length) { panel.hidden = true; panel.innerHTML = ''; return; }
  panel.hidden = false;
  const freeBefore = { light: day.blocks.light.free, focus: day.blocks.focus.free };
  panel.innerHTML = `
    <div class="recommendations-head">
      <div><p class="eyebrow">OPTIONAL · NOT IN YOUR PLAN</p><h3 id="h-recommendations">Use some spare time?</h3>
      <p class="small muted">These upcoming tasks fit the remaining capacity. They are suggestions only: today's workload and the future schedule stay unchanged unless you add one.</p></div>
      <div class="recommendation-capacity"><span class="small muted">Spare today</span><strong>${fmtDur((freeBefore.light + freeBefore.focus) * 3600)}</strong></div>
    </div>
    <ul class="recommendation-list">${suggestions.map(({ task, block, seconds }) => `
      <li class="recommendation-item">
        <div class="recommendation-main"><span class="recommendation-subject">${esc(task.subject)}</span><strong>${esc(task.title)}</strong>
          <span class="small muted">${fmtDur(seconds)} · originally ${esc(fmtDate(task.scheduledDate, { weekday: 'short', day: 'numeric', month: 'short' }))} · ${esc(BLOCK_INFO[block].name)}</span></div>
        <button type="button" class="recommendation-accept" data-action="accept-recommendation" data-id="${esc(task.id)}" data-date="${esc(iso)}" data-block="${esc(block)}">Add to today</button>
      </li>`).join('')}</ul>`;
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
        <span class="small muted">${fmtDur(x.done * 3600)} completed · ${fmtDur(x.free * 3600)} free</span></div>`;
    }).join('')}`;

  const notes = state.extras[iso] || [];
  $('#extraList').innerHTML = notes.map((n, i) => `<li><span>${esc(n)}</span>
    <button type="button" class="link-btn" data-action="remove-extra" data-id="${iso}:${i}" aria-label="Remove note: ${esc(n)}">Remove</button></li>`).join('');

  const closed = day.kind === 'trip' || day.kind === 'off';
  $('#dayBlocks').innerHTML = BLOCKS.map((b) => blockSectionHTML(day, b, 'day')).join('');
  $('#dayBlocks').classList.toggle('closed', closed);
  recommendationHTML(iso, day);
}
