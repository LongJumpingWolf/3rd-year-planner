// Scheduling engine. Everything here is pure (no DOM, no storage) so it can be unit-tested in Node.
//
// Every study day has TWO independent capacities:
//   light  - college gaps (short revision, recall, MCQs, indexing, previews)
//   focus  - home / evening (lectures, deep concepts, annotation)
// Tasks are assigned to exactly one block. Deep work is never placed in the light block just because focus is full.
import { addDays, dateISO, fromISO, isValidISO, num, weekStart } from './utils.js';

export const BLOCKS = ['light', 'focus'];
export const BLOCK_INFO = {
  light: { name: 'Light work', where: 'College gaps', short: 'Light' },
  focus: { name: 'Focused work', where: 'Home / evening', short: 'Focused' },
};

export const DEFAULT_SETTINGS = Object.freeze({
  speed: 1,
  annotation: 25,
  recall: 7,
  weeklyBuffer: 6,
  studyHours: 2.5, // focused work, weekdays
  collegeHours: 1.5, // light work in college gaps, weekdays
  breakMin: 10, // break between focused tasks (not counted as study time)
  focusStart: '18:30',
  weekendFocusStart: '10:00',
  bedtime: '22:30',
});
export const TIME_SETTINGS = ['focusStart', 'weekendFocusStart', 'bedtime'];

export const DEFAULT_PLAN_CONFIG = Object.freeze({
  start: '2026-10-12',
  end: '2026-12-31',
  backstop: '2027-01-07',
  tripStart: '2026-12-01',
  tripEnd: '2026-12-15',
  weekendLight: 2, // free weekends have no college gaps, so these are simply two study windows
  weekendFocus: 4,
  damsStart: '2026-11-13',
  breakStart: '2026-11-01',
  breakEnd: '2026-11-13',
  exceptions: Object.freeze({}), // { 'YYYY-MM-DD': { unavailable?, light?, focus?, note? } }
});

export const SUBJECT_ORDER = { PSM: 0, Ophthalmology: 1, FMT: 2, ENT: 3 };
export const MIN_SESSION_H = 1 / 3; // never split into sessions shorter than 20 minutes
export const BEDTIME_BUFFER_MIN = 15; // finish this long before bedtime
const EPS = 0.001;

// ---- time helpers -------------------------------------------------------------------------

