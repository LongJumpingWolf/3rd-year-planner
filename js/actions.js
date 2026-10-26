// User-level operations that change state. Each one validates input, commits, and tells the user what happened.
// The light / focused distinction is preserved by delegating to taskOps.js and planner.js.
import {
  BLOCK_INFO, blockOf, dayStats, generatePlan, intensityOf, isCompatible, isSchedulable, isVideo, lectureKey, recommendedBlock,
  simulate, taskPlannedSec, validatePlanConfig, validateSettingsTimes, weekdayCapacity,
} from './planner.js';
import { assignTask, autoPlaceTask, fixOverflow, reclassifyTask, setDayException, setDuration, splitInState, unscheduleTask } from './taskOps.js';
import { clearSaved, commit, EXTRA_MAX_LEN, EXTRA_MAX_PER_DAY, findTask, freshState, newId, persist, replaceState, sanitizeState, state, SCHEMA_VERSION } from './store.js';
import { dateISO, esc, fmtDate, fmtHours, isValidISO, num, parseCSV, toCSV } from './utils.js';
import { plannerCSV } from './exportPlan.js';
import { confirmDialog, openDialog } from './ui/dialogs.js';
import { downloadText, readFileText } from './ui/dom.js';
import { toast } from './ui/toast.js';

export const todayISO = () => dateISO(new Date());
const blockName = (b) => `${BLOCK_INFO[b].name} — ${BLOCK_INFO[b].where}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Run a state change, commit, and offer one-click Undo (restores the whole state from a snapshot). */
function withUndo(fn) {
  const snap = JSON.stringify(state);
  const out = fn(); // returns { message, type } describing what happened
  commit();
  toast(out.message, {
    type: out.type || 'ok', ms: 9000,
    action: { label: 'Undo', run: () => { replaceState(JSON.parse(snap)); commit(); toast('Undone.'); } },
  });
}

/** Warn (never block) when a placement leaves a day or block over capacity, or lands on a blocked day. */
function warnAfterPlacement(iso, block) {
  const s = dayStats(state.tasks, iso, state.planConfig, state.settings);
  if (s.kind === 'trip' || s.kind === 'off') {
    toast(`${fmtDate(iso)} is ${s.kind === 'trip' ? 'inside your trip window' : 'marked unavailable'}.`, { type: 'warn' });
    return;
  }
  const b = s.blocks[block];
  if (b.over > 0.001) {
    toast(`${BLOCK_INFO[block].name} on ${fmtDate(iso)} is now ${fmtHours(b.over * 3600)} over its ${fmtHours(b.cap * 3600)} capacity.`, { type: 'warn', ms: 7000 });
  } else if (b.pastBedtime) {
    toast(`Focused work on ${fmtDate(iso)} would run past your wind-down time. Move something or shorten it.`, { type: 'warn', ms: 7000 });
  }
}

const blockRadios = (name, current) => `<fieldset class="field"><legend>Work block</legend>
  ${['light', 'focus'].map((b) => `<label class="radio"><input type="radio" name="${name}" value="${b}" ${b === current ? 'checked' : ''}> <span><strong>${BLOCK_INFO[b].name}</strong> — ${BLOCK_INFO[b].where}</span></label>`).join('')}</fieldset>`;

export function toggleDone(id, val) {
  const t = findTask(id);
  if (!t) return;
  const setDone = (v) => {
    t.done = v;
    if (v) t.doneAt = todayISO(); else delete t.doneAt;
  };
  const prev = { done: t.done, doneAt: t.doneAt };
  setDone(typeof val === 'boolean' ? val : !t.done);
  commit();
  toast(t.done ? `Marked done: ${t.title}` : `Marked not done: ${t.title}`, {
    action: { label: 'Undo', run: () => { t.done = prev.done; if (prev.doneAt) t.doneAt = prev.doneAt; else delete t.doneAt; commit(); } },
  });
}

// ---- day notes shown on the viewer link ------------------------------------------------------------

/** Returns an error string, or '' when the note was added. */
export function addExtra(iso, text) {
  const t = String(text ?? '').trim();
  if (!isValidISO(iso)) return 'Pick a valid day first.';
  if (!t) return 'Type what you did first.';
  if (t.length > EXTRA_MAX_LEN) return `Keep it under ${EXTRA_MAX_LEN} characters.`;
  const list = state.extras[iso] || [];
  if (list.length >= EXTRA_MAX_PER_DAY) return `You can add up to ${EXTRA_MAX_PER_DAY} notes per day.`;
  state.extras[iso] = [...list, t];
  commit();
  return '';
}

export function removeExtra(iso, index) {
  const list = state.extras[iso];
  if (!list || !list[index]) return;
  const removed = list[index];
  const next = list.filter((_, i) => i !== index);
  if (next.length) state.extras[iso] = next; else delete state.extras[iso];
  commit();
  toast('Note removed.', {
    action: { label: 'Undo', run: () => { const cur = state.extras[iso] || []; cur.splice(Math.min(index, cur.length), 0, removed); state.extras[iso] = cur; commit(); } },
  });
}

// ---- move / edit / split / reclassify ----------------------------------------------------------

export async function moveTask(id) {
  const t = findTask(id);
  if (!t || t.generated) return;
  const deep = intensityOf(t) === 'deep';
  const current = blockOf(t);
  const startDate = t.scheduledDate || document.getElementById('focusDate')?.value || todayISO();
  const result = await openDialog({
    title: 'Move task',
    body: `<p class="task-title">${esc(t.title)}</p>
      <div class="field"><label for="mv-date">New date</label>
      <input id="mv-date" name="date" type="date" value="${esc(startDate)}">
      <span class="hint">Clear the date to take it off the calendar and put it in the backlog.</span></div>
      ${blockRadios('block', t.scheduledDate ? current : recommendedBlock(t))}
      ${deep ? `<label class="check" id="mv-override-wrap" hidden><input type="checkbox" name="override" id="mv-override"> <span>Place this deep-work task in light work anyway</span></label>` : ''}
      <p class="hint" id="mv-hint">${deep ? 'Deep work (lectures, new concepts) belongs in Focused work.' : 'Light work fits either block.'}</p>`,
    submitLabel: 'Save',
    onOpen(form) {
      const wrap = form.querySelector('#mv-override-wrap');
      if (!wrap) return;
      const sync = () => { wrap.hidden = form.elements.block.value !== 'light'; };
      form.addEventListener('change', sync);
      sync();
    },
    onSubmit: ({ date, block, override }) => {
      if (date && !isValidISO(date)) return 'Please enter a valid date.';
      if (date && deep && block === 'light' && !override) return 'This is deep work, so it is recommended for Focused work — home / evening. Choose Focused, or tick "Place this deep-work task in light work anyway".';
      return { date, block, override: !!override };
    },
  });
  if (!result || result === true) return;
  if (!result.date) {
    unscheduleTask(state, id);
    commit();
    toast('Removed from the calendar and added to the backlog.');
    return;
  }
  const r = assignTask(state, id, result.date, result.block, { override: result.override });
  if (r.error) { toast(r.error, { type: 'error' }); return; }
  commit();
  toast(`Moved to ${BLOCK_INFO[result.block].name.toLowerCase()} on ${fmtDate(result.date)}${r.override ? ' (override)' : ''}.`);
  warnAfterPlacement(result.date, result.block);
}

export async function editTask(id) {
  const t = findTask(id);
  if (!t || t.generated) return;
  const result = await openDialog({
    title: 'Edit task',
    body: `<p class="task-title">${esc(t.title)}</p>
      <div class="field"><label for="ed-min">Runtime (minutes)</label><input id="ed-min" name="min" type="number" min="1" max="1000" step="1" value="${Math.round(t.durationSec / 60)}">
        <span class="hint">${t.type === 'custom' ? 'Counted as literal study time.' : 'Study time adds annotation and recall overhead.'}</span></div>
      <div class="field"><label for="ed-int">Type of work</label><select id="ed-int" name="intensity">
        <option value="deep" ${intensityOf(t) === 'deep' ? 'selected' : ''}>Deep — lectures, difficult concepts (Focused work)</option>
        <option value="light" ${intensityOf(t) === 'light' ? 'selected' : ''}>Light — revision, MCQs, recall (College gaps)</option></select></div>
      <div class="field"><label for="ed-dl">Deadline (optional)</label><input id="ed-dl" name="deadline" type="date" value="${esc(t.deadline || '')}"></div>
      <div class="field"><label for="ed-pr">Priority (higher is scheduled first)</label><input id="ed-pr" name="priority" type="number" min="-5" max="5" step="1" value="${Number(t.priority) || 0}"></div>
      ${t.scheduledDate ? '<label class="check"><input type="checkbox" name="move"> <span>If the type no longer matches its block, move it to the next suitable slot</span></label>' : ''}`,
    submitLabel: 'Save changes',
    onSubmit: ({ min, deadline, priority, intensity, move }) => {
      const m = Number(min);
      if (!Number.isFinite(m) || m < 1 || m > 1000) return 'Runtime must be between 1 and 1000 minutes.';
      if (deadline && !isValidISO(deadline)) return 'Please enter a valid deadline.';
      return { m, deadline, priority: num(priority, 0), intensity, move: !!move };
    },
  });
  if (!result || result === true) return;
  setDuration(state, id, result.m);
  t.deadline = result.deadline || undefined;
  t.priority = result.priority || undefined;
  const r = reclassifyTask(state, id, result.intensity, { moveToSuitable: result.move });
  commit();
  if (r.mismatch) {
    toast(`"${t.title}" is deep work but still sits in light work. Move it to Focused work?`, {
      type: 'warn', ms: 10000,
      action: { label: 'Move to focused', run: () => { const x = autoPlaceTask(state, id, { from: t.scheduledDate, block: 'focus' }); commit(); toast(x.ok ? `Moved to ${fmtDate(x.iso)}.` : x.error, { type: x.ok ? 'ok' : 'error' }); } },
    });
  } else {
    toast('Task updated.');
  }
}

export async function splitTaskAction(id) {
  const t = findTask(id);
  if (!t || t.generated) return;
  const mins = Math.round(taskPlannedSec(t, state.settings) / 60);
  const result = await openDialog({
    title: 'Split into sessions',
    body: `<p class="task-title">${esc(t.title)}</p>
      <p>Needs about ${mins} min of study time.</p>
      <div class="field"><label for="sp-n">Number of sessions</label><input id="sp-n" name="n" type="number" min="2" max="8" step="1" value="2">
        <span class="hint" id="sp-hint"></span></div>
      <p class="hint">${t.scheduledDate ? 'The extra sessions are placed in the next free slots of the same block.' : 'The sessions wait in the backlog until you place them or regenerate the plan.'}</p>`,
    submitLabel: 'Split',
    onOpen(form) {
      const n = form.querySelector('#sp-n');
      const hint = form.querySelector('#sp-hint');
      const upd = () => { const k = Math.round(Number(n.value)); hint.textContent = k >= 2 ? `About ${Math.round(mins / k)} min each.` : ''; };
      n.addEventListener('input', upd);
      upd();
    },
    onSubmit: ({ n }) => ((Number(n) >= 2 && Number(n) <= 8) ? { n: Number(n) } : 'Choose between 2 and 8 sessions.'),
  });
  if (!result || result === true) return;
  withUndo(() => {
    const res = splitInState(state, id, result.n);
    if (res.error) return { message: res.error, type: 'error' };
    return {
      message: `Split into ${result.n} sessions${res.unplaced.length ? `; ${plural(res.unplaced.length, 'session')} had no free slot and ${res.unplaced.length === 1 ? 'is' : 'are'} in the backlog` : ''}.`,
      type: res.unplaced.length ? 'warn' : 'ok',
    };
  });
}

export function autoPlaceAction(id) {
  const t = findTask(id);
  if (!t) return;
  const r = autoPlaceTask(state, id, { from: [todayISO(), state.planConfig.start].sort().at(-1) });
  if (r.error) { toast(r.error, { type: 'error', ms: 9000 }); return; }
  commit();
  toast(`Placed in ${BLOCK_INFO[r.block].name.toLowerCase()} on ${fmtDate(r.iso)}${r.beyondBackstop ? ' — after your hard backstop' : ''}.`, { type: r.beyondBackstop ? 'warn' : 'ok' });
}

export function fixOverflowAction(iso, block) {
  withUndo(() => {
    const res = fixOverflow(state, iso, block);
    return {
      message: res.moved.length
        ? `Moved ${plural(res.moved.length, 'task')} from ${BLOCK_INFO[block].name.toLowerCase()} to the next free slots.${res.stillOver ? ' The remaining overload comes from fixed planning blocks.' : ''}`
        : 'Nothing could be moved — the overload comes from fixed planning blocks. Change the capacity for this day or rebuild the plan.',
      type: res.moved.length && !res.stillOver ? 'ok' : 'warn',
    };
  });
}

export async function dayDialog(iso) {
  const ex = state.planConfig.exceptions?.[iso] || {};
  const s = dayStats(state.tasks, iso, { ...state.planConfig, exceptions: {} }, state.settings);
  const result = await openDialog({
    title: `Day settings — ${fmtDate(iso, { weekday: 'long', day: 'numeric', month: 'long' })}`,
    body: `<label class="check"><input type="checkbox" name="unavailable" ${ex.unavailable ? 'checked' : ''}> <span>Mark this day unavailable (no study; open tasks move to the next free slots)</span></label>
      <div class="form-grid two">
        <div class="field"><label for="dy-l">Light work hours</label><input id="dy-l" name="light" type="number" min="0" max="16" step="0.25" placeholder="${s.blocks.light.cap}" value="${ex.light ?? ''}"></div>
        <div class="field"><label for="dy-f">Focused work hours</label><input id="dy-f" name="focus" type="number" min="0" max="16" step="0.25" placeholder="${s.blocks.focus.cap}" value="${ex.focus ?? ''}"></div>
      </div>
      <p class="hint">Leave a box empty to use the normal rule (shown in grey). Use this for holidays, unusually busy college days or a free weekend.</p>
      <div class="field"><label for="dy-n">Note (optional)</label><input id="dy-n" name="note" maxlength="120" value="${esc(ex.note || '')}"></div>
      ${Object.keys(ex).length ? '<label class="check"><input type="checkbox" name="reset"> <span>Restore the normal rules for this day</span></label>' : ''}`,
    submitLabel: 'Save day',
    onSubmit: ({ light, focus, note, unavailable, reset }) => {
      for (const v of [light, focus]) if (v !== '' && !(Number(v) >= 0 && Number(v) <= 16)) return 'Hours must be between 0 and 16.';
      return { light, focus, note, unavailable: !!unavailable, reset: !!reset };
    },
  });
  if (!result || result === true) return;
  const next = {};
  if (!result.reset) {
    if (result.unavailable) next.unavailable = true;
    if (result.light !== '') next.light = Number(result.light);
    if (result.focus !== '') next.focus = Number(result.focus);
    if (result.note.trim()) next.note = result.note.trim();
  }
  withUndo(() => {
    const out = setDayException(state, iso, next);
    const bits = [];
    if (out.moved.length) bits.push(`moved ${plural(out.moved.length, 'task')} to the next free slots`);
    if (out.stuck.length) bits.push(`${plural(out.stuck.length, 'task')} had no free slot and ${out.stuck.length === 1 ? 'is' : 'are'} in the backlog`);
    if (out.dropped) bits.push(`removed ${plural(out.dropped, 'planning block')} (rebuilt when you regenerate)`);
    return { message: `${fmtDate(iso)} updated${bits.length ? `: ${bits.join('; ')}` : ''}.`, type: out.stuck.length ? 'warn' : 'ok' };
  });
}

export async function addToDate(iso, block = 'focus') {
  const compatible = (t) => isCompatible(t, block);
  const base = () => state.tasks.filter((t) => !t.done && !t.scheduledDate && isSchedulable(t));
  if (!base().length) {
    toast('Every incomplete task is already scheduled.', { type: 'warn' });
    return;
  }
  const row = (t) => `<label><input type="radio" name="pick" value="${esc(t.id)}"><span><strong>${esc(t.subject)}</strong> · ${esc(t.title)}${intensityOf(t) === 'deep' ? '' : ' <span class="tag">Light</span>'}</span></label>`;
  const result = await openDialog({
    title: `Add to ${BLOCK_INFO[block].name.toLowerCase()} — ${fmtDate(iso, { weekday: 'long', day: 'numeric', month: 'long' })}`,
    body: `<div class="field"><label for="pick-q">Search unscheduled tasks</label><input id="pick-q" type="search" autocomplete="off" placeholder="Type part of a title or subject"></div>
      ${block === 'light' ? '<label class="check"><input type="checkbox" name="showAll" id="pick-all"> <span>Also show deep-work lectures (placing one here is an override)</span></label>' : ''}
      <div class="pick-list" role="radiogroup" aria-label="Unscheduled tasks" id="pick-list"></div>
      <p class="hint" id="pick-count" role="status"></p>`,
    submitLabel: 'Add to this block',
    onOpen(form) {
      const q = form.querySelector('#pick-q');
      const all = form.querySelector('#pick-all');
      const list = form.querySelector('#pick-list');
      const count = form.querySelector('#pick-count');
      const refresh = () => {
        const s = q.value.trim().toLowerCase();
        const showAll = !!all?.checked;
        const found = base().filter((t) => (showAll || compatible(t)) && (!s || t.title.toLowerCase().includes(s) || t.subject.toLowerCase().includes(s)));
        list.innerHTML = found.slice(0, 60).map(row).join('') || `<p class="empty">${block === 'light' && !showAll ? 'No light-work tasks are waiting. Add one with “+ Add task” (type: Light), or tick the box above.' : 'No matching tasks.'}</p>`;
        count.textContent = found.length > 60 ? `Showing the first 60 of ${found.length} matches — keep typing to narrow down.` : `${found.length} ${found.length === 1 ? 'match' : 'matches'}`;
        const first = list.querySelector('input');
        if (first) first.checked = true;
      };
      q.addEventListener('input', refresh);
      all?.addEventListener('change', refresh);
      refresh();
    },
    onSubmit: ({ pick }) => (pick ? { pick } : 'Choose a task from the list.'),
  });
  if (!result || result === true) return;
  const t = findTask(result.pick);
  if (!t) return;
  const r = assignTask(state, t.id, iso, block, { override: true });
  commit();
  toast(`Added "${t.title}" to ${BLOCK_INFO[block].name.toLowerCase()} on ${fmtDate(iso)}${r.override ? ' (override: deep work in light block)' : ''}.`, { type: r.override ? 'warn' : 'ok' });
  warnAfterPlacement(iso, block);
}

export async function addTask() {
  const result = await openDialog({
    title: 'Add a task',
    body: `<div class="field"><label for="nt-titles">Task titles</label><textarea id="nt-titles" name="titles" required maxlength="6000" rows="5" placeholder="One task per line — paste a whole list"></textarea><span class="hint">Add up to 30 tasks at once. New subject names are created automatically.</span></div>
      <div class="field"><label for="nt-subject">Subject / new subject</label><input id="nt-subject" name="subject" value="" maxlength="60" placeholder="e.g. Medicine" list="nt-subjects" required>
        <datalist id="nt-subjects">${[...new Set(state.tasks.map((t) => t.subject))].sort().map((s) => `<option value="${esc(s)}">`).join('')}</datalist></div>
      <div class="field"><label for="nt-category">Section / category</label><input id="nt-category" name="category" value="Custom task" maxlength="80" placeholder="e.g. Respiratory medicine"></div>
      <div class="field"><label for="nt-int">Type of work</label><select id="nt-int" name="intensity">
        <option value="deep">Deep — lecture or difficult concept (Focused work)</option>
        <option value="light">Light — revision, MCQs, recall, indexing (College gaps)</option></select></div>
      <div class="field"><label for="nt-min">Estimated time (minutes)</label><input id="nt-min" name="min" type="number" min="1" max="1000" step="1" value="20"></div>`,
    submitLabel: 'Add task',
    onSubmit: ({ titles, subject, category, min, intensity }) => {
      const list = String(titles || '').split(/\\r?\\n/).map((x) => x.trim()).filter(Boolean);
      if (!list.length) return 'Enter at least one task title.';
      if (list.length > 30) return 'Add up to 30 tasks at a time.';
      if (!String(subject || '').trim()) return 'Enter a subject; type a new name if needed.';
      const m = Number(min);
      if (!Number.isFinite(m) || m < 1 || m > 1000) return 'Runtime must be between 1 and 1000 minutes.';
      return { titles: list, subject: subject.trim(), category: category.trim() || 'Custom task', min: m, intensity };
    },
  });
  if (!result || result === true) return;
  const added = result.titles.map((title) => ({
    id: newId(), subject: result.subject, category: result.category, title, intensity: result.intensity,
    durationSec: Math.round(result.min * 60), sourceDuration: `${result.min} min`, status: 'custom_estimate',
    done: false, type: result.intensity === 'light' ? 'custom' : 'video', scheduledDate: null, selected: false,
  }));
  state.tasks.push(...added);
  commit();
  toast(`Added ${plural(added.length, 'task')} for ${result.subject}. Select them and use Schedule selected to place them.`);
}

export async function bulkSchedule(ids) {
  const selected = state.tasks.filter((t) => ids.includes(t.id) && !t.done && !t.generated);
  if (!selected.length) {
    toast('Select one or more incomplete tasks first.', { type: 'warn' });
    return false;
  }
  const hasDeep = selected.some((t) => intensityOf(t) === 'deep');
  const total = selected.reduce((s, t) => s + taskPlannedSec(t, state.settings), 0) / 3600;
  const result = await openDialog({
    title: `Schedule ${plural(selected.length, 'task')}`,
    body: `<p>${total.toFixed(1)} h of study time in total.</p>
      <div class="field"><label for="bk-date">Date</label><input id="bk-date" name="date" type="date" value="${esc(document.getElementById('focusDate')?.value || todayISO())}" required></div>
      <fieldset class="field"><legend>Work block</legend>
        <label class="radio"><input type="radio" name="block" value="auto" checked> <span><strong>Best fit</strong> — each task goes to its recommended block</span></label>
        <label class="radio"><input type="radio" name="block" value="light"> <span><strong>Light work</strong> — College gaps${hasDeep ? ' (deep tasks are skipped)' : ''}</span></label>
        <label class="radio"><input type="radio" name="block" value="focus"> <span><strong>Focused work</strong> — Home / evening</span></label></fieldset>`,
    submitLabel: 'Schedule',
    onSubmit: ({ date, block }) => (isValidISO(date) ? { date, block } : 'Please enter a valid date.'),
  });
  if (!result || result === true) return false;
  let skipped = 0;
  let placed = 0;
  const touched = new Set();
  selected.forEach((t) => {
    const b = result.block === 'auto' ? recommendedBlock(t) : result.block;
    if (!isCompatible(t, b)) { skipped++; return; }
    assignTask(state, t.id, result.date, b);
    touched.add(b);
    placed++;
  });
  commit();
  toast(`Scheduled ${plural(placed, 'task')} on ${fmtDate(result.date)}${skipped ? `; skipped ${plural(skipped, 'deep task')} that cannot go in light work` : ''}.`, { type: skipped ? 'warn' : 'ok' });
  touched.forEach((b) => warnAfterPlacement(result.date, b));
  return placed > 0;
}

export function createBacklogItem(hours) {
  const h = num(hours);
  if (!(h > 0)) {
    toast('Enter more than 0 hours to move before creating a backlog item.', { type: 'error' });
    return;
  }
  const t = {
    id: newId(), subject: 'Backlog', category: 'Rescheduled work', title: `Catch-up from disruption (${h} hours)`,
    durationSec: Math.round(h * 3600), sourceDuration: 'Calculated estimate', status: 'custom_estimate',
    done: false, type: 'custom', scheduledDate: null, selected: false,
  };
  state.tasks.push(t);
  state.backlog.push({ taskId: t.id, reason: 'Created from what-if simulator' });
  commit();
  toast('Backlog item created. Use "Next free slot" on the calendar page to place it.');
}

// ---- planner -----------------------------------------------------------------------------

export function readPlanForm(form) {
  const v = (name) => form.elements[name].value;
  return {
    start: v('start'), end: v('end'), backstop: v('backstop'),
    tripStart: v('tripStart'), tripEnd: v('tripEnd'),
    weekendLight: num(v('weekendLight'), NaN), weekendFocus: num(v('weekendFocus'), NaN),
  };
}

function summarisePlan(res, hasManual) {
  const m = res.meta;
  const parts = [`${m.placed} of ${m.videoCount} lectures placed`];
  if (m.splitLectures) parts.push(`${plural(m.splitLectures, 'lecture')} split into sessions`);
  let msg = `Plan generated: ${parts.join(', ')}${hasManual ? ' (your manual moves were kept)' : ''}.`;
  if (res.backlog.length) {
    msg += ` ${plural(res.backlog.length, 'task')} did not fit (${m.overflow.focus} focused, ${m.overflow.light} light) — see the backlog for options.`;
  }
  return msg;
}

export async function runGenerate(formValues, { silent = false, undoable = true } = {}) {
  const cfg = { ...state.planConfig, ...formValues };
  const error = validatePlanConfig(cfg);
  if (error) return { error };
  const hasManual = state.tasks.some((t) => t.pinned && !t.done);
  const res = generatePlan(state.tasks, cfg, state.settings, new Date(), { today: todayISO() });
  if (res.error) return { error: res.error };
  const snap = JSON.stringify(state);
  recordMisses();
  state.planConfig = cfg;
  state.tasks = res.tasks;
  state.backlog = res.backlog;
  state.planMeta = res.meta;
  state.version = SCHEMA_VERSION;
  commit();
  if (!silent) {
    toast(summarisePlan(res, hasManual), {
      type: res.backlog.length ? 'warn' : 'ok', ms: 9000,
      action: undoable ? { label: 'Undo', run: () => { replaceState(JSON.parse(snap)); commit(); toast('Previous plan restored.'); } } : undefined,
    });
  }
  return { ok: true };
}

/** Before a rebuild moves open lectures off past days, remember how many were planned on each of those days. */
function recordMisses() {
  state.missedLectures = { ...(state.missedLectures || {}) };
  for (const t of overdueLectures()) state.missedLectures[t.scheduledDate] = (state.missedLectures[t.scheduledDate] || 0) + 1;
}

/** Save the owner's WhatsApp number for the viewer's Notify button. Returns an error string, or '' when saved. */
export function setViewerPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits && (digits.length < 8 || digits.length > 15)) return 'Enter the number with country code, 8 to 15 digits (for example 919876543210).';
  if (digits === (state.viewer?.phone || '')) return '';
  state.viewer = { phone: digits };
  commit();
  toast(digits ? 'WhatsApp number saved. Your viewer\'s Notify button will message it.' : 'WhatsApp number removed. Your viewer will pick your contact themselves.');
  return '';
}

/** Open, non-paused lectures that were planned for a day that is already over (and are not pinned, so a rebuild can move them). */
export function overdueLectures(tasks = state.tasks, planConfig = state.planConfig, today = todayISO()) {
  const asleep = new Set(planConfig.asleep || []);
  return tasks.filter((t) => isVideo(t) && !t.done && !t.pinned && !asleep.has(t.subject) && t.scheduledDate && t.scheduledDate < today);
}

/** Re-spread everything still open over the days that are left, so missed days are made up evenly instead of piling up. */
export async function respreadFromToday() {
  const n = new Set(overdueLectures().map(lectureKey)).size;
  const before = JSON.stringify(state);
  const res = await runGenerate({}, { silent: true });
  if (res.error) { toast(res.error, { type: 'error', ms: 8000 }); return res; }
  lastPlanSnapshot = before;
  const m = state.planMeta;
  toast(`Plan re-spread from today${n ? `: ${n} missed lecture${n === 1 ? ' was' : 's were'} moved forward` : ''}. ${m.feasible ? 'Everything still fits by the target.' : 'Not everything fits by the target; see the Plan tuner.'}`, {
    type: m.feasible ? 'ok' : 'warn', ms: 9000,
    action: { label: 'Undo', run: () => undoLastPlan() },
  });
  return res;
}

let lastPlanSnapshot = null;
export function undoLastPlan() {
  if (!lastPlanSnapshot) return;
  replaceState(JSON.parse(lastPlanSnapshot));
  lastPlanSnapshot = null;
  commit();
  toast('Previous plan restored.');
}

/**
 * Apply the Plan tuner: study order (phases), parked subjects, weekday focused hours and the finish date, then rebuild.
 * Returns { error } or { ok, meta }.
 */
export async function applyPlanTuner({ groups, asleep, studyHours, end }) {
  const today = todayISO();
  if (!isValidISO(end)) return { error: 'Pick a valid finish date.' };
  if (end < today) return { error: 'The finish date is already in the past.' };
  const hours = Number(studyHours);
  if (!Number.isFinite(hours) || hours < 0 || hours > 12) return { error: 'Focused hours per weekday must be between 0 and 12.' };
  const before = JSON.stringify(state);
  const backstop = state.planConfig.backstop < end ? end : state.planConfig.backstop;
  const prevSettings = state.settings;
  state.settings = { ...state.settings, studyHours: hours };
  const res = await runGenerate({ groups: groups && groups.length ? groups : null, asleep: [...asleep], end, backstop }, { silent: true });
  if (res.error) { state.settings = prevSettings; return res; }
  lastPlanSnapshot = before;
  const m = state.planMeta;
  toast(m.feasible ? `Plan rebuilt: everything fits by ${fmtDate(end, { day: 'numeric', month: 'long' })}.` : `Plan rebuilt, but ${m.afterTarget + state.backlog.length} lecture${m.afterTarget + state.backlog.length === 1 ? '' : 's'} do not fit by ${fmtDate(end, { day: 'numeric', month: 'long' })}. Move the date later or raise the hours.`, {
    type: m.feasible ? 'ok' : 'warn', ms: 9000, action: { label: 'Undo', run: () => undoLastPlan() },
  });
  return { ok: true, meta: m };
}

/**
 * Called on load / after importing a backup. Rebuilds the plan once when (a) the data predates the two-block schedule, or
 * (b) lectures were added to the library since the plan was made (`fresh`). Completed and pinned tasks are kept; Undo is offered for (b).
 */
export async function migrateIfNeeded() {
  const hasFresh = state.tasks.some((t) => t.fresh);
  const wasOld = state.version < SCHEMA_VERSION;
  if (!wasOld && !hasFresh) return false;
  const hadPlan = state.tasks.some((t) => t.scheduledDate);
  const res = await runGenerate({}, { silent: !hasFresh });
  state.tasks.forEach((t) => { delete t.fresh; });
  state.version = SCHEMA_VERSION;
  persist();
  if (wasOld && hadPlan && res.ok) toast('Your plan now separates Light work (college gaps) from Focused work (home / evening). Progress and completed tasks were kept; a copy of your old data is stored in this browser.', { ms: 12000 });
  return true;
}

export async function clearPlan() {
  const ok = await confirmDialog({
    title: 'Clear the plan?',
    message: 'This removes all scheduled dates and generated planning blocks, including lectures you moved by hand. Completed status is kept.',
    confirmLabel: 'Clear plan',
    danger: true,
  });
  if (!ok) return;
  state.tasks = state.tasks.filter((t) => !t.generated);
  state.tasks.forEach((t) => { if (!t.done) { t.scheduledDate = null; t.block = null; t.seq = null; } t.pinned = false; });
  state.backlog = [];
  state.planMeta = null;
  commit();
  toast('Plan cleared.');
}

// ---- import / export -----------------------------------------------------------------------

export async function downloadPlanCsv() {
  if (!state.tasks.some((t) => t.scheduledDate)) { toast('Nothing is scheduled yet. Generate a plan first.', { type: 'warn' }); return; }
  const cfg = state.planConfig;
  const result = await openDialog({
    title: 'Download planner CSV',
    body: `<p>One row per task for every day in the span, with Light work and Focused work shown separately. Days with nothing planned (and trip or unavailable days) are included so the whole span is visible.</p>
      <div class="form-grid two">
        <div class="field"><label for="ex-from">From</label><input id="ex-from" name="from" type="date" value="${esc(cfg.start)}" required></div>
        <div class="field"><label for="ex-to">To</label><input id="ex-to" name="to" type="date" value="${esc(cfg.end)}" required></div>
      </div>
      <div class="row"><button type="button" class="small" data-range="plan">Plan start → target finish</button>
        <button type="button" class="small" data-range="backstop">Plan start → hard backstop</button>
        <button type="button" class="small" data-range="week">Next 7 days</button></div>
      <p class="hint" id="ex-hint" role="status"></p>`,
    submitLabel: 'Download CSV',
    onOpen(form) {
      const from = form.querySelector('#ex-from');
      const to = form.querySelector('#ex-to');
      const hint = form.querySelector('#ex-hint');
      const upd = () => {
        const ok = isValidISO(from.value) && isValidISO(to.value) && to.value >= from.value;
        hint.textContent = ok ? `${Math.round((new Date(`${to.value}T12:00`) - new Date(`${from.value}T12:00`)) / 86400000) + 1} days selected.` : '';
      };
      form.addEventListener('input', upd);
      form.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
        const k = b.dataset.range;
        if (k === 'week') { from.value = todayISO(); to.value = dateISO(new Date(Date.now() + 6 * 86400000)); } else { from.value = cfg.start; to.value = k === 'plan' ? cfg.end : cfg.backstop; }
        upd();
      }));
      upd();
    },
    onSubmit: ({ from, to }) => {
      const r = plannerCSV(state, from, to);
      return r.error ? r.error : { from, to, ...r };
    },
  });
  if (!result || result === true) return;
  downloadText(`mbbs-planner-${result.from}-to-${result.to}.csv`, `﻿${result.csv}`);
  toast(`Downloaded the planner for ${result.from} to ${result.to} (${result.rowCount} rows).`);
}

export function downloadTaskCsv() {
  const rows = [['id', 'subject', 'category', 'title', 'durationSec', 'sourceDuration', 'status', 'type', 'intensity', 'deadline', 'priority', 'prereqs']];
  state.tasks.filter((t) => !t.generated).forEach((t) => rows.push([t.id, t.subject, t.category, t.title, t.durationSec, t.sourceDuration, t.status, t.type, intensityOf(t), t.deadline || '', t.priority || '', (t.prereqs || []).join(';')]));
  downloadText('mbbs-task-library.csv', toCSV(rows));
  toast(`Exported ${rows.length - 1} tasks.`);
}

/** Parse task rows from CSV text. Returns { rows, skipped } or { error }. */
export function tasksFromCSV(text, existingIds) {
  const parsed = parseCSV(text);
  if (!parsed.length) return { rows: [], skipped: 0, error: 'The file has no data rows.' };
  const keys = Object.keys(parsed[0]).map((k) => k.toLowerCase());
  if (!keys.includes('title')) return { rows: [], skipped: 0, error: 'The CSV needs a "title" column. Export the task library to get a matching sample.' };
  const ids = new Set(existingIds);
  const rows = [];
  let skipped = 0;
  parsed.forEach((raw, i) => {
    const o = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.trim().toLowerCase(), String(v).trim()]));
    if (!o.title) { skipped++; return; }
    let dur = Number(o.durationsec);
    const missing = !Number.isFinite(dur) || dur < 1 || o.durationsec === '';
    if (missing) dur = 1200;
    let id = o.id || `${newId('IMPORT')}-${i}`;
    while (ids.has(id)) id += '-IMPORTED';
    ids.add(id);
    const intensity = o.intensity === 'light' || o.intensity === 'deep' ? o.intensity : undefined;
    const row = {
      id, subject: o.subject || 'Imported', category: o.category || 'Imported list', title: o.title, durationSec: Math.round(dur),
      sourceDuration: o.sourceduration || (missing ? '20 min default' : ''), status: o.status || (missing ? 'estimated_missing' : 'provided'),
      done: false, type: o.type || (intensity === 'light' ? 'custom' : 'video'), scheduledDate: null, selected: false,
    };
    if (intensity) row.intensity = intensity;
    if (isValidISO(o.deadline)) row.deadline = o.deadline;
    if (o.priority !== '' && Number.isFinite(Number(o.priority))) row.priority = Number(o.priority);
    if (o.prereqs) row.prereqs = o.prereqs.split(/[;|]/).map((x) => x.trim()).filter(Boolean);
    if (o.splittable === 'false' || o.splittable === '0') row.splittable = false;
    rows.push(row);
  });
  return { rows, skipped };
}

export async function importTaskCsv(file) {
  let text;
  try { text = await readFileText(file); } catch { toast('Could not read that file.', { type: 'error' }); return; }
  const { rows, skipped, error } = tasksFromCSV(text, state.tasks.map((t) => t.id));
  if (error) { toast(error, { type: 'error', ms: 8000 }); return; }
  if (!rows.length) { toast('No usable rows found (every row needs a title).', { type: 'error' }); return; }
  state.tasks.push(...rows);
  commit();
  toast(`Imported ${plural(rows.length, 'task')}${skipped ? `, skipped ${skipped} without a title` : ''}. Re-run the scheduler to place them.`, { ms: 7000 });
}

export function exportBackup() {
  downloadText('mbbs-study-planner-backup.json', JSON.stringify(state, null, 2), 'application/json');
  toast('Backup downloaded.');
}

export async function importBackup(file) {
  let data;
  try { data = sanitizeState(JSON.parse(await readFileText(file))); } catch { data = null; }
  if (!data) { toast('That file is not a valid backup, so nothing was changed.', { type: 'error', ms: 8000 }); return; }
  const ok = await confirmDialog({
    title: 'Replace current data?',
    message: `The backup contains ${data.tasks.length} tasks. Importing replaces everything currently in this browser.`,
    confirmLabel: 'Import backup',
    danger: true,
  });
  if (!ok) return;
  replaceState(data);
  commit();
  toast('Backup imported.');
  await migrateIfNeeded();
}

export async function resetAll() {
  const ok = await confirmDialog({
    title: 'Reset everything?',
    message: 'This restores the original task library, settings and plan and deletes your progress in this browser. Export a backup first if you might need it.',
    confirmLabel: 'Reset everything',
    danger: true,
  });
  if (!ok) return false;
  clearSaved();
  replaceState(freshState());
  commit();
  await runGenerate({}, { silent: true });
  toast('Everything was reset to the original data.');
  return true;
}

// ---- settings / simulator ------------------------------------------------------------------

const SETTING_RULES = {
  annotation: [0, 100], recall: [0, 100], weeklyBuffer: [0, 30], studyHours: [0, 12], collegeHours: [0, 6], speed: [0.5, 4], breakMin: [0, 60],
};

export function saveSettings(values) {
  const next = {};
  for (const [k, [lo, hi]] of Object.entries(SETTING_RULES)) {
    const raw = values[k];
    const n = Number(raw);
    if (raw === '' || raw === undefined || !Number.isFinite(n) || n < lo || n > hi) {
      return { field: k, error: `Enter a number between ${lo} and ${hi}.` };
    }
    next[k] = n;
  }
  const merged = { ...state.settings, ...next };
  for (const k of ['focusStart', 'weekendFocusStart', 'bedtime']) merged[k] = values[k] ?? merged[k];
  const bad = validateSettingsTimes(merged);
  if (bad) return bad;
  const capsChanged = ['studyHours', 'collegeHours', 'speed', 'annotation', 'recall', 'breakMin', 'focusStart', 'weekendFocusStart', 'bedtime'].some((k) => merged[k] !== state.settings[k]);
  state.settings = merged;
  commit();
  const hasPlan = state.tasks.some((t) => t.scheduledDate);
  toast('Settings saved. Planned times and totals were recalculated.', capsChanged && hasPlan ? {
    ms: 12000,
    action: { label: 'Rebuild plan', run: () => runGenerate({}) },
  } : {});
  if (capsChanged && hasPlan) toast('Your existing plan was not moved. Use “Rebuild plan” to apply the new capacities; overloaded blocks are flagged in the meantime.', { type: 'warn', ms: 12000 });
  return { ok: true };
}

export function runSimulation(values, save = true) {
  const r = simulate(values, weekdayCapacity(state.settings));
  if (save) { state.simLast = { hours: r.hours, reserve: r.reserve, days: r.days, existing: r.existing }; persist(); }
  return r;
}
