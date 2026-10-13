import { state } from '../store.js';
import { esc, fmtHours, fmtTime } from '../utils.js';
import { $ } from './dom.js';

export function renderAudit() {
  const by = {};
  state.tasks.filter((t) => !t.generated).forEach((t) => {
    const x = (by[t.subject] ??= { count: 0, missing: 0, approx: 0, provided: 0, placeholder: 0, seconds: 0 });
    x.count++;
    x.seconds += t.durationSec;
    if (t.status === 'estimated_missing') x.missing++;
    else if (t.status === 'approximate') x.approx++;
    else if (t.status === 'verified_total_only') x.placeholder++;
    else x.provided++;
  });
  $('#dataCards').innerHTML = Object.entries(by).map(([s, x]) => `<div class="card" role="listitem">
    <div class="metric-label">${esc(s)}</div><div class="metric">${x.count}</div>
    <div class="metric-note">${x.provided} supplied · ${x.approx} approximate · ${x.missing} missing-duration estimates${x.placeholder ? ` · ${x.placeholder} total-only placeholder` : ''}</div>
    <div class="small muted" style="margin-top:6px">Runtime shown: ${fmtHours(x.seconds)}</div></div>`).join('');

  const unresolved = state.tasks.filter((t) => ['estimated_missing', 'approximate', 'verified_total_only'].includes(t.status));
  $('#estimatedList').innerHTML = unresolved.length
    ? unresolved.map((t) => `<div class="task" style="grid-template-columns:minmax(0,1fr) auto">
        <div><div class="task-title">${esc(t.title)}</div>
        <div class="task-meta">${esc(t.subject)} · ${t.status === 'estimated_missing' ? '20-minute placeholder' : t.status === 'approximate' ? 'Approximate source duration' : 'Verified total; title-level entries not imported'}</div></div>
        <span class="tag estimated">${fmtTime(t.durationSec)}</span></div>`).join('')
    : '<div class="empty">No estimated or unresolved entries.</div>';
}
