// Entry point: routing, event wiring, keyboard shortcuts.
import * as actions from './actions.js';
import { findTask, loadState, state, storageAvailable, subscribe } from './store.js';
import { dateISO, isValidISO } from './utils.js';
import { initCloud } from './cloud.js';
import { initShare } from './share.js';
import { initAccount } from './ui/account.js';
import { initViewerLink } from './ui/viewerLink.js';
import { initTuner } from './ui/tuner.js';
import { renderCatchup } from './ui/catchup.js';
import { renderAudit } from './ui/audit.js';
import { renderCalendar, shiftWeek } from './ui/calendar.js';
import { renderDashboard } from './ui/dashboard.js';
import { initTimer } from './ui/insights.js';
import { currentDayISO, renderDay, setDay, shiftDay } from './ui/day.js';
import { infoDialog } from './ui/dialogs.js';
import { $, $$, renderKeepingFocus } from './ui/dom.js';
import { clearErrors, renderSettings, showFieldError } from './ui/settings.js';
import { readInputs, renderSimulator, showResult } from './ui/simulator.js';
import { filteredTasks, renderTasks, selection, updateSelectionUI } from './ui/tasks.js';
import { toast } from './ui/toast.js';

const PAGES = {
  dashboard: { title: 'Dashboard', render: renderDashboard },
  day: { title: 'Daily view', render: renderDay },
  calendar: { title: 'Weekly calendar', render: renderCalendar },
  tasks: { title: 'Task library', render: renderTasks },
  simulator: { title: 'What-if simulator', render: renderSimulator },
  data: { title: 'Data audit', render: renderAudit },
  settings: { title: 'Settings', render: renderSettings },
};
const ORDER = Object.keys(PAGES);
let current = 'dashboard';

// ---- routing -----------------------------------------------------------------------------

/** '#day/2026-10-14' -> { name: 'day', arg: '2026-10-14' }; unknown hashes fall back to the dashboard. */
function parseHash(h = location.hash) {
  const [name, arg] = h.replace(/^#\/?/, '').split('/');
  return { name: PAGES[name] ? name : null, arg };
}
const pageFromHash = () => parseHash().name || 'dashboard';
// Wide enough for the Daily view's two columns (Light | Focused): open on it by default, since that is the working screen.
const TWO_COLUMNS = '(min-width: 901px)';
const landingPage = () => parseHash().name || (window.matchMedia?.(TWO_COLUMNS).matches ? 'day' : 'dashboard');

function showPage(name, { moveFocus = true, arg } = {}) {
  current = PAGES[name] ? name : 'dashboard';
  if (current === 'day') {
    const d = arg ?? parseHash().arg;
    if (d && isValidISO(d)) setDay(d);
    else if (!$('#dayDate').value) setDay($('#focusDate').value);
  }
  $$('.page').forEach((p) => { p.hidden = p.id !== `page-${current}`; });
  $$('#nav a').forEach((a) => {
    if (a.dataset.page === current) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = `${PAGES[current].title} · MBBS Study Command Center`;
  PAGES[current].render();
  renderCatchup();
  if (moveFocus) {
    // Move focus to the page heading so keyboard and screen-reader users land at the top of the new view.
    const h = $(`#h-${current}`);
    h?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }
}

/** Navigate immediately (so callers can focus things afterwards); the hashchange that follows is a no-op. */
function go(name, arg) {
  const hash = arg ? `#${name}/${arg}` : `#${name}`;
  showPage(name, { arg });
  if (location.hash !== hash) location.hash = hash;
}

/** Keep the address bar in step with the day being viewed, without adding history entries. */
function syncDayHash() {
  history.replaceState(null, '', `#day/${currentDayISO()}`);
}

window.addEventListener('hashchange', () => {
  const { name, arg } = parseHash();
  // Other hashes (e.g. in-page anchors) are left alone. Same page + same day: nothing to do.
  if (name && (name !== current || (name === 'day' && arg && arg !== currentDayISO()))) showPage(name, { arg });
});

// The skip link must not go through the router: just move focus to <main>.
$('.skip-link').addEventListener('click', (e) => {
  e.preventDefault();
  $('#main').focus();
});

function rerender() {
  renderKeepingFocus(() => { PAGES[current].render(); renderCatchup(); });
}
subscribe(rerender);

// ---- delegated clicks / changes --------------------------------------------------------------

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;
  switch (action) {
    case 'toggle-btn': {
      const t = findTask(id);
      if (t) actions.toggleDone(id, !t.done);
      break;
    }
    case 'move': actions.moveTask(id); break;
    case 'edit': actions.editTask(id); break;
    case 'replace': actions.replaceTaskAction(id); break;
    case 'quick-add-task': actions.addTask({ date: id, block: el.dataset.block || '' }); break;
    case 'delete-task': actions.deleteTaskAction(id); break;
    case 'split': actions.splitTaskAction(id); break;
    case 'auto-place': actions.autoPlaceAction(id); break;
    case 'add-to-date': actions.addToDate(id, el.dataset.block || 'focus'); break;
    case 'remove-extra': {
      const [iso, i] = id.split(':');
      actions.removeExtra(iso, Number(i));
      break;
    }
    case 'respread': actions.respreadFromToday(); break;
    case 'fix-overflow': actions.fixOverflowAction(id, el.dataset.block); break;
    default: break;
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches?.('input[type=checkbox][data-action="toggle"]')) {
    actions.toggleDone(el.dataset.id, el.checked);
  } else if (el.matches?.('input[data-select]')) {
    el.checked ? selection.add(el.dataset.select) : selection.delete(el.dataset.select);
    updateSelectionUI();
  }
});

// ---- theme ---------------------------------------------------------------------------------------

const THEMES = ['auto', 'light', 'dark'];
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  $('#themeBtn').textContent = `Theme: ${t[0].toUpperCase()}${t.slice(1)}`;
  try { if (t === 'auto') localStorage.removeItem('mbbsTheme'); else localStorage.setItem('mbbsTheme', t); } catch { /* ignore */ }
}
$('#themeBtn').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || 'auto';
  applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
});
applyTheme(document.documentElement.dataset.theme || 'auto');
initTimer();