export const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
export function fmtClock(min) {
  const h24 = Math.floor(min / 60) % 24;
  const m = Math.round(min % 60);
  const h = h24 % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/** Latest minute-of-day a focused session may end: bedtime minus a wind-down buffer. */
export const latestEndMin = (settings) => toMin(settings.bedtime) - BEDTIME_BUFFER_MIN;

/** Focused hours that really fit between the start time and bedtime once breaks are allowed for. */
export function focusWindowHours(settings, startStr) {
  const avail = latestEndMin(settings) - toMin(startStr);
  return Math.max(0, (avail - 2 * num(settings.breakMin, 10)) / 60);
}

// ---- task metadata -------------------------------------------------------------------------

export const isSchedulable = (t) => !t.generated && (t.type === 'video' || t.type === 'custom');
export const isVideo = (t) => t.type === 'video';
export const isEstimated = (t) => t.status === 'estimated_missing' || t.status === 'approximate';

const LIGHT_GENERATED = /^(REVIEW|DAMS|POSTEND|LIGHT|CATCHUPL)-/;
/** 'light' or 'deep'. A stored value wins; otherwise lectures are deep and short generated prep blocks are light. */
export function intensityOf(t) {
  if (t.intensity === 'light' || t.intensity === 'deep') return t.intensity;
  if (t.generated) return LIGHT_GENERATED.test(t.id) ? 'light' : 'deep';
  return 'deep';
}
/** The block a task is (or would be) in. */
export const blockOf = (t) => (t.block === 'light' || t.block === 'focus' ? t.block : intensityOf(t) === 'light' ? 'light' : 'focus');
export const recommendedBlock = (t) => (intensityOf(t) === 'light' ? 'light' : 'focus');
/** Deep work is never compatible with the light block; light work may use either. */
export const isCompatible = (t, block) => !(block === 'light' && intensityOf(t) === 'deep');
export const isSplittable = (t) => t.splittable !== false && !t.parentId && t.type !== 'planning';
export const lectureKey = (t) => t.parentId || t.id;

export function playbackSec(task, settings) {
  const speed = num(settings.speed, 1) || 1;
  return task.durationSec / speed;
}

/** Time actually needed: playback + annotation + brief recall overhead. */
export function plannedSec(task, settings) {
  const overhead = 1 + num(settings.annotation) / 100 + num(settings.recall) / 100;
  return playbackSec(task, settings) * overhead;
}

/** Study time for a task as shown in the UI. Planning blocks and backlog items are literal hours, not scaled by playback overheads. */
export function taskPlannedSec(task, settings) {
  return task.generated || task.type === 'planning' || task.type === 'custom' ? task.durationSec : plannedSec(task, settings);
}
const plannedH = (t, s) => taskPlannedSec(t, s) / 3600;

/** Weekday study capacity (h/day) = light + focused. */
export function weekdayCapacity(settings) {
  return num(settings.collegeHours, 1.5) + num(settings.studyHours, 2.5);
}

// ---- capacity ------------------------------------------------------------------------------

export function inTrip(iso, cfg) {
  return iso >= cfg.tripStart && iso <= cfg.tripEnd;
}

/**
 * Hours available in each block on a given day.
 * kind: weekday | weekend | dams | break | trip | off
 */
export function dayBlocks(d, cfg, settings) {
  const iso = dateISO(d);
  const dow = d.getDay();
  const ex = cfg.exceptions?.[iso];
  if (ex?.unavailable) return { light: 0, focus: 0, kind: 'off', note: ex.note || 'Marked unavailable' };
  if (inTrip(iso, cfg)) return { light: 0, focus: 0, kind: 'trip', note: 'Trip / unavailable' };
  const weekend = dow === 0 || dow === 6;
  const light0 = num(settings.collegeHours, 1.5);
  const focus0 = num(settings.studyHours, 2.5);
  let r;
  if (weekend && iso >= cfg.damsStart) {
    r = { light: 0.5, focus: 0, kind: 'dams', note: 'DAMS class day (9 AM – 9 PM): recap only' };
  } else if (weekend) {
    r = { light: num(cfg.weekendLight, 2), focus: Math.min(num(cfg.weekendFocus, 4), focusWindowHours(settings, settings.weekendFocusStart)), kind: 'weekend', note: 'Free weekend' };
  } else if (iso >= cfg.breakStart && iso <= cfg.breakEnd) {
    r = {
      light: Math.max(light0, num(cfg.weekendLight, 2)),
      focus: Math.max(Math.min(focus0, focusWindowHours(settings, settings.focusStart)), Math.min(num(cfg.weekendFocus, 4), focusWindowHours(settings, settings.weekendFocusStart))),
      kind: 'break', note: 'College break',
    };
  } else {
    r = { light: light0, focus: Math.min(focus0, focusWindowHours(settings, settings.focusStart)), kind: 'weekday', note: '' };
  }
  if (ex) {
    if (ex.light !== undefined && ex.light !== null) r.light = Math.max(0, num(ex.light, r.light));
    if (ex.focus !== undefined && ex.focus !== null) r.focus = Math.max(0, num(ex.focus, r.focus));
    r.note = ex.note || r.note || 'Custom capacity';
    r.custom = true;
  }
  return r;
}

export function dayCapacity(d, cfg, settings) {
  const b = dayBlocks(d, cfg, settings);
  return b.light + b.focus;
}

/** When focused work starts: evenings on college days, earlier on free days (weekends and the college break). */
export function focusStartFor(iso, cfg, settings) {
  const dow = fromISO(iso).getDay();
  const free = dow === 0 || dow === 6 || (iso >= cfg.breakStart && iso <= cfg.breakEnd);
  return free ? settings.weekendFocusStart : settings.focusStart;
}

/** Validate a plan config; returns an error string or null. */
export function validatePlanConfig(cfg) {
  for (const k of ['start', 'end', 'backstop', 'tripStart', 'tripEnd']) if (!isValidISO(cfg[k])) return 'Please enter a valid date for every date field.';
  if (cfg.end < cfg.start) return 'The target finish date must be on or after the plan start.';
  if (cfg.backstop < cfg.end) return 'The hard backstop must be on or after the target finish.';
  if (cfg.tripEnd < cfg.tripStart) return 'The trip end date must be on or after the trip start.';
  for (const k of ['weekendLight', 'weekendFocus']) {
    const c = Number(cfg[k]);
    if (!Number.isFinite(c) || c < 0 || c > 12) return 'Weekend capacities must be between 0 and 12 hours.';
  }
  return null;
}

/** Validate time-of-day settings; returns an error string or null. */
export function validateSettingsTimes(s) {
  for (const k of TIME_SETTINGS) if (!isTime(s[k])) return { field: k, error: 'Enter a time such as 18:30.' };
  if (toMin(s.focusStart) >= latestEndMin(s)) return { field: 'focusStart', error: 'Focused work must start before bedtime.' };
  return null;
}

// ---- fixed + generated blocks ------------------------------------------------------------------

/** Fixed (non-lecture) planning blocks implied by the rules: {id,date,block,subject,title,hours,category}. */
export function fixedBlocks(cfg, settings) {
  const blocks = [];
  const start = fromISO(cfg.start);
  const hard = fromISO(cfg.backstop);
  const catchupFrom = dateISO(addDays(fromISO(cfg.tripEnd), 1));
  const tripInPlan = cfg.tripEnd >= cfg.start && cfg.tripStart <= cfg.backstop;
  for (let d = new Date(start); d <= hard; d = addDays(d, 1)) {
    const iso = dateISO(d);
    const dow = d.getDay();
    const cap = dayBlocks(d, cfg, settings);
    if (cap.kind === 'trip' || cap.kind === 'off') continue;
    const afterTrip = tripInPlan && iso >= catchupFrom;
    if (afterTrip && iso <= cfg.end && dow >= 1 && dow <= 5) {
      blocks.push({ id: `CATCHUP-${iso}`, date: iso, block: 'focus', subject: 'Posting catch-up', category: 'Clinical posting catch-up', hours: 2, title: `Trip posting catch-up (focused part) — ${iso}` });
      blocks.push({ id: `CATCHUPL-${iso}`, date: iso, block: 'light', subject: 'Posting catch-up', category: 'Clinical posting catch-up', hours: 1, title: `Trip posting catch-up (notes & recall part) — ${iso}` });
    }
    if (dow === 0 && cap.kind !== 'dams') {
      blocks.push({ id: `REVIEW-${iso}`, date: iso, block: 'light', subject: 'Revision', category: 'Weekly review', hours: 1, title: 'Weekly recall + error-log review' });
    }
    if ((dow === 0 || dow === 6) && cap.kind === 'dams') {
      blocks.push({ id: `DAMS-${iso}`, date: iso, block: 'light', subject: 'DAMS', category: 'DAMS revision', hours: 0.5, title: dow === 0 ? 'DAMS class recap + weekly recall' : 'DAMS class recap / active recall' });
    }
    if (afterTrip && dow >= 1 && dow <= 6 && cap.kind !== 'dams') {
      blocks.push({ id: `POSTEND-${iso}`, date: iso, block: 'light', subject: 'Post-end prep', category: 'Post-end preparation', hours: 0.5, title: 'Post-end exam preparation / posting notes' });
    }
  }
  return blocks;
}

const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true });

