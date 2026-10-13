// Shared markup for a task row used in the backlog list.
import { BLOCK_INFO, intensityOf, isEstimated, isSchedulable, taskPlannedSec } from '../planner.js';
import { state } from '../store.js';
import { esc, fmtDur } from '../utils.js';
import { actionAttrs } from './dom.js';

export function taskCardHTML(t, ctx = 'list', { reason } = {}) {
  const planned = fmtDur(taskPlannedSec(t, state.settings));
  const label = `${t.title}${t.partCount ? ` (part ${t.partIndex} of ${t.partCount})` : ''}`;
  const kind = intensityOf(t) === 'light' ? BLOCK_INFO.light : BLOCK_INFO.focus;
  const back = ctx === 'back';
  return `<div class="task ${t.done ? 'done' : ''}">
    <input type="checkbox" ${t.done ? 'checked' : ''} ${actionAttrs('toggle', t.id, ctx)} aria-label="${esc(label)} — mark complete">
    <div><div class="task-title">${esc(t.title)}</div>
      <div class="task-meta">${esc(t.subject)} · ${esc(t.category)} · ${fmtDur(t.durationSec)} runtime · ${planned} study time · ${esc(kind.name)}${t.partCount ? ` · part ${t.partIndex}/${t.partCount}` : ''}</div>
      ${reason ? `<div class="task-meta reason">Why it is here: ${esc(reason)}</div>` : ''}</div>
    <div class="task-actions">${isEstimated(t) ? '<span class="tag estimated">Estimated</span>' : ''}
      ${back ? `<button type="button" class="small primary" ${actionAttrs('auto-place', t.id, ctx)} aria-label="Next free slot: ${esc(label)}">Next free slot</button>` : ''}
      <button type="button" class="small" ${actionAttrs('move', t.id, ctx)} aria-label="Move: ${esc(label)}">Move</button>
      <button type="button" class="small" ${actionAttrs('edit', t.id, ctx)} aria-label="Edit: ${esc(label)}">Edit</button>
      ${back && isSchedulable(t) && !t.parentId && !t.done ? `<button type="button" class="small" ${actionAttrs('split', t.id, ctx)} aria-label="Split: ${esc(label)}">Split</button>` : ''}</div>
  </div>`;
}