// ---- header ------------------------------------------------------------------------------------

$('#exportBtn').addEventListener('click', actions.exportBackup);
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) await actions.importBackup(f);
});
$('#helpBtn').addEventListener('click', showShortcuts);

// ---- dashboard ---------------------------------------------------------------------------------

$('#focusDate').addEventListener('change', (e) => {
  if (!isValidISO(e.target.value)) e.target.value = dateISO(new Date());
  $('#weekDate').value = e.target.value;
  renderDashboard();
});

// ---- daily view --------------------------------------------------------------------------------

$('#dayDate').addEventListener('change', (e) => {
  if (!isValidISO(e.target.value)) setDay(dateISO(new Date()));
  syncDayHash();
  renderDay();
});
$('#prevDay').addEventListener('click', () => { shiftDay(-1); syncDayHash(); renderDay(); });
$('#nextDay').addEventListener('click', () => { shiftDay(1); syncDayHash(); renderDay(); });
$('#todayDay').addEventListener('click', () => { setDay(dateISO(new Date())); syncDayHash(); renderDay(); });
$('#extraForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#extraText');
  const err = actions.addExtra(currentDayISO(), input.value);
  $('#extraErr').textContent = err;
  $('#extraErr').hidden = !err;
  if (!err) input.value = '';
  input.focus();
});
$('#daySettingsBtn').addEventListener('click', () => actions.dayDialog(currentDayISO()));

// ---- calendar ----------------------------------------------------------------------------------

$('#weekDate').addEventListener('change', (e) => {
  if (!isValidISO(e.target.value)) e.target.value = $('#focusDate').value || dateISO(new Date());
  renderCalendar();
});
$('#prevWeek').addEventListener('click', () => { shiftWeek(-7); renderCalendar(); });
$('#nextWeek').addEventListener('click', () => { shiftWeek(7); renderCalendar(); });
$('#todayWeek').addEventListener('click', () => { $('#weekDate').value = dateISO(new Date()); renderCalendar(); });

$('#planForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const res = await actions.runGenerate(actions.readPlanForm(form));
  if (res.error) toast(res.error, { type: 'error', ms: 8000 });
});
$('#clearPlan').addEventListener('click', actions.clearPlan);
$('#downloadPlanCsv').addEventListener('click', actions.downloadPlanCsv);

// ---- task library --------------------------------------------------------------------------------

['searchTask', 'subjectFilter', 'categoryFilter', 'statusFilter'].forEach((id) => $('#' + id).addEventListener('input', renderTasks));
$('#clearFilters').addEventListener('click', () => {
  ['searchTask', 'subjectFilter', 'categoryFilter', 'statusFilter'].forEach((id) => { $('#' + id).value = ''; });
  renderTasks();
  $('#searchTask').focus();
});
$('#addTaskBtn').addEventListener('click', actions.addTask);
$('#selectAll').addEventListener('change', (e) => {
  filteredTasks().forEach((t) => (e.target.checked ? selection.add(t.id) : selection.delete(t.id)));
  renderTasks();
});
$('#bulkScheduleBtn').addEventListener('click', async () => {
  if (await actions.bulkSchedule([...selection])) selection.clear();
  renderTasks();
});