function toGenerated(b, done) {
  return {
    id: b.id, subject: b.subject, category: b.category, title: b.title, intensity: b.block === 'light' ? 'light' : 'deep', block: b.block,
    durationSec: Math.round(b.hours * 3600), sourceDuration: `${b.hours} h planning estimate`,
    status: 'custom_estimate', done, type: 'planning', scheduledDate: b.date, selected: false, generated: true,
  };
}

// ---- split / merge ------------------------------------------------------------------------------

/** Undo automatic splits (only where nothing in the group is done or pinned) so every plan starts from whole lectures. */
export function mergeAutoSplits(tasks) {
  const groups = new Map();
  for (const t of tasks) {
    if (t.parentId && t.autoSplit) {
      if (!groups.has(t.parentId)) groups.set(t.parentId, []);
      groups.get(t.parentId).push(t);
    }
  }
  const drop = new Set();
  const wholes = [];
  for (const [pid, parts] of groups) {
    if (parts.some((p) => p.done || p.pinned)) continue;
    parts.sort((a, b) => a.partIndex - b.partIndex);
    // eslint-disable-next-line no-unused-vars
    const { parentId, partIndex, partCount, autoSplit, splittable, ...rest } = parts[0];
    wholes.push({ ...rest, id: pid, durationSec: parts.reduce((s, p) => s + p.durationSec, 0), scheduledDate: null, block: null, seq: null });
    parts.forEach((p) => drop.add(p));
  }
  return [...tasks.filter((t) => !drop.has(t)), ...wholes];
}

