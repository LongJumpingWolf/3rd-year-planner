import { simulate, weekdayCapacity } from '../planner.js';
import { state } from '../store.js';
import { fmtHours } from '../utils.js';
import { $, setProgress } from './dom.js';

let filledFor = null;

export function renderSimulator() {
  // Fill the inputs from saved values only when the saved object changes (load, import, reset).
  if (filledFor !== state.simLast) {
    filledFor = state.simLast;
    $('#simHours').value = state.simLast.hours;
    $('#simReserve').value = state.simLast.reserve;
    $('#simDays').value = state.simLast.days;
    $('#simExisting').value = state.simLast.existing;
  }
  showResult(readInputs());
}

export function readInputs() {
  return { hours: $('#simHours').value, reserve: $('#simReserve').value, days: $('#simDays').value, existing: $('#simExisting').value };
}

export function showResult(values) {
  const cap = weekdayCapacity(state.settings);
  const r = simulate(values, cap);
  $('#simRemain').textContent = fmtHours(Math.max(0, r.remain) * 3600) + (r.remain < 0 ? ` (short by ${fmtHours(-r.remain * 3600)})` : '');
  $('#simPerDay').textContent = `${r.perDay.toFixed(2)} h`;
  $('#simLoad').textContent = `${r.load.toFixed(2)} h/day`;
  $('#simRisk').textContent = r.risk;
  const color = r.remain < 0 ? 'var(--bad)' : r.remain === 0 ? 'var(--warn)' : 'var(--good)';
  setProgress($('#simBarWrap'), $('#simBar'), r.reserve > 0 ? (Math.max(0, r.remain) / r.reserve) * 100 : 0, color);
  $('#simAdvice').textContent = r.remain < 0
    ? 'This change exceeds the available reserve. Spread the work across more days, defer lower-priority items, or accept a later finish date.'
    : r.load > cap
      ? `The reserve covers the extra hours, but those days would carry more than your ${cap} h weekday capacity. Use lighter days or spread the work further.`
      : 'This shift fits your reserve and daily capacity. Check it against college, DAMS and exam constraints before applying.';
  return r;
}
