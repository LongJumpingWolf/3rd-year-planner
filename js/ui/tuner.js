// Plan tuner: linked "finish by" / "focused hours" sliders, study order (phases) and sleeping subjects.
// The sliders only edit a draft; the plan is rebuilt when the user presses Apply.
import { applyPlanTuner } from '../actions.js';
import { isVideo, lectureKey, maxFocusHours, planOutlook, presetPhases, resolvePhases, subjectsOf, taskPlannedSec } from '../planner.js';
import { state } from '../store.js';
import { addDays, dateISO, esc, fmtDate, fmtHours, fromISO } from '../utils.js';
import { $ } from './dom.js';

const MAX_DAYS = 200;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

let draft = null;     // { phaseOf: { subject: number | 'asleep' }, hours, end, anchor: 'hours' | 'end' }
let filledFor = null; // the config + settings objects the draft was built from

const todayIso = () => dateISO(new Date());
const daysBetween = (a, b) => Math.round((fromISO(b) - fromISO(a)) / 86400000);

function newDraft() {
  const { phases, asleep } = resolvePhases(state.planConfig, state.tasks);
  const phaseOf = {};
  phases.forEach((g, i) => g.forEach((s) => { phaseOf[s] = i + 1; }));
  asleep.forEach((s) => { phaseOf[s] = 'asleep'; });
  return { phaseOf, hours: state.settings.studyHours, end: state.planConfig.end, anchor: 'end' };
}

const asleepOf = () => Object.entries(draft.phaseOf).filter(([, v]) => v === 'asleep').map(([s]) => s);

/** Draft phases as ordered groups (default subject order inside a phase). */
function groupsOf() {
  const byPhase = new Map();
  for (const s of subjectsOf(state.tasks)) {
    const p = draft.phaseOf[s];
    if (p === 'asleep' || p === undefined) continue;
    if (!byPhase.has(p)) byPhase.set(p, []);
    byPhase.get(p).push(s);
  }
  return [...byPhase.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g);
}

const outlook = () => planOutlook(state.tasks, { ...state.planConfig, asleep: asleepOf() }, state.settings, { today: todayIso() });

/** Keep the two sliders consistent: the one the user last moved is the anchor, the other is solved for. */
function solve(out) {
  const max = out.maxHours;
  const from = out.from;
  let verdict = { tone: 'good', text: '' };
  if (draft.anchor === 'hours') {
    draft.hours = Math.min(Math.max(draft.hours, 0.5), max);
    const end = out.earliestEnd(draft.hours);
    draft.end = end ?? dateISO(addDays(fromISO(from), MAX_DAYS));
    if (!end) verdict = { tone: 'bad', text: `At ${draft.hours} h a weekday you would not finish within ${MAX_DAYS} days. Raise the hours, speed up playback in Settings, or put a subject to sleep.` };
  } else {
    if (draft.end < from) draft.end = from;
    const h = out.hoursFor(draft.end);
    if (h === null) {
      draft.hours = max;
      verdict = { tone: 'bad', text: `Even at the most your evening allows (${max} h a weekday) this does not finish by ${fmtDate(draft.end, { day: 'numeric', month: 'long' })}. Choose a later date, speed up playback in Settings, or put a subject to sleep.` };
    } else draft.hours = Math.max(0.5, h);
  }
  return verdict;
}