/** Split a task into `n` near-equal parts. Ids: the original, then `<id>~p2`, `<id>~p3` ... Part 1 keeps the schedule. */
export function splitTask(task, n, auto = false) {
  const k = Math.max(2, Math.min(8, Math.round(n)));
  const base = Math.floor(task.durationSec / k);
  const pid = task.parentId || task.id;
  const parts = [];
  for (let i = 0; i < k; i++) {
    parts.push({
      ...task,
      id: i === 0 ? task.id : `${pid}~p${i + 1}`,
      parentId: pid, partIndex: i + 1, partCount: k, autoSplit: auto, splittable: false,
      durationSec: i === k - 1 ? task.durationSec - base * (k - 1) : base,
      done: i === 0 ? task.done : false,
      scheduledDate: i === 0 ? task.scheduledDate : null,
      block: i === 0 ? task.block : null,
      seq: i === 0 ? task.seq : null,
      pinned: i === 0 ? task.pinned : false,
      selected: false,
    });
  }
  return parts;
}

// ---- the scheduler ------------------------------------------------------------------------------

function priorityKey(a, b) {
  const da = a.deadline || '9999';
  const db = b.deadline || '9999';
  return (num(b.priority) - num(a.priority))
    || (da < db ? -1 : da > db ? 1 : 0)
    || (SUBJECT_ORDER[a.subject] ?? 9) - (SUBJECT_ORDER[b.subject] ?? 9)
    || naturalCompare(a.id, b.id);
}

/** Per-day, per-block hours already booked (done and open tasks both occupy their slot). */
export function usageMap(tasks, settings, skipId) {
  const used = {};
  for (const t of tasks) {
    if (!t.scheduledDate || t.id === skipId) continue;
    const u = (used[t.scheduledDate] ??= { light: 0, focus: 0 });
    u[blockOf(t)] += plannedH(t, settings);
  }
  return used;
}

/** Earliest day in [from, to] where `hours` fits wholly in `block`, or null. `used` is a usageMap and is not modified. */
export function findSlot(used, hours, block, from, to, cfg, settings) {
  for (let d = fromISO(from); dateISO(d) <= to; d = addDays(d, 1)) {
    const iso = dateISO(d);
    if (dayBlocks(d, cfg, settings)[block] - (used[iso]?.[block] || 0) >= hours - EPS) return iso;
  }
  return null;
}

/**
 * Build a dated plan. Does not mutate its inputs. Returns { error } or { tasks, backlog, meta }.
 *  - completed tasks keep their dates, blocks and status
 *  - tasks pinned by hand (t.pinned) keep their dates and blocks and consume capacity
 *  - deep work only goes to the focused block; light work only to the light block
 *  - a lecture that cannot fit whole in any remaining focused block is split into sessions (if splittable)
 *  - generated blocks are rebuilt; their done-state is preserved by id
 *  - anything that cannot fit before the hard backstop goes to the backlog (never hidden)
 */
