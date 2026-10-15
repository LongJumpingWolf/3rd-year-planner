// App state, persistence and validation. The pure parts (sanitizeState, task helpers) are testable in Node.
import { INITIAL_TASKS } from './data.js';
import { DEFAULT_PLAN_CONFIG, DEFAULT_SETTINGS, TIME_SETTINGS, isTime } from './planner.js';
import { isValidISO, num } from './utils.js';

export const STORAGE_KEY = 'mbbsStudyCommandCenter.v1';
export const BACKUP_KEY = 'mbbsStudyCommandCenter.v1.pre-blocks-backup';
/** 2 = separate light / focused capacities and per-task block assignment. */
export const SCHEMA_VERSION = 2;

export const EXTRA_MAX_LEN = 100;
export const EXTRA_MAX_PER_DAY = 8;

export function freshTasks() {
  return INITIAL_TASKS.map((x) => ({ ...x, scheduledDate: null, selected: false }));
}

export function freshState() {
  return {
    tasks: freshTasks(),
    settings: { ...DEFAULT_SETTINGS },
    planConfig: { ...DEFAULT_PLAN_CONFIG, exceptions: {}, groups: null, asleep: [] },
    version: SCHEMA_VERSION,
    backlog: [],
    planMeta: null,
    simLast: { hours: 2, reserve: 6, days: 3, existing: 1 },
    extras: {},
    viewer: { phone: '' },
    missLog: {},
  };
}

function cleanTask(t) {
  if (!t || typeof t !== 'object') return null;
  const title = String(t.title ?? '').trim();
  const id = String(t.id ?? '').trim();
  const durationSec = Number(t.durationSec);
  if (!title || !id || !Number.isFinite(durationSec) || durationSec < 0) return null;
  return {
    ...t,
    id,
    title,
    subject: String(t.subject || 'General'),
    category: String(t.category || 'General'),
    durationSec,
    sourceDuration: String(t.sourceDuration ?? ''),
    status: String(t.status || 'provided'),
    type: String(t.type || 'video'),
    done: !!t.done,
    selected: false,
    pinned: !!t.pinned,
    doneAt: t.done && isValidISO(t.doneAt) ? t.doneAt : undefined,
    scheduledDate: isValidISO(t.scheduledDate) ? t.scheduledDate : null,
    block: t.block === 'light' || t.block === 'focus' ? t.block : null,
    intensity: t.intensity === 'light' || t.intensity === 'deep' ? t.intensity : undefined,
    seq: Number.isFinite(Number(t.seq)) && t.seq !== null ? Number(t.seq) : null,
    deadline: isValidISO(t.deadline) ? t.deadline : undefined,
    priority: Number.isFinite(Number(t.priority)) ? Number(t.priority) : undefined,
    prereqs: Array.isArray(t.prereqs) ? t.prereqs.map(String) : undefined,
  };
}

/**
 * Subjects that used to ship as one "total only" placeholder (FMT, ENT) now ship with their full lecture lists.
 * Saved data that still has the placeholder gets the real lectures instead (marked `fresh` so the plan is rebuilt once).
 * Skipped when the saved data already holds that subject's own lectures (e.g. from a CSV import), so nothing is duplicated.
 */
function upgradeLibrary(tasks, seen) {
  for (const ph of tasks.filter((t) => t.type === 'dataset_placeholder')) {
    const lectures = INITIAL_TASKS.filter((x) => x.subject === ph.subject && x.type !== 'dataset_placeholder');
    if (!lectures.length || tasks.some((t) => t.subject === ph.subject && t.type !== 'dataset_placeholder')) continue;
    const at = tasks.indexOf(ph);
    const added = lectures.filter((x) => !seen.has(x.id)).map((x) => cleanTask({ ...x, scheduledDate: null, selected: false, fresh: true }));
    added.forEach((t) => seen.add(t.id));
    tasks.splice(at, 1, ...added);
  }
}

/**
 * Turn arbitrary (possibly old, partial or hand-edited) JSON into a safe state object.
 * Returns null when it does not look like a backup at all.
 */
