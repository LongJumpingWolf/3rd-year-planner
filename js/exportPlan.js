// Planner CSV: every day in a chosen span, both work blocks, one row per task (or one row saying the block is empty).
import { BLOCKS, BLOCK_INFO, dayStats, fmtClock, intensityOf, taskPlannedSec } from './planner.js';
import { addDays, dateISO, fromISO, isValidISO, toCSV } from './utils.js';

export const MAX_EXPORT_DAYS = 800;

export const PLANNER_CSV_HEADER = [
  'Date', 'Weekday', 'Day type', 'Block', 'Block capacity (h)', 'Block planned (h)', 'Block free (h)', 'Order',
  'Start', 'End', 'Subject', 'Category', 'Task', 'Part', 'Study time (min)', 'Runtime (min)', 'Work type', 'Status', 'Notes',
];

const DAY_TYPE = {
  weekday: 'College day', weekend: 'Free weekend', dams: 'DAMS class day', break: 'College break', trip: 'Trip (protected)', off: 'Unavailable',
};
const h2 = (x) => (Math.round(x * 100) / 100).toFixed(2);

/** Returns { error } or { rows } (header first). `st` is the app state (tasks, planConfig, settings). */
export function plannerRows(st, from, to) {
  if (!isValidISO(from) || !isValidISO(to)) return { error: 'Please choose a valid start and end date.' };
  if (to < from) return { error: 'The end date must be on or after the start date.' };
  const days = Math.round((fromISO(to) - fromISO(from)) / 86400000) + 1;
  if (days > MAX_EXPORT_DAYS) return { error: `Please choose a span of at most ${MAX_EXPORT_DAYS} days.` };
  const rows = [PLANNER_CSV_HEADER];
  for (let d = fromISO(from); dateISO(d) <= to; d = addDays(d, 1)) {
    const iso = dateISO(d);
    const s = dayStats(st.tasks, iso, st.planConfig, st.settings);
    const weekday = d.toLocaleDateString('en-GB', { weekday: 'long' });
    for (const b of BLOCKS) {
      const blk = s.blocks[b];
      const lead = [iso, weekday, DAY_TYPE[s.kind] || s.kind, BLOCK_INFO[b].name, h2(blk.cap), h2(blk.planned), h2(Math.max(0, blk.cap - blk.planned))];
      if (!blk.tasks.length) {
        rows.push([...lead, '', '', '', '', '', '', '', '', '', '', '', s.note || (blk.cap === 0 ? 'No time available' : 'Nothing planned')]);
        continue;
      }
      blk.tasks.forEach((t, i) => {
        const c = blk.clock?.[i];
        const study = Math.round(taskPlannedSec(t, st.settings) / 60);
        const notes = [];
        if (c?.late) notes.push('Runs past wind-down time');
        if (blk.mismatched.includes(t)) notes.push('Deep work placed in light block (override)');
        if (t.pinned) notes.push('Placed by hand');
        if (t.status === 'estimated_missing') notes.push('Duration estimated (20 min default)');
        if (blk.over > 0.001 && i === 0) notes.push(`Block over capacity by ${h2(blk.over)} h`);
        rows.push([
          ...lead, i + 1, c ? fmtClock(c.start) : '', c ? fmtClock(c.end) : '', t.subject, t.category, t.title,
          t.partCount ? `${t.partIndex}/${t.partCount}` : '', study, Math.round(t.durationSec / 60),
          intensityOf(t) === 'light' ? 'Light' : 'Deep', t.done ? 'Done' : 'To do', notes.join('; '),
        ]);
      });
    }
  }
  return { rows };
}

export const plannerCSV = (st, from, to) => {
  const r = plannerRows(st, from, to);
  return r.error ? r : { csv: toCSV(r.rows), rowCount: r.rows.length - 1 };
};
