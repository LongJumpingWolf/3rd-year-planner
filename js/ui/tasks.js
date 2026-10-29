import { BLOCK_INFO, blockOf, intensityOf, isEstimated, isSchedulable, taskPlannedSec } from '../planner.js';
import { state } from '../store.js';
import { esc, fmtDate, fmtTime } from '../utils.js';
import { $, actionAttrs } from './dom.js';

/** Ids ticked for bulk scheduling. Lives outside `state` so it never gets saved. */
export const selection = new Set();

/** The library lists lectures and custom items; generated planning blocks are managed on the calendar. */
const libraryTasks = () => state.tasks.filter((t) => !t.generated);

export function filteredTasks() {
  const q = $('#searchTask').value.trim().toLowerCase();
  const sub = $('#subjectFilter').value;
  const cat = $('#categoryFilter').value;
  const status = $('#statusFilter').value;
  return libraryTasks().filter((t) => {
    if (q && !(t.title.toLowerCase().includes(q) || t.category.toLowerCase().includes(q) || t.subject.toLowerCase().includes(q))) return false;
    if (sub && t.subject !== sub) return false;
    if (cat && t.category !== cat) return false;
    switch (status) {
      case 'todo': return !t.done;
      case 'done': return t.done;
      case 'estimated': return isEstimated(t);
      case 'scheduled': return !!t.scheduledDate;
      case 'unscheduled': return !t.scheduledDate && !t.done;
      default: return true;
    }
  });
}

function fillSelect(sel, label, values) {
  const old = sel.value;
  sel.innerHTML = `<option value="">${label}</option>` + values.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
  sel.value = values.includes(old) ? old : '';
}

export function renderTasks() {
  const sf = $('#subjectFilter');
  const cf = $('#categoryFilter');
  fillSelect(sf, 'All subjects', [...new Set(libraryTasks().map((t) => t.subject))].sort());
  const pool = sf.value ? libraryTasks().filter((t) => t.subject === sf.value) : libraryTasks();
  fillSelect(cf, 'All categories', [...new Set(pool.map((t) => t.category))].sort());

  // Drop selections for tasks that no longer exist.
  const ids = new Set(state.tasks.map((t) => t.id));
  [...selection].forEach((id) => { if (!ids.has(id)) selection.delete(id); });

  const asleepSet = new Set(state.planConfig.asleep || []);
  const arr = filteredTasks();
  $('#taskCount').textContent = `Showing ${arr.length} of ${libraryTasks().length} entries`;
  $('#taskTable').innerHTML = arr.map((t) => `<tr class="${t.done ? 'is-done' : ''}">
    <td class="narrow"><input type="checkbox" data-select="${esc(t.id)}" ${selection.has(t.id) ? 'checked' : ''} aria-label="Select ${esc(t.title)}"></td>
    <td><strong>${esc(t.subject)}</strong><br><span class="muted small">${esc(t.category)}</span></td>
    <td>${esc(t.title)}${t.partCount ? ` <span class="tag">Part ${t.partIndex}/${t.partCount}</span>` : ''}${t.status === 'estimated_missing' ? '<br><span class="tag estimated">20 min estimate</span>' : t.status === 'approximate' ? '<br><span class="tag estimated">Approximate</span>' : t.status === 'verified_total_only' ? '<br><span class="tag verified">Verified total only</span>' : ''}</td>
    <td>${intensityOf(t) === 'light' ? 'Light' : 'Deep'}</td>
    <td>${fmtTime(t.durationSec)}</td>
    <td>${fmtTime(taskPlannedSec(t, state.settings))}</td>
    <td>${t.scheduledDate ? `${esc(fmtDate(t.scheduledDate, { day: 'numeric', month: 'short', year: 'numeric' }))}<br><span class="muted small">${esc(BLOCK_INFO[blockOf(t)].name)}</span>` : '<span class="muted">—</span>'}</td>
    <td>${t.done ? '<span class="tag done">Done</span>' : asleepSet.has(t.subject) ? '<span class="tag">Asleep</span>' : '<span class="tag">To do</span>'}</td>
    <td><div class="row">
      <button type="button" class="small" ${actionAttrs('toggle-btn', t.id, 'tbl')} aria-label="${t.done ? 'Undo' : 'Done'}: ${esc(t.title)}">${t.done ? 'Undo' : 'Done'}</button>
      ${t.generated ? '' : `<button type="button" class="small" ${actionAttrs('move', t.id, 'tbl')} aria-label="Move: ${esc(t.title)}">Move</button>
      <button type="button" class="small" ${actionAttrs('edit', t.id, 'tbl')} aria-label="Edit: ${esc(t.title)}">Edit</button>
      ${t.scheduledDate && !t.done ? `<button type="button" class="small" ${actionAttrs('replace', t.id, 'tbl')} aria-label="Replace scheduled task: ${esc(t.title)}">Replace</button>` : ''}
      ${t.scheduledDate && !t.done ? `<button type="button" class="small" ${actionAttrs('quick-push', t.id, 'tbl')} aria-label="Quick-push forward: ${esc(t.title)}">Quick push →</button>` : ''}
      ${t.status === 'custom_estimate' ? `<button type="button" class="small danger-text" ${actionAttrs('delete-task', t.id, 'tbl')} aria-label="Remove added task: ${esc(t.title)}">Remove</button>` : ''}`}
      ${isSchedulable(t) && !t.done && !t.parentId ? `<button type="button" class="small" ${actionAttrs('split', t.id, 'tbl')} aria-label="Split: ${esc(t.title)}">Split</button>` : ''}
    </div></td></tr>`).join('') || '<tr><td colspan="9"><div class="empty">No matching entries. Try clearing a filter.</div></td></tr>';
  updateSelectionUI(arr);
}

export function updateSelectionUI(arr = filteredTasks()) {
  const n = selection.size;
  $('#selCount').textContent = n ? `${n} selected` : '';
  $('#bulkScheduleBtn').disabled = n === 0;
  const all = $('#selectAll');
  const shown = arr.filter((t) => selection.has(t.id)).length;
  all.checked = arr.length > 0 && shown === arr.length;
  all.indeterminate = shown > 0 && shown < arr.length;
}