export function sanitizeState(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tasks)) return null;
  const base = freshState();
  const seen = new Set();
  const tasks = [];
  for (const t of raw.tasks) {
    const c = cleanTask(t);
    if (c && !seen.has(c.id)) { seen.add(c.id); tasks.push(c); }
  }
  upgradeLibrary(tasks, seen);
  if (!tasks.length) return null;
  const settings = { ...base.settings };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const v = raw.settings?.[k];
    settings[k] = TIME_SETTINGS.includes(k) ? (isTime(v) ? v : DEFAULT_SETTINGS[k]) : num(v, DEFAULT_SETTINGS[k]);
  }
  const planConfig = { ...base.planConfig };
  for (const k of Object.keys(DEFAULT_PLAN_CONFIG)) {
    const v = raw.planConfig?.[k];
    if (k === 'exceptions' || k === 'groups' || k === 'asleep') continue;
    if (typeof DEFAULT_PLAN_CONFIG[k] === 'number') planConfig[k] = num(v, DEFAULT_PLAN_CONFIG[k]);
    else if (isValidISO(v)) planConfig[k] = v;
  }
  // v1 stored one weekend capacity; split it into light + focused, keeping the same total.
  const oldCap = raw.planConfig?.weekendCap;
  if (oldCap !== undefined && raw.planConfig?.weekendLight === undefined) {
    const total = Math.max(0, Math.min(12, num(oldCap, 6)));
    planConfig.weekendLight = Math.round((total / 3) * 2) / 2;
    planConfig.weekendFocus = total - planConfig.weekendLight;
  }
  // Study order (phases of subjects studied side by side) and parked subjects.
  const groups = (Array.isArray(raw.planConfig?.groups) ? raw.planConfig.groups : [])
    .filter(Array.isArray).map((g) => g.map((x) => String(x))).filter((g) => g.length);
  planConfig.groups = groups.length ? groups : null;
  planConfig.asleep = Array.isArray(raw.planConfig?.asleep) ? [...new Set(raw.planConfig.asleep.map((x) => String(x)))] : [];
  planConfig.exceptions = {};
  for (const [iso, e] of Object.entries(raw.planConfig?.exceptions && typeof raw.planConfig.exceptions === 'object' ? raw.planConfig.exceptions : {})) {
    if (!isValidISO(iso) || !e || typeof e !== 'object') continue;
    const x = {};
    if (e.unavailable) x.unavailable = true;
    for (const k of ['light', 'focus']) if (e[k] !== undefined && e[k] !== null && Number.isFinite(Number(e[k]))) x[k] = Math.max(0, Math.min(16, Number(e[k])));
    if (e.note) x.note = String(e.note).slice(0, 120);
    if (Object.keys(x).length) planConfig.exceptions[iso] = x;
  }
  const backlog = (Array.isArray(raw.backlog) ? raw.backlog : [])
    .filter((b) => b && seen.has(b.taskId))
    .map((b) => ({ taskId: b.taskId, reason: String(b.reason || 'Unscheduled') }));
  const simLast = { ...base.simLast };
  for (const k of Object.keys(simLast)) simLast[k] = num(raw.simLast?.[k], simLast[k]);
  // Short notes per day ("did 40 MCQs") that the owner chooses to show on the viewer link.
  const extras = {};
  for (const [iso, list] of Object.entries(raw.extras && typeof raw.extras === 'object' ? raw.extras : {})) {
    if (!isValidISO(iso) || !Array.isArray(list)) continue;
    const items = list.map((x) => String(x ?? '').trim().slice(0, EXTRA_MAX_LEN)).filter(Boolean).slice(0, EXTRA_MAX_PER_DAY);
    if (items.length) extras[iso] = items;
  }
  // Viewer link: the owner's WhatsApp number (digits, with country code) for the Notify button.
  const phoneDigits = String(raw.viewer?.phone ?? '').replace(/\D/g, '');
  const viewer = { phone: phoneDigits.length >= 8 && phoneDigits.length <= 15 ? phoneDigits : '' };
  // Planned hours that were missed on a past day and moved forward by a re-plan, so that day's completion stays honest.
  const missLog = {};
  for (const [iso, h] of Object.entries(raw.missLog && typeof raw.missLog === 'object' ? raw.missLog : {})) {
    if (isValidISO(iso) && Number.isFinite(Number(h)) && Number(h) > 0) missLog[iso] = Math.round(Number(h) * 1000) / 1000;
  }
  const planMeta = raw.planMeta && typeof raw.planMeta === 'object' ? raw.planMeta : null;
  return { tasks, settings, planConfig, backlog, planMeta, simLast, extras, viewer, missLog, version: Number(raw.version) >= SCHEMA_VERSION ? SCHEMA_VERSION : 1 };
}

let idCounter = 0;
export function newId(prefix = 'CUSTOM') {
  idCounter = (idCounter + 1) % 1679616; // the counter makes ids unique even within one millisecond
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

// ---- live state + persistence (browser only) -------------------------------------------------

export const state = freshState();

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function replaceState(next) {
  Object.keys(state).forEach((k) => delete state[k]);
  Object.assign(state, next);
}

let storageOK = true;
export const storageAvailable = () => storageOK;

export function loadState() {
  try {
    const rawText = localStorage.getItem(STORAGE_KEY);
    const saved = sanitizeState(JSON.parse(rawText));
    if (saved) {
      replaceState(saved);
      // First load of data saved by the single-capacity version: keep an untouched copy before it is migrated.
      if (saved.version < SCHEMA_VERSION && !localStorage.getItem(BACKUP_KEY)) localStorage.setItem(BACKUP_KEY, rawText);
    }
  } catch {
    storageOK = false;
  }
  return state;
}

export function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    storageOK = true;
  } catch {
    storageOK = false;
  }
}

/** Save and notify views to re-render. */
export function commit() {
  persist();
  listeners.forEach((fn) => fn());
}

export function clearSaved() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

export const findTask = (id) => state.tasks.find((t) => t.id === id);
