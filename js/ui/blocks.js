// Markup for the two work blocks of a day. Used by the Daily view, the Weekly view and the Dashboard.
import { BLOCK_INFO, fmtClock, isEstimated, isSchedulable, latestEndMin, taskPlannedSec } from '../planner.js';
import { state } from '../store.js';
import { esc, fmtDur } from '../utils.js';
import { actionAttrs } from './dom.js';

/** One short status phrase per block: never relies on colour alone. */
export function blockStatus(b) {
  if (b.cap === 0 && b.planned === 0) return { cls: 'none', text: 'No time available' };
  if (b.over > 0.001) return { cls: 'over', text: `Over by ${fmtDur(b.over * 3600)}` };
  if (b.planned === 0) return { cls: 'free', text: `Nothing planned · ${fmtDur(b.cap * 3600)} free` };
  if (b.free > 0.01) return { cls: 'free', text: `${fmtDur(b.free * 3600)} unused` };
  return { cls: 'full', text: 'Fully planned' };
}

function tagsFor(t) {
  const tags = [];
  if (t.generated) tags.push('<span class="tag">Auto</span>');
  if (isEstimated(t)) tags.push('<span class="tag estimated">Estimated</span>');
  if (t.partCount) tags.push(`<span class="tag">Part ${t.partIndex}/${t.partCount}</span>`);
  if (t.pinned) tags.push('<span class="tag" title="Placed by hand; regenerating the plan keeps it here">Pinned</span>');
  if (t.deadline && t.scheduledDate > t.deadline) tags.push('<span class="tag estimated">After deadline</span>');
  return tags.join(' ');
}

function taskItem(t, ctx, { time, late, actions, mismatch }) {
  const planned = fmtDur(taskPlannedSec(t, state.settings));
  const label = `${t.title}${t.partCount ? ` (part ${t.partIndex} of ${t.partCount})` : ''}`;
  const manage = actions && !t.generated;
  return `<li class="btask ${t.done ? 'done' : ''} ${mismatch ? 'mismatch' : ''}">
    <input type="checkbox" ${t.done ? 'checked' : ''} ${actionAttrs('toggle', t.id, ctx)} aria-label="${esc(label)} — mark complete">
    <div class="btask-main">
      <div class="btask-top"><span class="dt-subject">${esc(t.subject)}</span>${time ? `<span class="clock ${late ? 'late' : ''}">${esc(time)}${late ? ' · past wind-down' : ''}</span>` : ''}</div>
      <div class="btask-title">${esc(t.title)}</div>
      <div class="btask-meta"><span>${planned}</span>${tagsFor(t)}${mismatch ? '<span class="tag estimated">Deep work in light block</span>' : ''}</div>
    </div>
    ${manage ? `<div class="btask-actions">
      <button type="button" class="small" ${actionAttrs('move', t.id, ctx)} aria-label="Move: ${esc(label)}">Move</button>
      <button type="button" class="small" ${actionAttrs('edit', t.id, ctx)} aria-label="Edit: ${esc(label)}">Edit</button>
      ${isSchedulable(t) && !t.done && !t.parentId ? `<button type="button" class="small" ${actionAttrs('split', t.id, ctx)} aria-label="Split: ${esc(label)}">Split</button>` : ''}
    </div>` : ''}
  </li>`;
}

/** Full block section for the Daily view and Dashboard. */
export function blockSectionHTML(day, block, ctx, { headingLevel = 3, actions = true } = {}) {
  const b = day.blocks[block];
  const info = BLOCK_INFO[block];
  const st = blockStatus(b);
  const hid = `bh-${ctx}-${day.iso}-${block}`;
  const pct = b.planned > 0 ? Math.min(100, Math.round((b.done / b.planned) * 100)) : 0;
  const items = b.tasks.map((t, i) => {
    const c = b.clock?.[i];
    return taskItem(t, ctx, { time: c ? `${fmtClock(c.start)} – ${fmtClock(c.end)}` : '', late: c?.late, actions, mismatch: b.mismatched.includes(t) });
  }).join('');
  const closed = day.kind === 'trip' || day.kind === 'off';
  return `<section class="block block-${block}" aria-labelledby="${hid}">
    <div class="block-head">
      <h${headingLevel} id="${hid}">${esc(info.name.toUpperCase())} — ${esc(info.where.toUpperCase())}</h${headingLevel}>
      <span class="status ${st.cls}">${st.cls === 'over' ? '⚠ ' : ''}${esc(st.text)}</span>
    </div>
    <p class="block-totals"><strong>${fmtDur(b.planned * 3600)} / ${fmtDur(b.cap * 3600)}</strong> planned · <strong>${fmtDur(b.done * 3600)}</strong> completed</p>
    <div class="progress" role="progressbar" aria-label="${esc(info.name)} completed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
    ${b.pastBedtime ? `<p class="error-text">⚠ Some focused work would end after ${fmtClock(latestEndMin(state.settings))}. Move or shorten a task so you finish before bedtime.</p>` : ''}
    ${items ? `<ul class="btasks">${items}</ul>` : `<p class="empty small">${closed ? esc(day.note) : block === 'light' ? 'No light-work tasks planned. Add short revision, MCQs or recall here.' : 'No focused-work tasks planned.'}</p>`}
    ${actions && !closed ? `<div class="row actions">
      <button type="button" class="small" ${actionAttrs('add-to-date', day.iso, `${ctx}-${block}`)} data-block="${block}" aria-label="+ Add task to ${esc(info.name.toLowerCase())}">+ Add task</button>
      ${b.over > 0.001 ? `<button type="button" class="small" ${actionAttrs('fix-overflow', day.iso, `${ctx}-${block}`)} data-block="${block}" aria-label="Move overflow out of ${esc(info.name.toLowerCase())}">Move overflow to next free slot</button>` : ''}
    </div>` : ''}
  </section>`;
}

/** Compact block for the Weekly view cards: title, totals, and a short checklist. */
export function compactBlockHTML(day, block) {
  const b = day.blocks[block];
  const info = BLOCK_INFO[block];
  const st = blockStatus(b);
  const items = b.tasks.map((t) => `<li class="ctask ${t.done ? 'done' : ''}">
      <input type="checkbox" ${t.done ? 'checked' : ''} ${actionAttrs('toggle', t.id, `wk-${block}`)} aria-label="${esc(t.title)} — mark complete">
      <span class="ctask-text"><span class="dt-subject">${esc(t.subject)}</span> ${esc(t.title)}</span>
      <span class="ctask-dur">${fmtDur(taskPlannedSec(t, state.settings))}</span></li>`).join('');
  return `<div class="cblock cblock-${block}">
    <h4>${esc(info.name)} <span class="where">— ${esc(info.where)}</span></h4>
    <div class="cblock-totals"><strong>${fmtDur(b.planned * 3600)} / ${fmtDur(b.cap * 3600)}</strong> <span class="status ${st.cls}">${st.cls === 'over' ? '⚠ ' : ''}${esc(st.text)}</span></div>
    ${items ? `<ul class="clist">${items}</ul>` : '<p class="muted small">No tasks</p>'}
  </div>`;
}
