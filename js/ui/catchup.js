// Banner shown on every page when lectures planned for days that are already over are still open.
import { overdueLectures } from '../actions.js';
import { lectureKey } from '../planner.js';
import { $ } from './dom.js';

export function renderCatchup() {
  const box = $('#catchup');
  const n = new Set(overdueLectures().map(lectureKey)).size;
  box.hidden = n === 0;
  if (!n) return;
  $('#catchupText').textContent = `${n} lecture${n === 1 ? '' : 's'} planned for earlier days ${n === 1 ? 'is' : 'are'} still open. Re-spread them over the days that are left so the load stays even and nothing piles up.`;
}