function paint() {
  if (!draft) return;
  const out = outlook();
  const verdict = solve(out);
  const asleep = new Set(asleepOf());
  const open = state.tasks.filter((t) => isVideo(t) && !t.done && !asleep.has(t.subject));
  const lectures = new Set(open.map(lectureKey)).size;
  const hoursLeft = open.reduce((s, t) => s + taskPlannedSec(t, state.settings), 0) / 3600;

  $('#tunerWork').textContent = lectures
    ? `${plural(lectures, 'lecture')} still to do · about ${fmtHours(hoursLeft * 3600)} of study time at your current playback speed${asleep.size ? ` (${[...asleep].join(', ')} asleep, not counted)` : ''}.`
    : 'Nothing left to plan. Every awake lecture is done.';

  const endSlider = $('#tuneEnd');
  const hoursSlider = $('#tuneHours');
  hoursSlider.max = String(out.maxHours);
  endSlider.value = String(Math.min(MAX_DAYS, Math.max(1, daysBetween(out.from, draft.end))));
  hoursSlider.value = String(draft.hours);
  const days = Math.max(1, daysBetween(out.from, draft.end));
  $('#tuneEndOut').textContent = `${fmtDate(draft.end, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })} (${plural(days, 'day')} from ${out.from === todayIso() ? 'today' : fmtDate(out.from, { day: 'numeric', month: 'short' })})`;
  $('#tuneHoursOut').textContent = `${draft.hours} h (max ${out.maxHours} h before bedtime)`;
  endSlider.setAttribute('aria-valuetext', fmtDate(draft.end, { weekday: 'long', day: 'numeric', month: 'long' }));
  hoursSlider.setAttribute('aria-valuetext', `${draft.hours} hours`);

  const v = $('#tuneVerdict');
  const pace = lectures ? hoursLeft / days : 0;
  const ok = !verdict.text;
  v.textContent = ok
    ? (lectures ? `At ${draft.hours} focused hours a weekday you finish by ${fmtDate(draft.end, { day: 'numeric', month: 'long' })}, which is about ${pace.toFixed(1)} h of lecture study per calendar day on average. The load is spread evenly, so no day is a sprint.` : 'Nothing to schedule.')
    : verdict.text;
  v.classList.toggle('is-bad', !ok);

  $('#phaseTable').innerHTML = subjectsOf(state.tasks).map((s) => {
    const mine = state.tasks.filter((t) => isVideo(t) && t.subject === s);
    const left = mine.filter((t) => !t.done);
    const sec = left.reduce((x, t) => x + taskPlannedSec(t, state.settings), 0);
    const cur = String(draft.phaseOf[s] ?? 1);
    const n = subjectsOf(state.tasks).length;
    return `<li><div><strong>${esc(s)}</strong><br><span class="small muted">${new Set(left.map(lectureKey)).size} of ${new Set(mine.map(lectureKey)).size} lectures left · ${esc(fmtHours(sec))}</span></div>
      <div><label class="sr-only" for="ph-${esc(s)}">Phase for ${esc(s)}</label>
        <select id="ph-${esc(s)}" data-subject="${esc(s)}">
          ${Array.from({ length: n }, (_, i) => `<option value="${i + 1}" ${cur === String(i + 1) ? 'selected' : ''}>Phase ${i + 1}</option>`).join('')}
          <option value="asleep" ${cur === 'asleep' ? 'selected' : ''}>Asleep (not planned)</option>
        </select></div></li>`;
  }).join('');

  const phases = state.planMeta?.phases || [];
  $('#phaseSummary').innerHTML = phases.length
    ? phases.map((p, i) => `<li><strong>Phase ${i + 1}: ${esc(p.subjects.join(' + '))}</strong>${p.from ? ` — ${esc(fmtDate(p.from, { day: 'numeric', month: 'short' }))} to ${esc(fmtDate(p.to, { day: 'numeric', month: 'short' }))} (${plural(p.count, 'lecture')} left)` : ' — nothing left'}</li>`).join('')
      + (state.planMeta?.asleep?.length ? `<li><strong>Asleep:</strong> ${esc(state.planMeta.asleep.join(', '))}</li>` : '')
    : '<li class="muted">No plan yet. Apply to build one.</li>';
}

export function renderTuner() {
  if (filledFor?.cfg !== state.planConfig || filledFor?.settings !== state.settings) {
    filledFor = { cfg: state.planConfig, settings: state.settings };
    draft = newDraft();
  }
  paint();
}

export function initTuner() {
  $('#tuneEnd').addEventListener('input', (e) => {
    draft.end = dateISO(addDays(fromISO(outlook().from), Number(e.target.value)));
    draft.anchor = 'end';
    paint();
  });
  $('#tuneHours').addEventListener('input', (e) => {
    draft.hours = Number(e.target.value);
    draft.anchor = 'hours';
    paint();
  });
  $('#phaseTable').addEventListener('change', (e) => {
    const s = e.target.dataset?.subject;
    if (!s) return;
    draft.phaseOf[s] = e.target.value === 'asleep' ? 'asleep' : Number(e.target.value);
    paint();
  });
  document.querySelector('.presets').addEventListener('click', (e) => {
    const kind = e.target.dataset?.preset;
    if (!kind) return;
    const active = subjectsOf(state.tasks).filter((s) => draft.phaseOf[s] !== 'asleep');
    presetPhases(active, kind).forEach((g, i) => g.forEach((s) => { draft.phaseOf[s] = i + 1; }));
    paint();
  });
  $('#tuneReset').addEventListener('click', () => { draft = newDraft(); $('#tuneErr').hidden = true; paint(); });
  $('#tuneApply').addEventListener('click', async () => {
    const err = $('#tuneErr');
    const res = await applyPlanTuner({ groups: groupsOf(), asleep: asleepOf(), studyHours: draft.hours, end: draft.end });
    err.textContent = res.error || '';
    err.hidden = !res.error;
  });
}

/** Max hours helper for tests / callers that need the slider ceiling without the DOM. */
export const sliderMaxHours = () => maxFocusHours(state.settings);