// ---- simulator -------------------------------------------------------------------------------------

$('#simForm').addEventListener('submit', (e) => {
  e.preventDefault();
  actions.runSimulation(readInputs());
  showResult(readInputs());
});
$('#simForm').addEventListener('input', () => showResult(readInputs()));
$('#sendToBacklog').addEventListener('click', () => {
  actions.runSimulation(readInputs());
  actions.createBacklogItem($('#simHours').value);
});

// ---- data audit ------------------------------------------------------------------------------------

$('#exportTasksCsv').addEventListener('click', actions.downloadTaskCsv);
$('#importTasksBtn').addEventListener('click', () => $('#taskCsvFile').click());
$('#taskCsvFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) await actions.importTaskCsv(f);
});

// ---- settings ----------------------------------------------------------------------------------------

$('#settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  clearErrors();
  const values = Object.fromEntries(new FormData(e.currentTarget).entries());
  const res = actions.saveSettings(values);
  if (res.error) {
    showFieldError(res.field, res.error);
    toast(`Settings not saved: ${res.error}`, { type: 'error' });
  }
});
$('#resetBtn').addEventListener('click', async () => {
  if (await actions.resetAll()) $('#focusDate').value = dateISO(new Date());
});

// ---- keyboard shortcuts -------------------------------------------------------------------------------

function isTyping(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const textual = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
  return textual && el.type !== 'checkbox' && el.type !== 'button';
}

function showShortcuts() {
  infoDialog({
    title: 'Keyboard shortcuts',
    body: `<dl class="shortcuts">
      <dt><kbd>Alt</kbd> + <kbd>1</kbd>–<kbd>7</kbd></dt><dd>Jump to Dashboard, Daily view, Weekly calendar, Tasks, Simulator, Data audit, Settings</dd>
      <dt><kbd>/</kbd></dt><dd>Search the task library</dd>
      <dt><kbd>[</kbd> and <kbd>]</kbd></dt><dd>Previous / next week (calendar) or day (daily view)</dd>
      <dt><kbd>T</kbd></dt><dd>Jump to today (calendar and daily view)</dd>
      <dt><kbd>?</kbd></dt><dd>Show this list</dd>
      <dt><kbd>Esc</kbd></dt><dd>Close a dialog</dd>
      <dt><kbd>Tab</kbd> / <kbd>Shift</kbd> + <kbd>Tab</kbd></dt><dd>Move between controls; use <kbd>Space</kbd> to tick boxes and <kbd>Enter</kbd> to press buttons</dd>
    </dl>`,
  });
}

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || document.querySelector('dialog[open]')) return;
  if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-7]$/.test(e.key)) {
    e.preventDefault();
    go(ORDER[Number(e.key) - 1]);
    return;
  }
  if (e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return;
  if (e.key === '/') {
    e.preventDefault();
    go('tasks');
    $('#searchTask').focus();
  } else if (e.key === '?') {
    e.preventDefault();
    showShortcuts();
  } else if (current === 'day' && (e.key === '[' || e.key === ']' || e.key === 't' || e.key === 'T')) {
    e.preventDefault();
    if (e.key === '[') shiftDay(-1); else if (e.key === ']') shiftDay(1); else setDay(dateISO(new Date()));
    syncDayHash();
    renderDay();
  } else if (current === 'calendar' && (e.key === '[' || e.key === ']')) {
    e.preventDefault();
    shiftWeek(e.key === '[' ? -7 : 7);
    renderCalendar();
    $('#weekGrid').querySelector('.day a')?.focus({ preventScroll: true });
  } else if (current === 'calendar' && (e.key === 't' || e.key === 'T')) {
    e.preventDefault();
    $('#weekDate').value = dateISO(new Date());
    renderCalendar();
  }
});

// ---- boot --------------------------------------------------------------------------------------------

loadState();
$('#focusDate').value = dateISO(new Date());
$('#weekDate').value = $('#focusDate').value;
showPage(landingPage(), { moveFocus: false });
if (!state.planMeta && !state.tasks.some((t) => t.scheduledDate)) {
  // First visit: build the default plan so the calendar is not empty.
  actions.runGenerate({}, { silent: true });
} else {
  // Data saved by the single-capacity version: rebuild once so light and focused work are separated.
  actions.migrateIfNeeded();
}
if (!storageAvailable()) {
  toast('Your browser is blocking local storage, so progress will not be saved. Use Export backup to keep a copy.', { type: 'warn', ms: 0 });
}

initTuner();
initAccount();
initViewerLink();
initShare();
initCloud();

// Offline support: cache the app shell (skipped silently where service workers are unavailable).
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