export function generatePlan(tasksIn, cfgIn, settings, now = new Date()) {
  const cfg = { ...DEFAULT_PLAN_CONFIG, ...cfgIn };
  const error = validatePlanConfig(cfg);
  if (error) return { error };

  const doneGenerated = new Set(tasksIn.filter((t) => t.generated && t.done).map((t) => t.id));
  const tasks = mergeAutoSplits(tasksIn.filter((t) => !t.generated)).map((t) => ({ ...t }));
  for (const t of tasks) {
    if (isSchedulable(t) && !t.done && !t.pinned) { t.scheduledDate = null; t.block = null; t.seq = null; }
  }

  const used = {};
  const seqs = {};
  const book = (iso, block, h) => { (used[iso] ??= { light: 0, focus: 0 })[block] += h; };
  const nextSeq = (iso, block) => (seqs[`${iso}|${block}`] = (seqs[`${iso}|${block}`] || 0) + 1);
  const room = (iso, block) => dayBlocks(fromISO(iso), cfg, settings)[block] - (used[iso]?.[block] || 0);

  for (const t of tasks) {
    if (t.scheduledDate && (t.done || t.pinned || !isSchedulable(t))) {
      const b = blockOf(t);
      book(t.scheduledDate, b, plannedH(t, settings));
      if (t.seq == null) t.seq = nextSeq(t.scheduledDate, b);
    }
  }

  const generated = fixedBlocks(cfg, settings).map((b) => {
    book(b.date, b.block, b.hours);
    const g = toGenerated(b, doneGenerated.has(b.id));
    g.seq = nextSeq(b.date, b.block);
    return g;
  });

  const days = [];
  for (let d = fromISO(cfg.start); d <= fromISO(cfg.backstop); d = addDays(d, 1)) days.push(dateISO(d));

  const ratio = plannedSec({ durationSec: 1 }, settings); // study seconds per runtime second
  const backlog = [];
  const splitInto = new Map(); // task id -> its new parts
  const lateIds = [];

  /** Place one task into `block` on/after minISO, splitting if it cannot fit whole. Returns true if placed. */
  const place = (t, block, minISO) => {
    const need = plannedH(t, settings);
    const from = minISO && minISO > cfg.start ? minISO : cfg.start;
    for (const iso of days) {
      if (iso < from || room(iso, block) < need - EPS) continue;
      t.scheduledDate = iso; t.block = block; t.seq = nextSeq(iso, block);
      book(iso, block, need);
      return true;
    }
    if (!isSplittable(t) || need < 2 * MIN_SESSION_H) return false;
    // Plan the sessions first without booking, so a failed attempt leaves nothing behind.
    const sessions = [];
    let left = need;
    for (const iso of days) {
      if (iso < from || left <= EPS) continue;
      const r = room(iso, block);
      if (r < MIN_SESSION_H - EPS) continue;
      let take = Math.min(r, left);
      if (left - take > EPS && left - take < MIN_SESSION_H) take = left - MIN_SESSION_H;
      if (take < MIN_SESSION_H - EPS) continue;
      sessions.push({ iso, take });
      left -= take;
    }
    if (left > EPS || sessions.length < 2) return false;
    const parts = splitTask(t, sessions.length, true);
    let remaining = t.durationSec;
    parts.forEach((p, i) => {
      p.durationSec = i === parts.length - 1 ? remaining : Math.round((sessions[i].take * 3600) / ratio);
      remaining -= p.durationSec;
      Object.assign(p, { scheduledDate: sessions[i].iso, block, seq: nextSeq(sessions[i].iso, block), pinned: false });
      book(sessions[i].iso, block, sessions[i].take);
    });
    splitInto.set(t.id, parts);
    return true;
  };

  const run = (queue, block) => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const pending = new Set(queue.map((t) => t.id));
    const q = [...queue];
    let guard = q.length * 3 + 5;
    while (q.length && guard-- > 0) {
      const t = q.shift();
      const pre = (t.prereqs || []).map((id) => byId.get(id)).filter((p) => p && !p.done);
      if (pre.some((p) => pending.has(p.id)) && q.length) { q.push(t); continue; }
      pending.delete(t.id);
      const minISO = pre.reduce((m, p) => (p.scheduledDate && p.scheduledDate > m ? p.scheduledDate : m), '');
      if (place(t, block, minISO)) {
        if (t.deadline && t.scheduledDate > t.deadline) lateIds.push(t.id);
      } else {
        t.scheduledDate = null; t.block = null;
        backlog.push({ taskId: t.id, reason: `No ${block === 'focus' ? 'focused' : 'light'}-work capacity left before the hard backstop` });
      }
    }
    q.forEach((t) => backlog.push({ taskId: t.id, reason: 'Waiting on a prerequisite that could not be scheduled' }));
  };

  const open = tasks.filter((t) => isSchedulable(t) && !t.done && !t.pinned).sort(priorityKey);
  run(open.filter((t) => intensityOf(t) === 'light'), 'light');
  run(open.filter((t) => intensityOf(t) === 'deep'), 'focus');

  const scheduled = tasks.flatMap((t) => splitInto.get(t.id) ?? [t]);
  const templates = lightTemplates(scheduled, cfg, settings, used, doneGenerated, days, nextSeq, book);
  const final = [...scheduled, ...generated, ...templates];

  const stats = lectureStats(final);
  const meta = {
    start: cfg.start, end: cfg.end, hard: cfg.backstop,
    placed: stats.scheduled, videoCount: stats.open,
    splitLectures: splitInto.size,
    lateCount: lateIds.length,
    generatedCount: generated.length + templates.length,
    generatedHours: [...generated, ...templates].reduce((s, t) => s + t.durationSec / 3600, 0),
    overflow: { light: backlog.filter((b) => b.reason.startsWith('No light')).length, focus: backlog.filter((b) => b.reason.startsWith('No focused')).length },
    createdAt: now.toISOString(),
  };
  return { tasks: final, backlog, meta };
}

/** Light-work prep (recall, MCQs, lecture preview, indexing) for each study day that has lectures planned. */
function lightTemplates(all, cfg, settings, used, doneGenerated, days, nextSeq, book) {
  const lectures = all.filter((t) => t.scheduledDate && isVideo(t) && blockOf(t) === 'focus');
  if (!lectures.length) return [];
  const byDay = {};
  for (const t of lectures) (byDay[t.scheduledDate] ??= []).push(t);
  Object.values(byDay).forEach((a) => a.sort((x, y) => num(x.seq) - num(y.seq)));
  const lastDay = Object.keys(byDay).sort().at(-1);
  const out = [];
  let prevSubjects = [];
  for (const iso of days) {
    if (iso > lastDay) break;
    const today = byDay[iso] || [];
    const cap = dayBlocks(fromISO(iso), cfg, settings);
    let free = cap.light - (used[iso]?.light || 0);
    if (cap.kind !== 'dams' && free >= 0.25 - EPS) {
      const subj = [...new Set(today.map((t) => t.subject))].slice(0, 2);
      const recallOn = prevSubjects.length ? prevSubjects : subj;
      const mcqOn = subj.length ? subj : prevSubjects;
      const plan = [
        { key: 'RECALL', h: 0.5, subject: 'Revision', category: 'Active recall', title: recallOn.length ? `Active recall: ${recallOn.join(' & ')} — previous lectures` : 'Active recall: error log & flashcards' },
        { key: 'MCQ', h: 0.5, subject: 'Revision', category: 'MCQs', title: mcqOn.length ? `MCQs & mistake review — ${mcqOn.join(' & ')}` : 'MCQs & mistake review — mixed' },
        today.length
          ? { key: 'PREVIEW', h: 0.25, subject: 'Preview', category: 'Lecture preview', title: `Preview before tonight: ${today[0].title} — definitions & prerequisites` }
          : { key: 'PREVIEW', h: 0.25, subject: 'Revision', category: 'Prerequisites', title: 'Learn definitions & prerequisites for upcoming topics' },
        { key: 'INDEX', h: 0.25, subject: 'Revision', category: 'Indexing', title: 'Indexing & organising notes / annotations' },
      ];
      for (const p of plan) {
        if (free < p.h - EPS) continue;
        const id = `LIGHT-${p.key}-${iso}`;
        const g = toGenerated({ id, date: iso, block: 'light', subject: p.subject, category: p.category, hours: p.h, title: p.title }, doneGenerated.has(id));
        g.seq = nextSeq(iso, 'light');
        book(iso, 'light', p.h);
        free -= p.h;
        out.push(g);
      }
    }
    if (today.length) prevSubjects = [...new Set(today.map((t) => t.subject))].slice(0, 2);
  }
  return out;
}

// ---- views over the schedule ---------------------------------------------------------------------

/** Lecture-level counts: split parts count as one lecture; a lecture is done only when every part is. */
export function lectureStats(tasks) {
  const g = new Map();
  for (const t of tasks) {
    if (t.generated || !isVideo(t)) continue;
    const k = lectureKey(t);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(t);
  }
  let done = 0; let open = 0; let scheduled = 0;
  for (const parts of g.values()) {
    if (parts.every((p) => p.done)) { done++; continue; }
    open++;
    if (parts.filter((p) => !p.done).every((p) => p.scheduledDate)) scheduled++;
  }
  return { total: g.size, done, open, scheduled, unscheduled: open - scheduled };
}

/** Sequential clock times for focused tasks with a break between each. */
export function layoutFocus(tasks, startStr, settings) {
  let cur = toMin(startStr);
  const limit = latestEndMin(settings);
  const gap = num(settings.breakMin, 10);
  return tasks.map((task, i) => {
    if (i) cur += gap;
    const start = cur;
    cur += Math.round(taskPlannedSec(task, settings) / 60);
    return { task, start, end: cur, late: cur > limit };
  });
}

/** Everything the Daily / Weekly / Dashboard views need for one date, per block. */
export function dayStats(tasks, iso, cfg, settings) {
  const cap = dayBlocks(fromISO(iso), { ...DEFAULT_PLAN_CONFIG, ...cfg }, settings);
  const res = { iso, kind: cap.kind, note: cap.note, custom: !!cap.custom, blocks: {} };
  let planned = 0;
  let done = 0;
  for (const b of BLOCKS) {
    const list = tasks.filter((t) => t.scheduledDate === iso && blockOf(t) === b).sort((x, y) => num(x.seq) - num(y.seq) || naturalCompare(x.id, y.id));
    const p = list.reduce((s, t) => s + plannedH(t, settings), 0);
    const d = list.filter((t) => t.done).reduce((s, t) => s + plannedH(t, settings), 0);
    const clock = b === 'focus' ? layoutFocus(list, focusStartFor(iso, { ...DEFAULT_PLAN_CONFIG, ...cfg }, settings), settings) : null;
    res.blocks[b] = {
      block: b, tasks: list, cap: cap[b], planned: p, done: d,
      free: Math.max(0, cap[b] - p), over: Math.max(0, p - cap[b]),
      mismatched: list.filter((t) => !isCompatible(t, b)),
      clock, pastBedtime: !!clock?.some((x) => x.late),
    };
    planned += p;
    done += d;
  }
  res.planned = planned;
  res.done = done;
  res.pct = planned > 0 ? Math.round((done / planned) * 100) : 0;
  res.capacity = cap.light + cap.focus;
  return res;
}

/** Per-week totals for scheduled tasks, split by block. */
export function weeklyLoad(tasks, settings) {
  const map = {};
  for (const t of tasks) {
    if (!t.scheduledDate) continue;
    const ws = dateISO(weekStart(fromISO(t.scheduledDate)));
    const w = (map[ws] ??= { week: ws, tasks: 0, hours: 0, done: 0, light: 0, focus: 0 });
    const h = plannedH(t, settings);
    w.tasks++;
    w.hours += h;
    w[blockOf(t)] += h;
    if (t.done) w.done++;
  }
  return Object.values(map).sort((a, b) => a.week.localeCompare(b.week));
}

/** Capacity vs planned time for the week containing `date`, used for the dashboard buffer meter. */
export function weekSummary(tasks, date, cfg, settings) {
  const start = weekStart(date);
  const c = { ...DEFAULT_PLAN_CONFIG, ...cfg };
  let capacity = 0;
  let planned = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const iso = dateISO(d);
    capacity += dayCapacity(d, c, settings);
    for (const t of tasks) if (t.scheduledDate === iso && !t.done) planned += plannedH(t, settings);
  }
  const buffer = num(settings.weeklyBuffer, 0);
  return { capacity, planned, free: capacity - planned, buffer };
}

/** What-if disruption maths. */
export function simulate({ hours, reserve, days, existing }, dailyCapacity) {
  hours = Math.max(0, num(hours));
  reserve = Math.max(0, num(reserve));
  days = Math.max(1, Math.round(num(days, 1)));
  existing = Math.max(0, num(existing));
  const remain = reserve - hours;
  const perDay = hours / days;
  const load = existing + perDay;
  let risk = 'Manageable';
  if (remain < 0) risk = 'Over reserve';
  else if (load > dailyCapacity) risk = 'Overloaded';
  return { remain, perDay, load, risk, reserve, hours, days, existing };
}
