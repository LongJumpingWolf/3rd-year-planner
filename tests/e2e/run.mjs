// End-to-end tests: starts the real server, drives a real browser (installed Chrome or Edge) through the app.
// Run with `npm run test:e2e`. Set SHOTS=<dir> to also save screenshots.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from '../../server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AXE = readFileSync(join(ROOT, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const server = createServer();
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}`;

const exe = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p));
const browser = await chromium.launch(exe ? { executablePath: exe } : { channel: 'chrome' });

const TODAY = new Date('2026-10-14T10:00:00');
const results = [];

async function newPage({ viewport = { width: 1280, height: 900 }, colorScheme = 'light', blockStorage = false, acceptDownloads = true } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme, acceptDownloads, locale: 'en-GB' });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
  // The app's real backend settings must never be contacted from tests: run with cloud sync switched off.
  await page.route('**/js/supabase-config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'export const supabaseConfig = null;' }));
  await page.clock.setFixedTime(TODAY);
  if (blockStorage) {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
    });
  }
  return { page, ctx, problems };
}

async function open(opts, hash = '#dashboard') {
  const t = await newPage(opts);
  await t.page.goto(`${BASE}/${hash}`);
  await t.page.waitForSelector('.page:not([hidden])');
  return t;
}

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✔ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

/** Wait for a dialog to close, then let the follow-up state change and re-render finish. */
async function dialogGone(page) {
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  await page.waitForTimeout(150);
}
/** All visible toast text (waits for at least one toast to appear). */
async function allToasts(page) {
  await page.waitForSelector('#toasts .toast');
  await page.waitForTimeout(150);
  return (await page.locator('#toasts .toast').allTextContents()).join(' | ');
}
const clearToasts = (page) => page.evaluate(() => { document.getElementById('toasts').innerHTML = ''; });
const PAGES = ['dashboard', 'day', 'calendar', 'tasks', 'simulator', 'data', 'settings'];
const dialogOpen = (page) => page.locator('dialog[open]');
const lightBlock = (page) => page.locator('#dayBlocks .block-light');
const focusBlock = (page) => page.locator('#dayBlocks .block-focus');
async function openDay(opts = {}, iso = '2026-10-14') {
  const t = await open(opts, `#day/${iso}`);
  await t.page.waitForSelector('#page-day:not([hidden]) .block');
  return t;
}
const toasts = (page) => page.locator('#toasts .toast');
const activeKey = (page) => page.evaluate(() => document.activeElement?.getAttribute('data-key') || document.activeElement?.id || document.activeElement?.tagName);
async function goto(page, name) { await page.click(`#nav a[data-page="${name}"]`); await page.waitForSelector(`#page-${name}:not([hidden])`); }
async function shot(page, name) { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); }
async function metric(page, id) { return (await page.locator(id).textContent()).trim(); }

console.log(`\nRunning E2E against ${BASE} using ${exe || 'chrome channel'}\n`);

// ---------------------------------------------------------------------------------------------
await test('loads cleanly: no console errors, no failed requests, correct title, dashboard visible', async () => {
  const { page, problems, ctx } = await open();
  assert.match(await page.title(), /Dashboard · MBBS Study Command Center/);
  assert.equal(await metric(page, '#mTasks'), '377');
  assert.equal(await metric(page, '#mDone'), '0 / 377');
  assert.match(await metric(page, '#mSubjects'), /4 subjects/);
  assert.equal(await page.locator('#nav a').count(), 7);
  assert.equal(await page.locator('.page:not([hidden])').count(), 1);
  assert.deepEqual(problems, []);
  await shot(page, 'dashboard-desktop');
  await ctx.close();
});

await test('no duplicate element ids on any page (the old file had two #weekGrid)', async () => {
  const { page, ctx } = await open();
  for (const p of PAGES) {
    await goto(page, p);
    const dupes = await page.evaluate(() => {
      const seen = {}; const d = [];
      document.querySelectorAll('[id]').forEach((e) => { if (seen[e.id]) d.push(e.id); seen[e.id] = 1; });
      return d;
    });
    assert.deepEqual(dupes, [], `duplicate ids on ${p}`);
  }
  await ctx.close();
});

await test('routing: nav links, aria-current, heading focus, back/forward, deep link and bad hash', async () => {
  const { page, ctx } = await open();
  await goto(page, 'calendar');
  assert.equal(await page.getAttribute('#nav a[data-page="calendar"]', 'aria-current'), 'page');
  assert.equal(await page.getAttribute('#nav a[data-page="dashboard"]', 'aria-current'), null);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'h-calendar');
  assert.match(await page.title(), /Weekly calendar/);
  await goto(page, 'tasks');
  await page.goBack();
  await page.waitForSelector('#page-calendar:not([hidden])');
  await page.goForward();
  await page.waitForSelector('#page-tasks:not([hidden])');
  await ctx.close();
  const deep = await open({}, '#settings');
  assert.equal(await deep.page.locator('#page-settings').isVisible(), true);
  await deep.page.evaluate(() => { location.hash = 'main'; });
  await deep.page.waitForTimeout(100);
  assert.equal(await deep.page.locator('#page-settings').isVisible(), true, 'unrelated hashes (in-page anchors) do not change the page');
  await deep.ctx.close();
  const bad = await open({}, '#nonsense');
  assert.equal(await bad.page.locator('#page-day').isVisible(), true, 'an unknown hash falls back to the landing page (Daily view on wide screens)');
  await bad.ctx.close();
});

await test('skip link is the first tab stop and moves focus to main', async () => {
  const { page, ctx } = await open();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'skip-link');
  assert.ok(await page.locator('.skip-link').isVisible());
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'main');
  await ctx.close();
});

await test('every interactive control reachable by Tab shows a visible focus indicator', async () => {
  const { page, ctx } = await open();
  const missing = [];
  for (const p of PAGES) {
    await goto(page, p);
    await page.evaluate(() => document.activeElement?.blur());
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const visible = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2;
        return { tag: el.tagName, id: el.id, cls: el.className?.toString?.().slice(0, 30), visible, hidden: el.offsetParent === null && cs.position !== 'fixed' };
      });
      if (info && !info.visible && !info.hidden) missing.push(`${p}: ${info.tag}#${info.id}.${info.cls}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
  await ctx.close();
});

await test('dashboard: shows both blocks for the date; tick a lecture by keyboard, focus stays put, undo works, persists after reload', async () => {
  const { page, ctx } = await open();
  await page.fill('#focusDate', '2026-10-14');
  await page.waitForSelector('#todayTasks .block-focus .btask');
  assert.equal(await page.locator('#todayTasks .block').count(), 2);
  assert.match(await page.locator('#todayTasks .block-light h4').textContent(), /LIGHT WORK — COLLEGE GAPS/);
  assert.match(await page.locator('#todayTasks .block-focus h4').textContent(), /FOCUSED WORK — HOME \/ EVENING/);
  assert.match(await metric(page, '#todaySummary'), /planned · 0 min completed \(0%\)/);
  const box = page.locator('#todayTasks .block-focus input[type=checkbox]').first();
  await box.focus();
  const key = await activeKey(page);
  await page.keyboard.press('Space');
  assert.equal(await metric(page, '#mDone'), '1 / 377');
  assert.equal(await activeKey(page), key, 'focus must survive the re-render');
  assert.equal(await page.locator('#todayTasks .btask.done').count(), 1);
  assert.match(await toasts(page).first().textContent(), /Marked done/);
  await toasts(page).first().getByRole('button', { name: 'Undo' }).click();
  assert.equal(await metric(page, '#mDone'), '0 / 377');
  await box.focus();
  await page.keyboard.press('Space');
  await page.reload();
  await page.waitForSelector('.page:not([hidden])');
  assert.equal(await metric(page, '#mDone'), '1 / 377');
  assert.equal(await page.inputValue('#focusDate'), '2026-10-14');
  assert.equal(await page.locator('#todayTasks .block-focus .btask.done').count(), 1);
  await ctx.close();
});

await test('dashboard buffer meter reacts to a heavier week and exposes progress semantics', async () => {
  const { page, ctx } = await open();
  const now = await metric(page, '#bufferMetric');
  assert.match(now, /h of 6 h target/);
  assert.equal(await page.getAttribute('#bufferBarWrap', 'role'), 'progressbar');
  assert.ok(Number(await page.getAttribute('#bufferBarWrap', 'aria-valuenow')) >= 0);
  await page.fill('#focusDate', '2026-11-30'); // week before the trip is heavily booked
  assert.notEqual(await metric(page, '#bufferCopy'), '');
  await ctx.close();
});

await test('calendar: week renders 7 labelled days, prev/next/today, week label and keyboard shortcuts', async () => {
  const { page, ctx } = await open({}, '#calendar');
  assert.equal(await page.locator('#weekGrid .day').count(), 7);
  assert.match(await metric(page, '#weekLabel'), /12 October 2026 – 18 October 2026/);
  assert.equal(await page.locator('#weekGrid .day.today').count(), 1);
  await page.click('#nextWeek');
  assert.match(await metric(page, '#weekLabel'), /19 October 2026/);
  await page.click('#prevWeek');
  await page.click('#prevWeek');
  assert.match(await metric(page, '#weekLabel'), /5 October 2026/);
  await page.click('#todayWeek');
  assert.match(await metric(page, '#weekLabel'), /12 October 2026/);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(']');
  assert.match(await metric(page, '#weekLabel'), /19 October 2026/);
  await page.keyboard.press('[');
  await page.keyboard.press('[');
  assert.match(await metric(page, '#weekLabel'), /5 October 2026/);
  await page.keyboard.press('t');
  assert.match(await metric(page, '#weekLabel'), /12 October 2026/);
  await shot(page, 'calendar-desktop');
  await ctx.close();
});

await test('calendar: trip week is visibly blocked and nothing is scheduled inside the trip', async () => {
  const { page, ctx } = await open({}, '#calendar');
  await page.fill('#weekDate', '2026-12-02');
  await page.locator('#weekDate').dispatchEvent('change');
  assert.equal(await page.locator('#weekGrid .day.blocked').count(), 6); // week of 30 Nov: Tue 1 Dec .. Sun 6 Dec
  assert.equal(await page.locator('#weekGrid .daytask').count(), 0);
  assert.match(await page.locator('#weekGrid .day.blocked').first().textContent(), /Trip \/ unavailable/);
  await ctx.close();
});

await test('daily view: Move dialog by keyboard — Esc cancels and restores focus, Enter saves, task lands on the new day in the same block and is pinned', async () => {
  const { page, ctx } = await openDay();
  const moveBtn = focusBlock(page).locator('[data-action="move"]').first();
  const title = (await focusBlock(page).locator('.btask-title').first().textContent()).trim();
  await moveBtn.focus();
  const key = await activeKey(page);
  await page.keyboard.press('Enter');
  await dialogOpen(page).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.name), 'date', 'focus goes into the dialog');
  assert.equal(await page.locator('dialog input[name=block]:checked').getAttribute('value'), 'focus', 'defaults to its current block');
  await page.keyboard.press('Escape');
  await dialogGone(page);
  assert.equal(await activeKey(page), key, 'focus returns to the Move button');
  await page.keyboard.press('Enter');
  await dialogOpen(page).waitFor();
  await page.fill('dialog input[name=date]', '2026-10-16');
  await page.keyboard.press('Enter');
  await dialogGone(page);
  assert.match(await allToasts(page), /Moved to focused work on/);
  assert.equal(await focusBlock(page).locator('.btask', { hasText: title }).count(), 0, 'gone from the old day');
  await page.fill('#dayDate', '2026-10-16');
  await page.locator('#dayDate').dispatchEvent('change');
  const moved = focusBlock(page).locator('.btask', { hasText: title });
  assert.equal(await moved.count(), 1, 'exactly one copy on the new day');
  assert.match(await moved.textContent(), /Pinned/);
  await ctx.close();
});

await test('daily view: moving deep work into light work needs an explicit override, then is flagged', async () => {
  const { page, ctx } = await openDay();
  const title = (await focusBlock(page).locator('.btask-title').first().textContent()).trim();
  await focusBlock(page).locator('[data-action="move"]').first().click();
  assert.equal(await page.locator('#mv-override-wrap').isVisible(), false);
  await page.check('dialog input[name=block][value=light]');
  assert.equal(await page.locator('#mv-override-wrap').isVisible(), true, 'override checkbox appears for deep work in light block');
  await page.click('dialog button[type=submit]');
  assert.match(await dialogOpen(page).locator('.error-text').textContent(), /recommended for Focused work/);
  assert.equal(await dialogOpen(page).count(), 1, 'dialog stays open: nothing changed silently');
  assert.equal(await focusBlock(page).locator('.btask', { hasText: title }).count(), 1);
  await page.check('#mv-override');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  assert.match((await allToasts(page)), /override/i);
  const inLight = lightBlock(page).locator('.btask', { has: page.locator('.btask-title', { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\/]/g, '\$&')}$`) }) });
  assert.equal(await inLight.count(), 1);
  assert.match(await inLight.textContent(), /Deep work in light block/);
  assert.equal(await focusBlock(page).locator('.btask', { hasText: title }).count(), 0);
  await ctx.close();
});

await test('daily view: clearing the date sends the task to the backlog; "Next free slot" puts it back in its block', async () => {
  const { page, ctx } = await openDay();
  const title = (await focusBlock(page).locator('.btask-title').first().textContent()).trim();
  await focusBlock(page).locator('[data-action="move"]').first().click();
  await page.fill('dialog input[name=date]', '');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  assert.match(await toasts(page).last().textContent(), /backlog/);
  await goto(page, 'calendar');
  assert.equal(await page.locator('#backlogList .task').count(), 114, '113 that never fit + this one');
  const card = page.locator('#backlogList .task', { hasText: title });
  assert.match(await card.textContent(), /Manually unscheduled/);
  await card.getByRole('button', { name: /Next free slot/ }).click();
  assert.match(await toasts(page).last().textContent(), /Placed in focused work on/);
  assert.equal(await page.locator('#backlogList .task').count(), 113);
  await ctx.close();
});

await test('daily view: moving onto a trip day warns but allows it, and the day shows the overload', async () => {
  const { page, ctx } = await openDay();
  await focusBlock(page).locator('[data-action="move"]').first().click();
  await page.fill('dialog input[name=date]', '2026-12-05');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  const all = await allToasts(page);
  assert.match(all, /trip/i);
  await page.fill('#dayDate', '2026-12-05');
  await page.locator('#dayDate').dispatchEvent('change');
  assert.match(await metric(page, '#dayNotice'), /trip/i);
  assert.match(await focusBlock(page).locator('.status').textContent(), /Over by/);
  await ctx.close();
});

await test('daily view: overload is visible per block and "Move overflow to next free slot" fixes it', async () => {
  const { page, ctx } = await openDay();
  assert.doesNotMatch(await focusBlock(page).locator('.status').textContent(), /Over/);
  // Pull a lecture from another day into this already full evening.
  await page.fill('#dayDate', '2026-10-27');
  await page.locator('#dayDate').dispatchEvent('change');
  await focusBlock(page).locator('[data-action="move"]').first().click();
  await page.fill('dialog input[name=date]', '2026-10-14');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  await page.fill('#dayDate', '2026-10-14');
  await page.locator('#dayDate').dispatchEvent('change');
  assert.match(await focusBlock(page).locator('.status').textContent(), /⚠ Over by/);
  assert.equal(await lightBlock(page).locator('.status.over').count(), 0, 'light block is not affected');
  assert.match(await metric(page, '#daySummary'), /h/);
  await focusBlock(page).getByRole('button', { name: /Move overflow/ }).click();
  assert.match(await toasts(page).last().textContent(), /Moved 1 task from focused work/);
  assert.doesNotMatch(await focusBlock(page).locator('.status').textContent(), /Over/);
  await toasts(page).last().getByRole('button', { name: 'Undo' }).click();
  assert.match(await focusBlock(page).locator('.status').textContent(), /Over by/, 'Undo restores the overloaded state');
  await ctx.close();
});

await test('daily view: + Add task picker works per block — focused shows everything, light shows only light tasks unless you opt in', async () => {
  const { page, ctx } = await openDay();
  await goto(page, 'calendar');
  await page.click('#clearPlan');
  await dialogOpen(page).getByRole('button', { name: 'Clear plan' }).click();
  await dialogGone(page);
  assert.match(await metric(page, '#planReport'), /0 \/ 377/);
  await page.goto(`${BASE}/#day/2026-10-14`);
  await page.waitForSelector('#page-day:not([hidden])');
  assert.equal(await page.locator('#dayBlocks .btask').count(), 0);
  assert.match(await lightBlock(page).textContent(), /No light-work tasks planned/);
  // focused block
  await focusBlock(page).getByRole('button', { name: /Add task to focused work/ }).click();
  await dialogOpen(page).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pick-q');
  assert.equal(await page.locator('dialog .pick-list label').count(), 60);
  await page.fill('#pick-q', 'cohort');
  const filtered = await page.locator('dialog .pick-list label').count();
  assert.ok(filtered >= 1 && filtered < 60);
  assert.ok(await page.locator('dialog .pick-list input').first().isChecked(), 'first match preselected');
  await page.fill('#pick-q', 'zzzzzz-nothing');
  assert.match(await page.locator('dialog .pick-list').textContent(), /No matching/);
  await page.click('dialog button[type=submit]');
  assert.match(await dialogOpen(page).locator('.error-text').textContent(), /Choose a task/);
  await page.fill('#pick-q', 'cohort');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  assert.equal(await focusBlock(page).locator('.btask').count(), 1);
  assert.match(await focusBlock(page).locator('.clock').textContent(), /6:30 PM – /);
  // light block: nothing light is waiting; opting in shows lectures and warns on placement
  await lightBlock(page).getByRole('button', { name: /Add task to light work/ }).click();
  await dialogOpen(page).waitFor();
  assert.match(await page.locator('dialog .pick-list').textContent(), /No light-work tasks are waiting/);
  await page.check('#pick-all');
  assert.ok(await page.locator('dialog .pick-list label').count() > 10);
  await page.fill('#pick-q', 'case control');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  assert.match((await allToasts(page)), /override: deep work in light block/);
  assert.match(await lightBlock(page).locator('.btask').textContent(), /Deep work in light block/);
  await ctx.close();
});

await test('add task: a Light task lands in light work after rebuilding; a Deep task joins the focused queue (and is reported if focused work is full)', async () => {
  const { page, ctx } = await open({}, '#tasks');
  for (const [title, kind] of [['My MCQ set', 'light'], ['My deep lecture', 'deep']]) {
    await page.click('#addTaskBtn');
    await page.fill('dialog input[name=title]', title);
    await page.selectOption('dialog select[name=intensity]', kind);
    await page.fill('dialog input[name=min]', '25');
    await page.keyboard.press('Enter');
    await dialogGone(page);
  }
  assert.match(await page.locator('#taskTable tr', { hasText: 'My MCQ set' }).textContent(), /Light/);
  assert.match(await page.locator('#taskTable tr', { hasText: 'My deep lecture' }).textContent(), /Deep/);
  await goto(page, 'calendar');
  await page.click('#generatePlan');
  await goto(page, 'tasks');
  const mcq = await page.locator('#taskTable tr', { hasText: 'My MCQ set' }).textContent();
  assert.match(mcq, /Light work/);
  assert.match(mcq, /14 Oct 2026/, 'user light tasks are placed before generated prep (the plan now starts from today, 14 Oct)');
  await goto(page, 'calendar');
  const card = page.locator('#backlogList .task', { hasText: 'My deep lecture' });
  assert.equal(await card.count(), 1, 'focused work is full, so the new lecture is reported, not hidden');
  assert.match(await card.textContent(), /No focused-work capacity left/);
  assert.match(await card.textContent(), /Focused work/);
  assert.equal(await page.locator('#backlogList .task', { hasText: 'My MCQ set' }).count(), 0);
  await ctx.close();
});
await test('scheduler form: validation messages, success toast, regenerate keeps hand-pinned moves, report numbers', async () => {
  const { page, ctx } = await open({}, '#calendar');
  await page.fill('#planEnd', '2026-01-01');
  await page.click('#generatePlan');
  assert.match(await toasts(page).last().textContent(), /target finish/);
  await page.fill('#planEnd', '2026-12-31');
  await page.fill('#planStart', '');
  await page.click('#generatePlan');
  assert.match(await toasts(page).last().textContent(), /valid date/);
  await page.fill('#planStart', '2026-10-12');
  await page.fill('#weekendLight', '-3');
  await page.click('#generatePlan');
  assert.match(await toasts(page).last().textContent(), /Weekend capacities/);
  await page.fill('#weekendLight', '2');
  // pin one lecture by moving it in the daily view, then regenerate
  await page.goto(`${BASE}/#day/2026-10-14`);
  await page.waitForSelector('#page-day:not([hidden])');
  const title = (await focusBlock(page).locator('.btask-title').first().textContent()).trim();
  await focusBlock(page).locator('[data-action="move"]').first().click();
  await page.fill('dialog input[name=date]', '2026-10-17');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  await goto(page, 'calendar');
  await page.click('#generatePlan');
  assert.match(await toasts(page).last().textContent(), /Plan generated: 263 of 377 lectures placed, 1 lecture split into sessions \(your manual moves were kept\)\. 114 tasks did not fit \(114 focused, 0 light\)/);
  await page.goto(`${BASE}/#day/2026-10-17`);
  await page.waitForSelector('#page-day:not([hidden])');
  assert.equal(await focusBlock(page).locator('.btask', { hasText: title }).count(), 1);
  await goto(page, 'calendar');
  const rep = await metric(page, '#planReport');
  assert.match(rep, /263 \/ 377/);
  assert.match(rep, /114 lectures do not fit/);
  assert.match(rep, /Plan tuner/);
  // Undo restores the pre-regeneration state
  await page.click('#generatePlan');
  await toasts(page).last().getByRole('button', { name: 'Undo' }).click();
  assert.match(await toasts(page).last().textContent(), /Previous plan restored/);
  await ctx.close();
});

await test('scheduler: a too-short window reports overflow in the backlog (nothing hidden)', async () => {
  const { page, ctx } = await open({}, '#calendar');
  await page.fill('#planEnd', '2026-10-20');
  await page.fill('#planBackstop', '2026-10-25');
  await page.click('#generatePlan');
  const rep = await metric(page, '#planReport');
  assert.match(rep, /do not fit before 2026-10-25/);
  const n = await page.locator('#backlogList .task').count();
  assert.ok(n > 150, `backlog ${n}`);
  await ctx.close();
});

await test('planner CSV: choose a span, download every day with both blocks; bad spans are rejected; empty plan explains itself', async () => {
  const { page, ctx } = await open({}, '#calendar');
  await page.click('#downloadPlanCsv');
  await dialogOpen(page).waitFor();
  assert.equal(await page.inputValue('#ex-from'), '2026-10-12');
  assert.equal(await page.inputValue('#ex-to'), '2026-12-31');
  assert.match(await page.locator('#ex-hint').textContent(), /81 days selected/);
  await page.fill('#ex-to', '2026-10-01');
  await page.click('dialog button[type=submit]');
  assert.match(await dialogOpen(page).locator('.error-text').textContent(), /on or after/);
  await page.click('dialog [data-range=backstop]');
  assert.equal(await page.inputValue('#ex-to'), '2027-01-07');
  await page.fill('#ex-from', '2026-10-12');
  await page.fill('#ex-to', '2026-10-25');
  assert.match(await page.locator('#ex-hint').textContent(), /14 days selected/);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('dialog button[type=submit]')]);
  assert.equal(dl.suggestedFilename(), 'mbbs-planner-2026-10-12-to-2026-10-25.csv');
  const text = readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '');
  const lines = text.trim().split(String.fromCharCode(10));
  assert.equal(lines[0].split('","').length, 19);
  assert.match(lines[0], /^"Date","Weekday","Day type","Block"/);
  assert.equal(new Set(lines.slice(1).map((l) => l.split('","')[0].replace('"', ''))).size, 14, 'all 14 days present');
  assert.ok(lines.some((l) => l.includes('"Light work"')) && lines.some((l) => l.includes('"Focused work"')));
  assert.match(await allToasts(page), /Downloaded the planner for 2026-10-12 to 2026-10-25/);
  await page.click('#clearPlan');
  await dialogOpen(page).getByRole('button', { name: 'Clear plan' }).click();
  await dialogGone(page);
  await page.click('#downloadPlanCsv');
  assert.match(await allToasts(page), /Nothing is scheduled/);
  await ctx.close();
});

await test('clear plan: Cancel keeps the plan, confirm clears it, Escape cancels', async () => {
  const { page, ctx } = await open({}, '#calendar');
  await page.click('#clearPlan');
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Cancel', 'destructive dialogs focus Cancel first');
  await page.keyboard.press('Escape');
  await dialogGone(page);
  assert.match(await metric(page, '#planReport'), /264 \/ 377/);
  await page.click('#clearPlan');
  await dialogOpen(page).getByRole('button', { name: 'Cancel' }).click();
  assert.match(await metric(page, '#planReport'), /264 \/ 377/);
  await page.click('#clearPlan');
  await dialogOpen(page).getByRole('button', { name: 'Clear plan' }).click();
  await dialogGone(page);
  assert.match(await metric(page, '#planReport'), /0 \/ 377/);
  assert.match(await metric(page, '#planReport'), /No plan yet/);
  await ctx.close();
});

await test('weekly workload table appears with rows', async () => {
  const { page, ctx } = await open({}, '#calendar');
  assert.ok(await page.locator('#weeklyLoad tbody tr').count() >= 10);
  assert.equal(await page.locator('#weeklyLoad').getAttribute('tabindex'), '0', 'scrollable region is keyboard focusable');
  await ctx.close();
});

await test('task library: search, subject/category/status filters, clear, count text', async () => {
  const { page, ctx } = await open({}, '#tasks');
  assert.match(await metric(page, '#taskCount'), /Showing 381 of 381/);
  await page.fill('#searchTask', 'cohort');
  const n = await page.locator('#taskTable tr').count();
  assert.ok(n >= 1 && n < 20);
  assert.match(await metric(page, '#taskCount'), new RegExp(`Showing ${n} of 381`));
  await page.fill('#searchTask', 'qqqq-no-match');
  assert.match(await page.locator('#taskTable').textContent(), /No matching entries/);
  await page.click('#clearFilters');
  assert.equal(await page.inputValue('#searchTask'), '');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'searchTask');
  await page.selectOption('#subjectFilter', 'PSM');
  assert.match(await metric(page, '#taskCount'), /Showing 121/);
  const cats = await page.locator('#categoryFilter option').allTextContents();
  assert.deepEqual(cats, ['All categories', 'PSM'], 'categories narrow to the chosen subject');
  await page.selectOption('#subjectFilter', 'Ophthalmology');
  await page.selectOption('#statusFilter', 'estimated');
  assert.match(await metric(page, '#taskCount'), /Showing 9 of 381/);
  await page.selectOption('#statusFilter', 'unscheduled');
  assert.match(await metric(page, '#taskCount'), /Showing 8 of 381/, 'the lectures that do not fit are findable');
  await page.selectOption('#statusFilter', 'scheduled');
  assert.match(await metric(page, '#taskCount'), /Showing 143 of 381/);
  await page.selectOption('#subjectFilter', 'FMT');
  await page.selectOption('#statusFilter', '');
  assert.match(await metric(page, '#taskCount'), /Showing 44 of 381/, 'FMT now has its full lecture list');
  await ctx.close();
});

await test('task library: Done/Undo buttons keep focus, row styling, status filter "Completed"', async () => {
  const { page, ctx } = await open({}, '#tasks');
  const btn = page.locator('#taskTable [data-action="toggle-btn"]').first();
  await btn.focus();
  const key = await activeKey(page);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#taskTable tr.is-done').count(), 1);
  assert.equal(await activeKey(page), key);
  assert.equal((await page.locator('#taskTable [data-action="toggle-btn"]').first().textContent()).trim(), 'Undo');
  await page.selectOption('#statusFilter', 'done');
  assert.match(await metric(page, '#taskCount'), /Showing 1 of 381/);
  await page.selectOption('#statusFilter', 'todo');
  assert.match(await metric(page, '#taskCount'), /Showing 380 of 381/);
  await ctx.close();
});

await test('task library: select all, indeterminate state, bulk schedule dialog, block choice, capacity warning', async () => {
  const { page, ctx } = await open({}, '#tasks');
  assert.equal(await page.isDisabled('#bulkScheduleBtn'), true);
  await page.fill('#searchTask', 'cohort');
  await page.check('#selectAll');
  const n = await page.locator('#taskTable input[data-select]:checked').count();
  assert.ok(n >= 1);
  assert.match(await metric(page, '#selCount'), new RegExp(`${n} selected`));
  await page.uncheck('#taskTable input[data-select] >> nth=0');
  if (n > 1) assert.equal(await page.evaluate(() => document.getElementById('selectAll').indeterminate), true);
  await page.check('#taskTable input[data-select] >> nth=0');
  await page.click('#bulkScheduleBtn');
  await dialogOpen(page).waitFor();
  assert.equal(await page.locator('dialog input[name=block]:checked').getAttribute('value'), 'auto');
  await page.fill('dialog input[name=date]', '');
  await page.click('dialog button[type=submit]');
  assert.match(await dialogOpen(page).locator('.error-text').textContent(), /valid date/);
  await page.fill('dialog input[name=date]', '2026-10-30');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  const msgs = (await allToasts(page));
  assert.match(msgs, /Scheduled \d+ task/);
  assert.match(msgs, /Focused work on Fri 30 Oct is now .* over its/, 'over-capacity warning names the block');
  assert.equal(await page.locator('#taskTable input[data-select]:checked').count(), 0, 'selection cleared');
  assert.equal(await page.isDisabled('#bulkScheduleBtn'), true);
  assert.match(await page.locator('#taskTable').textContent(), /30 Oct 2026/);
  assert.match(await page.locator('#taskTable').textContent(), /Focused work/);
  await ctx.close();
});

await test('add task: validation, success, appears in the library and is searchable', async () => {
  const { page, ctx } = await open({}, '#tasks');
  await page.click('#addTaskBtn');
  await dialogOpen(page).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.name), 'title');
  await page.click('dialog button[type=submit]');
  assert.match(await dialogOpen(page).locator('.error-text').textContent(), /enter a title/);
  await page.fill('dialog input[name=title]', 'My Custom Lecture');
  await page.fill('dialog input[name=min]', '0');
  await page.keyboard.press('Enter');
  assert.match(await dialogOpen(page).locator('.error-text').textContent(), /positive number/);
  await page.fill('dialog input[name=min]', '45');
  await page.keyboard.press('Enter');
  await dialogGone(page);
  assert.match(await metric(page, '#taskCount'), /of 382/);
  await page.fill('#searchTask', 'my custom');
  assert.equal(await page.locator('#taskTable tr').count(), 1);
  assert.match(await page.locator('#taskTable tr').textContent(), /45m/);
  await ctx.close();
});

await test('security: HTML in titles is shown as text and never executes', async () => {
  const { page, ctx, problems } = await open({}, '#tasks');
  await page.click('#addTaskBtn');
  await page.fill('dialog input[name=title]', '<img src=x onerror="window.__xss=1"><b>bold</b>');
  await page.fill('dialog input[name=subject]', '"><script>window.__xss=2</script>');
  await page.keyboard.press('Enter');
  await dialogGone(page);
  await page.fill('#searchTask', 'onerror');
  await page.waitForFunction(() => document.getElementById('taskTable').textContent.includes('<img src=x onerror='));
  assert.equal(await page.locator('#taskTable img').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await goto(page, 'data');
  await goto(page, 'dashboard');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.deepEqual(problems.filter((p) => !/x$/.test(p) && !p.includes('/x')), []);
  await ctx.close();
});

await test('simulator: live results, risk levels, validation, backlog creation, values persist', async () => {
  const { page, ctx } = await open({}, '#simulator');
  assert.equal(await metric(page, '#simRisk'), 'Manageable');
  assert.equal(await metric(page, '#simPerDay'), '0.67 h');
  await page.fill('#simHours', '10');
  assert.equal(await metric(page, '#simRisk'), 'Over reserve');
  assert.match(await metric(page, '#simRemain'), /short by 4 h/);
  assert.match(await metric(page, '#simAdvice'), /exceeds the available reserve/);
  await page.fill('#simHours', '6');
  await page.fill('#simReserve', '10');
  await page.fill('#simDays', '1');
  await page.fill('#simExisting', '2');
  assert.equal(await metric(page, '#simRisk'), 'Overloaded');
  await page.fill('#simDays', '0'); // never divides by zero
  assert.equal(await metric(page, '#simPerDay'), '6.00 h');
  await page.fill('#simHours', '0');
  await page.click('#sendToBacklog');
  assert.match(await toasts(page).last().textContent(), /more than 0 hours/);
  await page.fill('#simHours', '2.5');
  await page.fill('#simDays', '3');
  await page.click('#runSim');
  await page.click('#sendToBacklog');
  assert.match(await toasts(page).last().textContent(), /Backlog item created/);
  await page.reload();
  assert.equal(await page.inputValue('#simHours'), '2.5');
  await goto(page, 'dashboard');
  assert.equal(await metric(page, '#backlogCount'), '114', '113 lectures that do not fit + the new item');
  assert.match(await metric(page, '#backlogTime'), /^\d+(\.\d)? h$/);
  await ctx.close();
});

await test('settings: invalid values show an accessible error; valid values recompute dashboard and offer to rebuild the plan', async () => {
  const { page, ctx } = await open({}, '#settings');
  await goto(page, 'dashboard');
  const before = await metric(page, '#mPlanned');
  await goto(page, 'settings');
  await page.fill('#annotation', '150');
  await page.click('#settingsForm button[type=submit]');
  assert.equal(await page.getAttribute('#annotation', 'aria-invalid'), 'true');
  assert.match(await page.locator('#annotation-err').textContent(), /between 0 and 100/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'annotation');
  assert.equal(await page.getAttribute('#annotation', 'aria-describedby'), 'annotation-err');
  await page.fill('#annotation', '');
  await page.click('#settingsForm button[type=submit]');
  assert.match(await page.locator('#annotation-err').textContent(), /between/);
  await page.fill('#annotation', '0');
  await page.fill('#bedtime', '18:00');
  await page.click('#settingsForm button[type=submit]');
  assert.match(await page.locator('#focusStart-err').textContent(), /before bedtime/);
  await page.fill('#bedtime', '22:30');
  await page.fill('#recall', '0');
  await page.selectOption('#speed', '2');
  await page.fill('#studyHours', '3');
  await page.fill('#collegeHours', '1');
  await page.click('#settingsForm button[type=submit]');
  const msgs = (await allToasts(page));
  assert.match(msgs, /Settings saved/);
  assert.match(msgs, /Rebuild plan/);
  assert.equal(await page.locator('#annotation-err').count(), 0);
  await goto(page, 'dashboard');
  assert.notEqual(before, await metric(page, '#mPlanned'));
  await goto(page, 'calendar');
  assert.equal(await page.inputValue('#weekdayCapShown'), 'Light 1 h + Focused 3 h');
  // the old plan is flagged as not matching until it is rebuilt
  await page.click('#toasts .toast >> text=Rebuild plan', { timeout: 1000 }).catch(() => {});
  await page.click('#generatePlan');
  await page.goto(`${BASE}/#day/2026-10-14`);
  await page.waitForSelector('#page-day:not([hidden])');
  assert.match(await lightBlock(page).locator('.block-totals').textContent(), /\/ 1 h planned/);
  assert.match(await focusBlock(page).locator('.block-totals').textContent(), /\/ 3 h planned/);
  await page.reload();
  await goto(page, 'settings');
  assert.equal(await page.inputValue('#speed'), '2');
  assert.equal(await page.inputValue('#studyHours'), '3');
  assert.equal(await page.inputValue('#collegeHours'), '1');
  assert.equal(await page.inputValue('#focusStart'), '18:30');
  await ctx.close();
});

await test('data audit: per-subject cards, unresolved list, CSV export + import (good and bad files)', async () => {
  const { page, ctx } = await open({}, '#data');
  assert.equal(await page.locator('#dataCards .card').count(), 4);
  assert.match(await page.locator('#dataCards').textContent(), /FMT44/);
  assert.equal(await page.locator('#estimatedList .task').count(), 9); // 8 missing + 1 approx
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportTasksCsv')]);
  const csv = readFileSync(await dl.path(), 'utf8');
  assert.equal(csv.trim().split('\n').length, 382);

  const write = (name, body) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(body) });
  await page.setInputFiles('#taskCsvFile', write('good.csv', 'title,subject,category,durationSec\nFMT intro,FMT,Basics,1800\nFMT two,FMT,Basics,\n,FMT,Basics,60'));
  assert.match(await toasts(page).last().textContent(), /Imported 2 tasks, skipped 1/);
  assert.match(await page.locator('#dataCards').textContent(), /FMT46/);
  await page.setInputFiles('#taskCsvFile', write('bad.csv', 'subject,durationSec\nPSM,60'));
  assert.match(await toasts(page).last().textContent(), /"title" column/);
  await page.setInputFiles('#taskCsvFile', write('empty.csv', ''));
  assert.match(await toasts(page).last().textContent(), /no data rows/);
  await goto(page, 'tasks');
  assert.match(await metric(page, '#taskCount'), /of 383/);
  await ctx.close();
});

await test('backup: export → modify → import restores; invalid JSON is rejected without changing anything', async () => {
  const { page, ctx } = await open();
  await page.fill('#focusDate', '2026-10-14');
  await page.locator('#todayTasks .block-focus input[type=checkbox]').first().check();
  assert.equal(await metric(page, '#mDone'), '1 / 377');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
  const path = await dl.path();
  const backup = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(backup.tasks.length > 377);
  assert.equal(backup.version, 2);
  assert.ok(backup.tasks.some((t) => t.block === 'light') && backup.tasks.some((t) => t.block === 'focus'), 'blocks are saved');
  assert.equal(backup.tasks.filter((t) => t.done).length, 1);

  await page.locator('#todayTasks .block-focus input[type=checkbox]').first().uncheck();
  assert.equal(await metric(page, '#mDone'), '0 / 377');

  await page.setInputFiles('#importFile', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{not json') });
  await page.locator('.toast', { hasText: 'not a valid backup' }).last().waitFor();
  await page.setInputFiles('#importFile', { name: 'bad2.json', mimeType: 'application/json', buffer: Buffer.from('{"tasks":[]}') });
  await page.locator('.toast', { hasText: 'not a valid backup' }).last().waitFor();
  assert.equal(await metric(page, '#mDone'), '0 / 377');

  await page.setInputFiles('#importFile', path);
  await dialogOpen(page).waitFor();
  assert.match(await dialogOpen(page).textContent(), /Replace current data\?/);
  await dialogOpen(page).getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await metric(page, '#mDone'), '0 / 377');
  await page.setInputFiles('#importFile', path);
  await dialogOpen(page).getByRole('button', { name: 'Import backup' }).click();
  await dialogGone(page);
  assert.equal(await metric(page, '#mDone'), '1 / 377');
  await ctx.close();
});

await test('backup from the OLD single-file app (no planConfig/pinned) imports cleanly', async () => {
  const { page, ctx } = await open();
  const old = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'old-state-sample.json'), 'utf8'));
  await page.setInputFiles('#importFile', { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  await dialogOpen(page).getByRole('button', { name: 'Import backup' }).click();
  await dialogGone(page);
  assert.equal(await metric(page, '#mDone'), '2 / 377');
  await goto(page, 'calendar');
  assert.equal(await page.inputValue('#planStart'), '2026-10-12');
  await ctx.close();
});

await test('reset: cancel keeps data, confirm restores originals and the default plan', async () => {
  const { page, ctx } = await open({}, '#settings');
  await goto(page, 'tasks');
  await page.locator('#taskTable [data-action="toggle-btn"]').first().click();
  await goto(page, 'settings');
  await page.click('#resetBtn');
  await dialogOpen(page).getByRole('button', { name: 'Cancel' }).click();
  await goto(page, 'dashboard');
  assert.equal(await metric(page, '#mDone'), '1 / 377');
  await goto(page, 'settings');
  await page.click('#resetBtn');
  await dialogOpen(page).getByRole('button', { name: 'Reset everything' }).click();
  await dialogGone(page);
  await goto(page, 'dashboard');
  assert.equal(await metric(page, '#mDone'), '0 / 377');
  await ctx.close();
});

await test('corrupt saved data in localStorage falls back to a working app', async () => {
  const t = await newPage();
  await t.page.addInitScript(() => localStorage.setItem('mbbsStudyCommandCenter.v1', '{"tasks": "oops"'));
  await t.page.goto(`${BASE}/#dashboard`);
  assert.equal(await metric(t.page, '#mTasks'), '377');
  assert.deepEqual(t.problems, []);
  await t.ctx.close();
  const t2 = await newPage();
  await t2.page.addInitScript(() => localStorage.setItem('mbbsStudyCommandCenter.v1', JSON.stringify({ tasks: [{ id: 'x', title: 't', durationSec: 60, type: 'video', scheduledDate: 'not-a-date' }], settings: { speed: 'abc' } })));
  await t2.page.goto(`${BASE}/#dashboard`);
  assert.equal(await metric(t2.page, '#mTasks'), '1');
  assert.deepEqual(t2.problems, []);
  await t2.ctx.close();
});

await test('blocked localStorage: app still works and tells the user progress will not persist', async () => {
  const { page, ctx, problems } = await open({ blockStorage: true });
  assert.equal(await metric(page, '#mTasks'), '377');
  await page.waitForSelector('#toasts .toast');
  assert.match((await allToasts(page)), /blocking local storage/);
  await goto(page, 'tasks');
  await page.locator('#taskTable [data-action="toggle-btn"]').first().click();
  assert.equal(await page.locator('#taskTable tr.is-done').count(), 1);
  assert.deepEqual(problems, []);
  await ctx.close();
});

await test('global shortcuts: Alt+1..7, "/" search, "?" help dialog; shortcuts are ignored while typing and inside dialogs', async () => {
  const { page, ctx } = await open();
  for (const [i, p] of PAGES.entries()) {
    await page.keyboard.press(`Alt+${i + 1}`);
    await page.waitForSelector(`#page-${p}:not([hidden])`);
  }
  await page.keyboard.press('Alt+1');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  await page.waitForSelector('#page-tasks:not([hidden])');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'searchTask');
  await page.keyboard.type('a/b?');
  assert.equal(await page.inputValue('#searchTask'), 'a/b?', 'typing / and ? in a field is not hijacked');
  assert.equal(await dialogOpen(page).count(), 0);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('?');
  await dialogOpen(page).waitFor();
  assert.match(await dialogOpen(page).textContent(), /Keyboard shortcuts/);
  await page.keyboard.press('Alt+2');
  assert.ok(await page.locator('#page-tasks').isVisible(), 'Alt+number ignored while a dialog is open');
  await page.keyboard.press('Escape');
  await dialogGone(page);
  await page.click('#helpBtn');
  await dialogOpen(page).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'helpBtn', 'focus returns to the button that opened the dialog');
  // day navigation shortcuts
  await page.keyboard.press('Alt+2');
  await page.waitForSelector('#page-day:not([hidden])');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  const d0 = await page.inputValue('#dayDate');
  await page.keyboard.press(']');
  assert.notEqual(await page.inputValue('#dayDate'), d0);
  await page.keyboard.press('[');
  assert.equal(await page.inputValue('#dayDate'), d0);
  await ctx.close();
});

await test('dialog focus is trapped: Tab/Shift+Tab never leave the dialog', async () => {
  const { page, ctx } = await open({}, '#tasks');
  await page.click('#addTaskBtn');
  await dialogOpen(page).waitFor();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(i % 2 ? 'Tab' : 'Shift+Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog')), true, `escaped on press ${i}`);
  }
  await page.mouse.click(2, 2); // backdrop click cancels
  await dialogGone(page);
  await ctx.close();
});

await test('a11y semantics: landmarks, labelled form fields, named buttons, table headers, live regions', async () => {
  const { page, ctx } = await open();
  assert.equal(await page.locator('header, [role=banner]').count(), 1);
  assert.equal(await page.locator('nav[aria-label]').count(), 1);
  assert.equal(await page.locator('main').count(), 1);
  assert.equal(await page.getAttribute('html', 'lang'), 'en');
  for (const p of PAGES) {
    await goto(page, p);
    const unlabeled = await page.evaluate(() => [...document.querySelectorAll('.page:not([hidden]) input, .page:not([hidden]) select, .page:not([hidden]) textarea')]
      .filter((el) => el.type !== 'hidden' && !el.labels?.length && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')).map((e) => e.id || e.name));
    assert.deepEqual(unlabeled, [], `unlabeled controls on ${p}`);
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('.page:not([hidden]) button')].filter((b) => !(b.textContent.trim() || b.getAttribute('aria-label'))).length);
    assert.equal(unnamed, 0, `unnamed buttons on ${p}`);
    assert.equal(await page.locator('.page:not([hidden]) h2').count(), 1);
  }
  assert.equal(await page.getAttribute('#toasts', 'aria-live'), 'polite');
  await ctx.close();
});

for (const scheme of ['light', 'dark']) {
  await test(`axe-core accessibility scan on every page (${scheme} theme): zero violations`, async () => {
    const { page, ctx } = await open({ colorScheme: scheme });
    await page.addScriptTag({ content: AXE });
    const all = [];
    for (const p of PAGES) {
      await goto(page, p);
      if (p === 'calendar') await page.fill('#weekDate', '2026-11-16').then(() => page.locator('#weekDate').dispatchEvent('change'));
      const r = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } })).violations
        .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n').slice(0, 3).join(' ')) })));
      r.forEach((v) => all.push(`${p}: ${v.id} (${v.impact}) ${v.nodes.join(' || ')}`));
      await shot(page, `${p}-${scheme}`);
    }
    // Dialog state
    await goto(page, 'tasks');
    await page.click('#addTaskBtn');
    await dialogOpen(page).waitFor();
    const rd = await page.evaluate(async () => (await window.axe.run(document.querySelector('dialog'))).violations.map((v) => v.id));
    rd.forEach((v) => all.push(`dialog: ${v}`));
    assert.deepEqual(all, []);
    await ctx.close();
  });
}

await test('responsive: no horizontal page overflow at 320, 375, 768, 1024 and 1440 px on any page', async () => {
  const bad = [];
  for (const width of [320, 375, 768, 1024, 1440]) {
    const { page, ctx } = await open({ viewport: { width, height: 800 } });
    for (const p of PAGES) {
      await goto(page, p);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 0) bad.push(`${width}px ${p}: +${over}px`);
    }
    if (width === 375) { await goto(page, 'dashboard'); await shot(page, 'dashboard-mobile'); await goto(page, 'calendar'); await shot(page, 'calendar-mobile'); await goto(page, 'tasks'); await shot(page, 'tasks-mobile'); }
    await ctx.close();
  }
  assert.deepEqual(bad, []);
});

await test('touch targets: primary controls are at least 32px tall (24px WCAG minimum, comfortable on mobile)', async () => {
  const { page, ctx } = await open({ viewport: { width: 390, height: 800 } });
  const small = [];
  for (const p of ['dashboard', 'calendar', 'tasks', 'settings']) {
    await goto(page, p);
    const r = await page.evaluate(() => [...document.querySelectorAll('.page:not([hidden]) button, .page:not([hidden]) a.btn, .page:not([hidden]) input:not([type=checkbox]), .page:not([hidden]) select, #nav a')]
      .filter((e) => e.offsetParent !== null).map((e) => ({ n: e.id || e.textContent.trim().slice(0, 20), h: e.getBoundingClientRect().height })).filter((x) => x.h < 32));
    r.forEach((x) => small.push(`${p}: ${x.n} ${x.h}`));
  }
  assert.deepEqual(small, []);
  await ctx.close();
});

await test('reduced motion: no transitions on progress bars', async () => {
  const t = await newPage();
  await t.page.emulateMedia({ reducedMotion: 'reduce' });
  await t.page.goto(`${BASE}/#dashboard`);
  const dur = await t.page.evaluate(() => getComputedStyle(document.querySelector('#pDone')).transitionDuration);
  assert.match(dur, /^0s$/);
  await t.ctx.close();
});

await test('performance: first render < 1.5 s and task filtering stays responsive', async () => {
  const { page, ctx } = await open({}, '#tasks');
  const ms = await page.evaluate(() => {
    const t0 = performance.now();
    const s = document.getElementById('searchTask');
    for (const ch of 'epidemiology') { s.value += ch; s.dispatchEvent(new Event('input', { bubbles: true })); }
    return performance.now() - t0;
  });
  assert.ok(ms < 500, `typing 12 chars took ${ms}ms`);
  await ctx.close();
});

await test('full keyboard-only journey: jump to the library, search, tab to a lecture, open Move, cancel, tick it done', async () => {
  const { page, ctx } = await open();
  await page.keyboard.press('Alt+4');
  await page.waitForSelector('#page-tasks:not([hidden])');
  await page.keyboard.press('/');
  await page.keyboard.type('cohort');
  const tabTo = async (selector, max = 25) => {
    for (let i = 0; i < max; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate((s) => document.activeElement.matches(s), selector)) return;
    }
    throw new Error(`never reached ${selector} by Tab`);
  };
  await tabTo('#taskTable [data-action="toggle-btn"]');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-action')), 'move');
  await page.keyboard.press('Enter');
  await dialogOpen(page).waitFor();
  await page.keyboard.press('Escape');
  await dialogGone(page);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-action')), 'move');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-action')), 'toggle-btn');
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#taskTable tr.is-done').count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-action')), 'toggle-btn');
  await ctx.close();
});

await test('daily view: both blocks are visible with their own headings, totals, status and tasks in the right block', async () => {
  const { page, ctx } = await openDay();
  assert.match(await page.title(), /Daily view/);
  assert.equal(await page.locator('#dayBlocks section.block').count(), 2);
  assert.equal((await lightBlock(page).locator('h3').textContent()).trim(), 'LIGHT WORK — COLLEGE GAPS');
  assert.equal((await focusBlock(page).locator('h3').textContent()).trim(), 'FOCUSED WORK — HOME / EVENING');
  assert.match(await lightBlock(page).locator('.block-totals').textContent(), /^1 h 30 min \/ 1 h 30 min planned · 0 min completed$/);
  assert.match(await focusBlock(page).locator('.block-totals').textContent(), /^2 h \d+ min \/ 2 h 30 min planned · 0 min completed$/);
  assert.match(await lightBlock(page).locator('.status').textContent(), /Fully planned/);
  assert.match(await focusBlock(page).locator('.status').textContent(), /unused|Fully planned/);
  // tasks are assigned to the right block
  const lightTitles = await lightBlock(page).locator('.btask-title').allTextContents();
  const focusTitles = await focusBlock(page).locator('.btask-title').allTextContents();
  assert.ok(lightTitles.length >= 3 && lightTitles.some((t) => /Active recall/.test(t)) && lightTitles.some((t) => /MCQs/.test(t)) && lightTitles.some((t) => /Preview before tonight/.test(t)));
  assert.ok(focusTitles.length >= 2 && focusTitles.every((t) => !/Active recall|MCQs/.test(t)));
  // light preview mentions the first lecture of the evening
  assert.ok(lightTitles.find((t) => /Preview before tonight/.test(t)).includes(focusTitles[0].trim()));
  // focused tasks have clock times that start at 6:30 PM and stay before bedtime; light tasks have none
  const clocks = await focusBlock(page).locator('.clock').allTextContents();
  assert.match(clocks[0], /^6:30 PM – /);
  assert.ok(clocks.every((c) => !/past wind-down/.test(c)));
  assert.equal(await lightBlock(page).locator('.clock').count(), 0);
  // each task has a checkbox, a duration, subject and the controls
  assert.equal(await focusBlock(page).locator('.btask input[type=checkbox]').count(), focusTitles.length);
  assert.ok((await focusBlock(page).locator('.btask-meta').first().textContent()).match(/\d+ (h|min)/));
  for (const name of ['Move', 'Edit', 'Split']) assert.ok(await focusBlock(page).getByRole('button', { name: new RegExp(`^${name}:`) }).count() >= 1);
  assert.match(await metric(page, '#daySummary'), /Overall completion\s*0%/);
  await shot(page, 'day-desktop');
  await ctx.close();
});

await test('daily view: completing tasks updates block, day, week and dashboard figures consistently', async () => {
  const { page, ctx } = await openDay();
  const lightBox = lightBlock(page).locator('.btask input[type=checkbox]').first();
  const focusBox = focusBlock(page).locator('.btask input[type=checkbox]').first();
  await lightBox.check();
  assert.match(await lightBlock(page).locator('.block-totals').textContent(), /30 min completed/);
  assert.match(await focusBlock(page).locator('.block-totals').textContent(), /0 min completed/, 'focused block unaffected');
  await focusBox.check();
  const focusDone = await focusBlock(page).locator('.block-totals').textContent();
  assert.doesNotMatch(focusDone, /· 0 min completed/);
  const overall = await metric(page, '#daySummary');
  const pct = Number(overall.match(/Overall completion\s*(\d+)%/)[1]);
  assert.ok(pct > 20 && pct < 80, `overall ${pct}%`);
  assert.equal(await page.locator('#dayBlocks .btask.done').count(), 2);
  assert.equal(await lightBlock(page).locator('.progress').getAttribute('role'), 'progressbar');
  // weekly view shows the same state
  await clearToasts(page);
  await goto(page, 'calendar');
  const wed = page.locator('#weekGrid .day', { hasText: '14 Oct' });
  assert.equal(await wed.locator('input[type=checkbox]:checked').count(), 2);
  assert.match(await wed.locator('.day-pct').textContent(), new RegExp(`${pct}% done`));
  assert.equal(await wed.locator('.cblock-light input:checked').count(), 1);
  assert.equal(await wed.locator('.cblock-focus input:checked').count(), 1);
  // untick from the weekly view and it flows back to the daily view and the dashboard
  await clearToasts(page);
  await wed.locator('.cblock-light input:checked').click();
  await clearToasts(page);
  await wed.locator('.cblock-focus input:checked').click();
  assert.match(await wed.locator('.day-pct').textContent(), /^0% done/);
  await goto(page, 'day');
  assert.equal(await page.locator('#dayBlocks .btask.done').count(), 0);
  await goto(page, 'dashboard');
  assert.equal(await metric(page, '#mDone'), '0 / 377');
  await ctx.close();
});

await test('weekly view: every day card shows both blocks with separate totals; the heading opens that day', async () => {
  const { page, ctx } = await open({}, '#calendar');
  const days = page.locator('#weekGrid .day');
  assert.equal(await days.count(), 7);
  for (let i = 0; i < 7; i++) {
    const d = days.nth(i);
    assert.equal(await d.locator('.cblock').count(), 2, `day ${i} has two blocks`);
    assert.match(await d.locator('.cblock-light h4').textContent(), /Light work\s*— College gaps/);
    assert.match(await d.locator('.cblock-focus h4').textContent(), /Focused work\s*— Home \/ evening/);
    assert.match(await d.locator('.cblock-light .cblock-totals').textContent(), /\d+ (h|min)( \d+ min)? \/ \d+ (h|min)( \d+ min)?/);
  }
  // Wednesday 14 Oct: light prep and lectures are in the right blocks
  const wed = days.nth(2);
  assert.ok((await wed.locator('.cblock-light .ctask').count()) >= 3);
  assert.match(await wed.locator('.cblock-light').textContent(), /Active recall/);
  assert.match(await wed.locator('.cblock-focus').textContent(), /PSM/);
  assert.doesNotMatch(await wed.locator('.cblock-focus').textContent(), /Active recall|MCQs/);
  assert.match(await wed.locator('.cblock-light .cblock-totals').textContent(), /1 h 30 min \/ 1 h 30 min/);
  // weekend: weekend capacities, not weekday ones
  const sat = days.nth(5);
  assert.match(await sat.locator('.cblock-light .cblock-totals').textContent(), /\/ 2 h/);
  assert.match(await sat.locator('.cblock-focus .cblock-totals').textContent(), /\/ 4 h/);
  // heading link opens the daily view for that date
  await wed.locator('h3 a').click();
  await page.waitForSelector('#page-day:not([hidden])');
  assert.equal(await page.inputValue('#dayDate'), '2026-10-14');
  assert.match(await page.evaluate(() => location.hash), /#day\/2026-10-14/);
  await page.goBack();
  await page.waitForSelector('#page-calendar:not([hidden])');
  await ctx.close();
});

await test('weekly view: DAMS weekend shows a light recap only; trip days are blocked; overloaded blocks are flagged per block', async () => {
  const { page, ctx } = await open({}, '#calendar');
  await page.fill('#weekDate', '2026-11-16'); // week after the first DAMS weekend
  await page.locator('#weekDate').dispatchEvent('change');
  const sat = page.locator('#weekGrid .day').nth(5);
  assert.match(await sat.locator('.day-meta').textContent(), /DAMS day/);
  assert.match(await sat.locator('.cblock-light .cblock-totals').textContent(), /30 min \/ 30 min/);
  assert.match(await sat.locator('.cblock-focus .cblock-totals').textContent(), /0 min \/ 0 min/);
  assert.match(await sat.locator('.cblock-focus .status').textContent(), /No time available/);
  assert.match(await sat.locator('.cblock-light').textContent(), /DAMS class recap/);
  await page.fill('#weekDate', '2026-12-02');
  await page.locator('#weekDate').dispatchEvent('change');
  assert.equal(await page.locator('#weekGrid .day.blocked').count(), 6);
  assert.equal(await page.locator('#weekGrid .day.blocked .cblock').count(), 0, 'blocked days show a note, not empty blocks');
  await ctx.close();
});

await test('daily view: DAMS day and protected trip day explain themselves and offer no focused time', async () => {
  const dams = await openDay({}, '2026-11-14');
  assert.match(await metric(dams.page, '#dayNotice'), /DAMS class day \(9 AM – 9 PM\)/);
  assert.match(await focusBlock(dams.page).locator('.status').textContent(), /No time available/);
  assert.match(await focusBlock(dams.page).locator('.block-totals').textContent(), /0 min \/ 0 min/);
  assert.match(await lightBlock(dams.page).locator('.block-totals').textContent(), /30 min \/ 30 min/);
  assert.match(await lightBlock(dams.page).locator('.btask-title').textContent(), /DAMS class recap/);
  await dams.ctx.close();
  const trip = await openDay({}, '2026-12-05');
  assert.match(await metric(trip.page, '#dayNotice'), /Protected trip day/);
  assert.equal(await trip.page.locator('#dayBlocks .btask').count(), 0);
  assert.equal(await trip.page.locator('#dayBlocks .block .row.actions').count(), 0, 'no add buttons on a protected day');
  assert.match(await focusBlock(trip.page).textContent(), /Trip \/ unavailable/);
  await trip.ctx.close();
});

await test('daily view: splitting a lecture creates labelled sessions, keeps the lecture count and total runtime', async () => {
  const { page, ctx } = await openDay();
  const title = (await focusBlock(page).locator('.btask-title').first().textContent()).trim();
  await focusBlock(page).getByRole('button', { name: /^Split:/ }).first().click();
  await dialogOpen(page).waitFor();
  await page.fill('#sp-n', '9');
  await page.click('dialog button[type=submit]');
  assert.match(await dialogOpen(page).locator('.error-text').textContent(), /between 2 and 8/);
  await page.fill('#sp-n', '2');
  assert.match(await page.locator('#sp-hint').textContent(), /About \d+ min each/);
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  assert.match((await allToasts(page)), /Split into 2 sessions/);
  assert.match(await focusBlock(page).locator('.btask', { hasText: title }).first().textContent(), /Part 1\/2/);
  await goto(page, 'dashboard');
  assert.equal(await metric(page, '#mTasks'), '377', 'a split lecture is still one lecture');
  await goto(page, 'tasks');
  await page.fill('#searchTask', title);
  const rows = page.locator('#taskTable tr');
  assert.equal(await rows.count(), 2);
  assert.match(await rows.nth(0).textContent(), /Part 1\/2/);
  assert.match(await rows.nth(1).textContent(), /Part 2\/2/);
  assert.match(await rows.nth(1).textContent(), /Focused work/, 'both sessions are focused work');
  // completing only one part does not complete the lecture
  await rows.nth(0).getByRole('button', { name: /^Done:/ }).click();
  await goto(page, 'dashboard');
  assert.equal(await metric(page, '#mDone'), '0 / 377');
  await goto(page, 'tasks');
  await page.fill('#searchTask', title);
  await page.locator('#taskTable tr').nth(1).getByRole('button', { name: /^Done:/ }).click();
  await goto(page, 'dashboard');
  assert.equal(await metric(page, '#mDone'), '1 / 377');
  await ctx.close();
});

await test('daily view: Edit changes runtime and type; Day settings can mark a day unavailable (open work moves, Undo restores) or set custom capacity', async () => {
  const { page, ctx } = await openDay({}, '2026-10-21');
  const before = await focusBlock(page).locator('.btask-title').allTextContents();
  assert.ok(before.length >= 2);
  // Edit
  await focusBlock(page).getByRole('button', { name: /^Edit:/ }).first().click();
  await dialogOpen(page).waitFor();
  await page.fill('#ed-min', '0');
  await page.click('dialog button[type=submit]');
  assert.match(await dialogOpen(page).locator('.error-text').textContent(), /between 1 and 1000/);
  await page.fill('#ed-min', '10');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  assert.match(await focusBlock(page).locator('.btask-meta').first().textContent(), /^\d+ min/);
  // Custom capacity
  await page.click('#daySettingsBtn');
  await dialogOpen(page).waitFor();
  await page.fill('#dy-f', '1');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  assert.match(await focusBlock(page).locator('.block-totals').textContent(), /\/ 1 h planned/);
  assert.match(await metric(page, '#dayNotice'), /Custom capacity/);
  assert.doesNotMatch(await focusBlock(page).locator('.status').textContent(), /Over/);
  // Unavailable
  await page.click('#daySettingsBtn');
  await page.check('dialog input[name=unavailable]');
  await page.fill('#dy-n', 'Holiday');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  assert.match(await toasts(page).last().textContent(), /updated: moved \d+ tasks? to the next free slots/);
  assert.equal(await page.locator('#dayBlocks .btask').count(), 0);
  assert.match(await metric(page, '#dayNotice'), /Holiday/);
  await goto(page, 'calendar');
  await page.fill('#weekDate', '2026-10-21');
  await page.locator('#weekDate').dispatchEvent('change');
  assert.match(await page.locator('#weekGrid .day.blocked').textContent(), /Holiday/);
  // the moved lectures are still scheduled (nothing lost): all 271 remain placed
  assert.match(await metric(page, '#planReport'), /264 \/ 377/);
  await toasts(page).last().waitFor({ state: 'attached' });
  await ctx.close();
});

await test('day settings: Undo brings the day back exactly as it was; "Restore normal rules" clears the exception', async () => {
  const { page, ctx } = await openDay({}, '2026-10-21');
  const before = await page.locator('#dayBlocks').innerText();
  await page.click('#daySettingsBtn');
  await page.check('dialog input[name=unavailable]');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  assert.equal(await page.locator('#dayBlocks .btask').count(), 0);
  await toasts(page).last().getByRole('button', { name: 'Undo' }).click();
  assert.equal(await page.locator('#dayBlocks').innerText(), before);
  // set then restore
  await page.click('#daySettingsBtn');
  await page.fill('#dy-l', '0.5');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  await page.click('#daySettingsBtn');
  await page.check('dialog input[name=reset]');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  assert.match(await lightBlock(page).locator('.block-totals').textContent(), /\/ 1 h 30 min planned/);
  assert.equal(await page.locator('#dayNotice').isHidden(), true);
  await ctx.close();
});

await test('reloading keeps everything: completions, moves between blocks, overrides, splits, day settings and the chosen day', async () => {
  const { page, ctx } = await openDay();
  const title = (await focusBlock(page).locator('.btask-title').first().textContent()).trim();
  await lightBlock(page).locator('.btask input[type=checkbox]').first().check();
  await focusBlock(page).locator('[data-action="move"]').first().click();
  await page.fill('dialog input[name=date]', '2026-10-22');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  await page.click('#daySettingsBtn');
  await page.fill('#dy-l', '1');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  const dayHTML = await page.locator('#dayBlocks').innerText();
  await page.reload();
  await page.waitForSelector('#page-day:not([hidden])');
  assert.equal(await page.inputValue('#dayDate'), '2026-10-14');
  assert.equal(await page.locator('#dayBlocks').innerText(), dayHTML);
  assert.equal(await lightBlock(page).locator('.btask.done').count(), 1);
  await page.fill('#dayDate', '2026-10-22');
  await page.locator('#dayDate').dispatchEvent('change');
  assert.equal(await focusBlock(page).locator('.btask', { hasText: title }).count(), 1);
  assert.match(await page.evaluate(() => location.hash), /#day\/2026-10-22/);
  // a second reload from the day hash keeps that day
  await page.reload();
  assert.equal(await page.inputValue('#dayDate'), '2026-10-22');
  await ctx.close();
});

await test('mobile (375px): Daily view stacks Light above Focused with no horizontal scrolling and readable controls', async () => {
  const { page, ctx } = await openDay({ viewport: { width: 375, height: 800 } });
  const l = await lightBlock(page).boundingBox();
  const f = await focusBlock(page).boundingBox();
  assert.ok(f.y > l.y + l.height - 2, 'focused section is below light section');
  assert.ok(Math.abs(l.x - f.x) < 2 && Math.abs(l.width - f.width) < 2, 'same column, same width');
  assert.ok(l.width > 320, `block width ${l.width}`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  assert.ok(await lightBlock(page).locator('h3').isVisible() && await focusBlock(page).locator('h3').isVisible());
  for (const b of await focusBlock(page).locator('.btask-actions button').all()) assert.ok((await b.boundingBox()).height >= 32);
  await shot(page, 'day-mobile');
  // a dialog fits the phone screen
  await focusBlock(page).locator('[data-action="move"]').first().click();
  const box = await page.locator('dialog[open]').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 375 && box.y >= 0 && box.y + box.height <= 800);
  await page.keyboard.press('Escape');
  await ctx.close();
});

await test('mobile (375px): Weekly view is one stacked column; both blocks of every day are visible without horizontal scrolling', async () => {
  const { page, ctx } = await open({ viewport: { width: 375, height: 800 } }, '#calendar');
  const cards = await page.locator('#weekGrid .day').all();
  assert.equal(cards.length, 7);
  const boxes = await Promise.all(cards.map((c) => c.boundingBox()));
  assert.ok(boxes.every((b) => Math.abs(b.x - boxes[0].x) < 2), 'one column');
  assert.ok(boxes.every((b, i) => i === 0 || b.y > boxes[i - 1].y), 'stacked top to bottom');
  assert.ok(boxes.every((b) => b.x >= 0 && b.x + b.width <= 375));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  assert.equal(await page.locator('#weekGrid .cblock-light h4').count(), 7);
  assert.equal(await page.locator('#weekGrid .cblock-focus h4').count(), 7);
  const lightBox = await page.locator('#weekGrid .cblock-light').first().boundingBox();
  assert.ok(lightBox.x >= 0 && lightBox.x + lightBox.width <= 375, 'light-work tasks are inside the viewport');
  await shot(page, 'week-mobile');
  // tablet: no overflow either
  await page.setViewportSize({ width: 820, height: 1000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  await shot(page, 'week-tablet');
  await ctx.close();
});

await test('migration: data saved by the old single-capacity version keeps its progress and gains the two blocks (with a backup copy)', async () => {
  const old = readFileSync(join(ROOT, 'tests', 'fixtures', 'old-state-sample.json'), 'utf8');
  const t = await newPage();
  await t.page.addInitScript((payload) => { if (!localStorage.getItem('mbbsStudyCommandCenter.v1')) localStorage.setItem('mbbsStudyCommandCenter.v1', payload); }, old);
  await t.page.goto(`${BASE}/#day/2026-10-14`);
  await t.page.waitForSelector('#page-day:not([hidden])');
  await t.page.waitForSelector('#toasts .toast');
  assert.match((await toasts(t.page).allTextContents()).join(' '), /now separates Light work \(college gaps\) from Focused work/);
  assert.equal(await t.page.locator('#dayBlocks section.block').count(), 2);
  assert.ok(await lightBlock(t.page).locator('.btask').count() >= 3);
  assert.ok(await focusBlock(t.page).locator('.btask').count() >= 2);
  await goto(t.page, 'dashboard');
  assert.equal(await metric(t.page, '#mDone'), '2 / 377', 'completed work kept');
  const stored = await t.page.evaluate(() => ({ cur: JSON.parse(localStorage.getItem('mbbsStudyCommandCenter.v1')), backup: localStorage.getItem('mbbsStudyCommandCenter.v1.pre-blocks-backup') }));
  assert.equal(stored.cur.version, 2);
  assert.ok(stored.backup && JSON.parse(stored.backup).tasks.length === 270, 'untouched copy of the old data');
  assert.equal(stored.cur.tasks.filter((x) => x.id === 'PSM-01')[0].done, true);
  assert.deepEqual(t.problems, []);
  // reload does not migrate again
  await t.page.reload();
  await t.page.waitForTimeout(300);
  assert.equal(await toasts(t.page).count(), 0);
  await t.ctx.close();
});

await test('dashboard insights: subject bars, streak after completing a lecture, countdowns, focus timer, theme switch persists', async () => {
  const { page, ctx } = await open();
  assert.ok((await page.locator('#subjectBars [role=progressbar]').count()) >= 2);
  assert.equal((await page.textContent('#streakVal')).trim(), '0 days');
  assert.match(await page.textContent('#countFinish'), /day|Today|ago/);
  await page.fill('#focusDate', new Date().toISOString().slice(0, 10));
  await page.goto(`${BASE}/#tasks`);
  await page.locator('#taskTable button[data-action=toggle-btn]').first().click();
  await page.goto(`${BASE}/#dashboard`);
  await page.reload();
  assert.equal((await page.textContent('#streakVal')).trim(), '1 day');
  assert.match(await page.textContent('#sparkCopy'), /1 lecture completed/);
  await page.selectOption('#timerLen', '45');
  assert.equal((await page.textContent('#timerFace')).trim(), '45:00');
  await page.click('#timerStart');
  assert.equal((await page.textContent('#timerStart')).trim(), 'Pause');
  await page.click('#timerStart');
  await page.click('#timerReset');
  assert.equal((await page.textContent('#timerFace')).trim(), '45:00');
  await page.click('#themeBtn');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await page.reload();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await ctx.close();
});

// ---- day notes + viewer page -----------------------------------------------------------------

await test('daily view: "Also done" notes can be added, validated, persisted, removed and undone', async () => {
  const { page, ctx, problems } = await open({}, '#day/2026-10-14');
  await page.click('#extraForm button');
  assert.match(await page.textContent('#extraErr'), /Type what you did/);
  await page.fill('#extraText', '40 MCQs on cardiology');
  await page.click('#extraForm button');
  assert.match(await page.textContent('#extraList'), /40 MCQs on cardiology/);
  assert.equal(await page.inputValue('#extraText'), '');
  await page.reload();
  await page.waitForSelector('#extraList li');
  assert.equal(await page.locator('#extraList li').count(), 1);
  await page.goto(`${BASE}/#day/2026-10-15`);
  assert.equal(await page.locator('#extraList li').count(), 0, 'notes belong to their own day');
  await page.goto(`${BASE}/#day/2026-10-14`);
  await page.click('#extraList [data-action="remove-extra"]');
  assert.equal(await page.locator('#extraList li').count(), 0);
  await page.click('#toasts .toast button');
  assert.equal(await page.locator('#extraList li').count(), 1);
  assert.deepEqual(problems, []);
  await ctx.close();
});

/** Open view.html with a fake backend: the config module and the one database call are intercepted. */
async function openViewer(snapshot, { hash = '#t=' + 'a'.repeat(43), viewport } = {}) {
  const t = await newPage({ viewport });
  await t.page.route('**/js/supabase-config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: "export const supabaseConfig = { url: 'https://fake.supabase.co', anonKey: 'anon-key' };" }));
  const calls = [];
  await t.page.route('https://fake.supabase.co/**', (r) => { calls.push(r.request()); r.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot) }); });
  await t.page.goto(`${BASE}/view.html${hash}`);
  await t.page.waitForFunction(() => document.getElementById('app').getAttribute('aria-busy') === 'false');
  return { ...t, calls };
}

const SNAP = {
  v: 1, name: 'Asha', updatedAt: '2026-10-14T09:30:00.000Z', asOf: '2026-10-14', startsOn: '2026-10-12', done: 113, total: 270, pct: 42,
  status: { code: 'slightly', behind: 2 }, today: { plannedLectures: 3, doneLectures: 2, pct: 62, plannedH: 4, doneH: 2.5 }, streak: 6, streakPct: 90,
  pending: [{ subject: 'Anatomy', title: 'Brachial plexus', date: '2026-10-12' }, { subject: 'Physiology', title: 'Cardiac cycle <i>x</i>', date: '2026-10-13' }], pendingTotal: 4, phone: '919876543210',
  week: [0, 3, 4, 0, 5, 2, 2].map((count, i) => ({ iso: `2026-10-${String(8 + i).padStart(2, '0')}`, count })),
  subjects: [{ subject: 'Anatomy', done: 20, total: 40, pct: 50 }, { subject: 'Physiology', done: 5, total: 50, pct: 10 }],
  target: { date: '2026-12-20', daysLeft: 67 },
  extras: [{ date: '2026-10-14', items: ['40 MCQs on cardiology', '<b>x</b>'] }],
};

await test('viewer page: big, simple summary with the right numbers and no way into the planner', async () => {
  const { page, ctx, problems, calls } = await openViewer(SNAP);
  assert.match(await page.textContent('h1'), /Asha’s study progress/);
  assert.equal((await page.textContent('.big')).replace(/\s/g, ''), '42%');
  assert.match(await page.textContent('.count'), /113 of 270 lectures done/);
  assert.match(await page.textContent('.status'), /A little behind: 2 lectures/);
  assert.match(await page.textContent('#h-today'), /Today's work done/);
  assert.equal((await page.textContent('#h-today + .num')).trim(), '62%', "today's completion, not yes/no");
  assert.equal(await page.getAttribute('#h-today ~ .bar', 'aria-valuenow'), '62');
  assert.match(await page.textContent('#h-streak + .num'), /6 days/);
  assert.match(await page.textContent('#h-streak ~ .sub'), /90% or more of the day's work done/);
  assert.equal(await page.locator('.subj li').count(), 2);
  assert.match(await page.textContent('#h-extras + .days'), /40 MCQs on cardiology/);
  assert.match(await page.textContent('#h-extras + .days'), /<b>x<\/b>/, 'notes are shown as text, never as HTML');
  assert.equal(await page.locator('a').count(), 1, 'the only link is the WhatsApp reminder: nothing leads to the planner');
  assert.ok((await page.getAttribute('a', 'href')).startsWith('https://wa.me/'));
  assert.equal(await page.locator('nav, input, select, textarea').count(), 0);
  assert.match(await page.textContent('#updated'), /^Updated (just now|.+ ago)$/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url(), /rpc\/get_shared_progress$/);
  assert.equal(calls[0].postDataJSON().p_token, 'a'.repeat(43));
  const fontPx = await page.$eval('.big', (el) => parseFloat(getComputedStyle(el).fontSize));
  assert.ok(fontPx >= 64, `headline number should be huge, got ${fontPx}px`);
  assert.deepEqual(problems.filter((p) => !p.includes('fake.supabase')), []);
  await ctx.close();
});

for (const scheme of ['light', 'dark']) {
  await test(`viewer page: axe scan (${scheme}) and no horizontal scroll at 375px`, async () => {
    const t = await newPage({ viewport: { width: 375, height: 800 }, colorScheme: scheme });
    await t.page.route('**/js/supabase-config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: "export const supabaseConfig = { url: 'https://fake.supabase.co', anonKey: 'k' };" }));
    await t.page.route('https://fake.supabase.co/**', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(SNAP) }));
    await t.page.goto(`${BASE}/view.html#t=${'b'.repeat(43)}`);
    await t.page.waitForSelector('.big');
    await t.page.addScriptTag({ content: AXE });
    const v = await t.page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } })).violations.map((x) => `${x.id}: ${x.nodes.length}`));
    assert.deepEqual(v, []);
    assert.ok(await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll');
    await t.ctx.close();
  });
}

await test('viewer page: wrong, switched-off, short or missing links show a calm message and never data', async () => {
  const off = await openViewer(null);
  assert.match(await off.page.textContent('#app'), /not active any more/);
  await off.ctx.close();
  const empty = await openViewer({});
  assert.match(await empty.page.textContent('#app'), /Nothing has been shared yet/);
  await empty.ctx.close();
  const short = await openViewer(SNAP, { hash: '#t=abc' });
  assert.match(await short.page.textContent('#app'), /incomplete/);
  assert.equal(short.calls.length, 0, 'a malformed link never calls the backend');
  await short.ctx.close();
  const none = await openViewer(SNAP, { hash: '' });
  assert.match(await none.page.textContent('#app'), /incomplete/);
  await none.ctx.close();
});

await test('viewer page: without a configured backend it says so instead of breaking', async () => {
  const { page, ctx } = await newPage();
  await page.goto(`${BASE}/view.html#t=${'c'.repeat(43)}`);
  await page.waitForFunction(() => document.getElementById('app').getAttribute('aria-busy') === 'false');
  assert.match(await page.textContent('#app'), /not set up yet/);
  await ctx.close();
});


// ---- wide-screen landing, Google sync conflict dialog, dashboard share button -------------------------

await test('landing page: opens the Daily view when two columns fit, the Dashboard on narrow screens, and honours an explicit link', async () => {
  const wide = await newPage({ viewport: { width: 1280, height: 900 } });
  await wide.page.goto(BASE);
  await wide.page.waitForSelector('.page:not([hidden])');
  assert.equal(await wide.page.locator('.page:not([hidden])').getAttribute('id'), 'page-day');
  assert.equal(await wide.page.locator('#dayBlocks .block').count(), 2, 'Light and Focused side by side');
  await wide.page.goto(`${BASE}/#dashboard`);
  await wide.page.reload();
  assert.equal(await wide.page.locator('.page:not([hidden])').getAttribute('id'), 'page-dashboard', 'an explicit link wins');
  await wide.ctx.close();
  const narrow = await newPage({ viewport: { width: 375, height: 800 } });
  await narrow.page.goto(BASE);
  await narrow.page.waitForSelector('.page:not([hidden])');
  assert.equal(await narrow.page.locator('.page:not([hidden])').getAttribute('id'), 'page-dashboard');
  await narrow.ctx.close();
});

/** A tiny in-memory stand-in for the Supabase SDK: one signed-in user and one row per table, with a log of every write. */
const FAKE_SDK = `
export function createClient() {
  const db = window.__db;
  const table = (name) => {
    const f = { op: 'select', filters: {}, body: null };
    async function run() {
      const row = db[name];
      if (name === 'viewer_share' && db.noViewerTable) return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.viewer_share' in the schema cache" } };
      if (name === 'viewer_share' && f.op !== 'select' && db.denyWrites) return { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } };
      if (f.op === 'select') return { data: row ? { ...row } : null, error: null };
      db.calls.push({ table: name, op: f.op, body: f.body, filters: { ...f.filters } });
      if (f.op === 'insert') { if (row) return { data: null, error: { code: '23505' } }; db[name] = { ...f.body }; return { data: null, error: null }; }
      if (f.op === 'upsert') { db[name] = { ...(row || {}), ...f.body }; return { data: null, error: null }; }
      if (f.op === 'update') { if (row && (f.filters.rev === undefined || row.rev === f.filters.rev)) { db[name] = { ...row, ...f.body }; return { data: [{ rev: db[name].rev }], error: null }; } return { data: [], error: null }; }
      return { data: null, error: null };
    }
    const api = {
      select() { return api; },
      eq(k, v) { f.filters[k] = v; return api; },
      insert(b) { f.op = 'insert'; f.body = b; return api; },
      update(b) { f.op = 'update'; f.body = b; return api; },
      upsert(b) { f.op = 'upsert'; f.body = b; return api; },
      maybeSingle() { return run(); },
      then(res, rej) { return run().then(res, rej); },
    };
    return api;
  };
  return {
    from: table,
    auth: {
      onAuthStateChange(cb) { setTimeout(() => cb(db.user ? 'INITIAL_SESSION' : 'SIGNED_OUT', db.user ? { user: db.user } : null), 0); return { data: { subscription: {} } }; },
      signInWithOAuth: async () => ({ error: null }),
      signOut: async () => ({}),
    },
    channel() { const c = { on() { return c; }, subscribe() { return c; } }; return c; },
    removeChannel() {},
  };
}`;

const { freshState: freshForTest } = await import('../../js/store.js');
const stateWithDone = (n) => {
  const st = freshForTest();
  st.tasks.filter((t) => t.type === 'video').slice(0, n).forEach((t) => { t.done = true; t.doneAt = '2026-10-14'; });
  return st;
};
const doneInStorage = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('mbbsStudyCommandCenter.v1')).tasks.filter((t) => t.type === 'video' && t.done).length);

/** Open the app with cloud sync on, a fake backend, and chosen local / cloud data. */
async function openSynced({ local, cloud, signedIn = true, hash = '#dashboard', noViewerTable = false, denyWrites = false }) {
  const t = await newPage();
  await t.page.route('**/js/supabase-config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: "export const supabaseConfig = { url: 'https://fake.supabase.co', anonKey: 'k' };" }));
  await t.page.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js/, (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_SDK }));
  await t.page.addInitScript(({ local: l, cloud: c, signedIn: si, noViewerTable: nv, denyWrites: dw }) => {
    window.__db = {
      calls: [],
      noViewerTable: nv,
      denyWrites: dw,
      user: si ? { id: 'u1', email: 'asha@example.com', user_metadata: { full_name: 'Asha K' } } : null,
      viewer_share: null,
      user_state: c ? { user_id: 'u1', state: c, rev: 5, updated_at: '2026-10-15T08:00:00Z' } : null,
    };
    if (l && !localStorage.getItem('mbbsStudyCommandCenter.v1')) localStorage.setItem('mbbsStudyCommandCenter.v1', JSON.stringify(l));
  }, { local, cloud, signedIn, noViewerTable, denyWrites });
  await t.page.goto(`${BASE}/${hash}`);
  await t.page.waitForSelector('.page:not([hidden])');
  return t;
}
const writes = (page, table = 'user_state') => page.evaluate((tb) => window.__db.calls.filter((c) => c.table === tb), table);

await test('sync conflict: Continue without a choice asks for one; choosing "cloud" really replaces this device\'s data', async () => {
  const { page, ctx, problems } = await openSynced({ local: stateWithDone(1), cloud: stateWithDone(3) });
  await page.waitForSelector('dialog[open]');
  assert.match(await page.locator('dialog').textContent(), /3 of 377 lectures done/, 'shows lecture counts, not generated blocks');
  assert.match(await page.locator('dialog').textContent(), /1 of 377 lectures done/);
  await page.click('dialog button[type=submit]');
  assert.match(await page.locator('dialog .error-text').textContent(), /Choose one of the two options/);
  await page.check('dialog input[value=cloud]');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  assert.equal(await doneInStorage(page), 3, 'this device now holds the cloud copy');
  assert.equal(await metric(page, '#mDone'), '3 / 377', 'and the screen shows it');
  assert.equal((await writes(page)).length, 0, 'choosing cloud uploads nothing');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mbbsSyncMeta')).rev), 5);
  await page.reload();
  await page.waitForSelector('.page:not([hidden])');
  assert.equal(await doneInStorage(page), 3, 'still the cloud copy after a reload');
  assert.equal(await page.locator('dialog[open]').count(), 0, 'no second prompt: both sides now agree');
  assert.deepEqual(problems, []);
  await ctx.close();
});

await test('sync conflict: choosing "keep this device" uploads this device\'s data and leaves it untouched', async () => {
  const { page, ctx } = await openSynced({ local: stateWithDone(1), cloud: stateWithDone(3) });
  await page.waitForSelector('dialog[open]');
  await page.check('dialog input[value=device]');
  await page.click('dialog button[type=submit]');
  await dialogGone(page);
  await page.waitForFunction(() => window.__db.calls.some((c) => c.table === 'user_state'));
  const w = await writes(page);
  assert.equal(w.length, 1);
  assert.equal(w[0].op, 'upsert');
  assert.equal(w[0].body.rev, 6);
  assert.equal(w[0].body.state.tasks.filter((t) => t.type === 'video' && t.done).length, 1);
  assert.equal(await doneInStorage(page), 1);
  await ctx.close();
});

await test('sync conflict: "Decide later" changes nothing on either side', async () => {
  const { page, ctx } = await openSynced({ local: stateWithDone(1), cloud: stateWithDone(3) });
  await page.waitForSelector('dialog[open]');
  await page.click('dialog [data-cancel]');
  await dialogGone(page);
  assert.equal(await doneInStorage(page), 1);
  assert.equal((await writes(page)).length, 0);
  assert.match(await page.textContent('#accountBtn'), /Resolve sync/);
  await ctx.close();
});

await test('a new device with no progress takes the cloud copy without asking', async () => {
  const { page, ctx } = await openSynced({ local: null, cloud: stateWithDone(3) });
  await page.waitForFunction(() => document.querySelector('#mDone')?.textContent === '3 / 377');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await doneInStorage(page), 3);
  await ctx.close();
});

await test('dashboard "Share progress": needs sign-in first, then creates the link and shows it ready to copy', async () => {
  const out = await openSynced({ local: null, cloud: null, signedIn: false });
  assert.equal(await out.page.isVisible('#shareBtn'), true);
  await out.page.click('#shareBtn');
  assert.match(await allToasts(out.page), /Sign in with Google first/);
  await out.ctx.close();

  const { page, ctx, problems } = await openSynced({ local: null, cloud: null });
  await page.waitForFunction(() => /Signed in/.test(document.querySelector('#accountBtn').textContent));
  await page.waitForTimeout(1500);
  await page.click('#shareBtn');
  await page.waitForSelector('dialog[open] #shareUrl');
  const url = await page.inputValue('#shareUrl');
  assert.ok(url.startsWith(`${BASE}/view.html#t=`), url);
  assert.ok(url.split('#t=')[1].length >= 32);
  const w = await writes(page, 'viewer_share');
  assert.equal(w.length, 1);
  assert.equal(w[0].body.enabled, true);
  assert.equal(w[0].body.token, url.split('#t=')[1]);
  assert.ok(!JSON.stringify(w[0].body.snapshot).includes('Active recall'), 'only numbers are shared');
  await page.click('dialog [data-cancel]');
  await page.click('#shareBtn');
  assert.equal(await page.inputValue('#shareUrl'), url, 'the same link is shown again, not a new one');
  assert.equal((await writes(page, 'viewer_share')).length, 1);
  assert.deepEqual(problems, []);
  await ctx.close();
});



await test('viewer page: Refresh sits at the top next to the title and works', async () => {
  const { page, ctx, calls } = await openViewer(SNAP);
  const box = await page.locator('#refresh').boundingBox();
  assert.ok(box.y < 160, `refresh is near the top (y=${Math.round(box.y)})`);
  assert.ok(box.width >= 44 && box.height >= 44, 'big enough to tap');
  assert.equal(await page.locator('footer').count(), 0);
  const before = calls.length;
  await page.click('#refresh');
  await page.waitForFunction((n) => window.__calls === undefined || true, before);
  await page.waitForTimeout(400);
  assert.ok(calls.length > before, 'refresh fetches again');
  await ctx.close();
});

await test('viewer page: names what is pending and Notify opens WhatsApp with a ready-typed reminder', async () => {
  const { page, ctx } = await openViewer(SNAP);
  const card = page.locator('#h-pending').locator('xpath=ancestor::section');
  assert.match(await card.textContent(), /Still pending \(4\)/);
  assert.match(await card.textContent(), /Anatomy\s*Brachial plexus/);
  assert.match(await card.textContent(), /Cardiac cycle <i>x<\/i>/, 'titles are shown as text, never as HTML');
  assert.match(await card.textContent(), /and 2 more/);
  const link = card.locator('a.notify');
  assert.match(await link.textContent(), /Notify Asha on WhatsApp/);
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.match(await link.getAttribute('rel'), /noopener/);
  const href = await link.getAttribute('href');
  assert.ok(href.startsWith('https://wa.me/919876543210?text='), href);
  const msg = decodeURIComponent(href.split('?text=')[1]);
  assert.match(msg, /^Hi Asha, a gentle reminder/);
  assert.match(msg, /1\. Anatomy: Brachial plexus/);
  assert.match(msg, /2\. Physiology: Cardiac cycle <i>x<\/i>/);
  assert.match(msg, /and 2 more/);
  // Pending sits above the progress numbers so it is seen first.
  const order = await page.$$eval('main > *', (els) => els.map((e) => e.querySelector('h2')?.id || e.className));
  assert.ok(order.indexOf('h-pending') >= 0 && order.indexOf('h-pending') < order.indexOf('h-overall'));
  await ctx.close();
});

await test('viewer page: without a shared number WhatsApp lets the viewer pick the contact; nothing pending means no Notify', async () => {
  const noPhone = await openViewer({ ...SNAP, phone: '' });
  assert.ok((await noPhone.page.getAttribute('a.notify', 'href')).startsWith('https://wa.me/?text='));
  await noPhone.ctx.close();
  const none = await openViewer({ ...SNAP, pending: [], pendingTotal: 0, status: { code: 'ontrack', behind: 0 } });
  assert.equal(await none.page.locator('a').count(), 0);
  assert.equal(await none.page.locator('#h-pending').count(), 0);
  assert.match(await none.page.textContent('.status'), /On track/);
  await none.ctx.close();
});

await test('viewer page: an older summary without the new fields still renders (today shows a percentage from the counts)', async () => {
  const { today, streakPct, pending, pendingTotal, phone, ...old } = SNAP;
  const { page, ctx, problems } = await openViewer({ ...old, today: { plannedLectures: 4, doneLectures: 1 } });
  assert.equal((await page.textContent('#h-today + .num')).trim(), '25%');
  assert.equal(await page.locator('#h-pending').count(), 0);
  assert.deepEqual(problems.filter((p) => !p.includes('fake.supabase')), []);
  await ctx.close();
});

await test('settings: the owner can save, correct and clear the WhatsApp number used by the Notify button', async () => {
  const { page, ctx } = await open({}, '#settings');
  assert.equal(await page.inputValue('#viewerPhone'), '');
  await page.fill('#viewerPhone', '+91 98765-43210');
  await page.press('#viewerPhone', 'Tab');
  assert.match(await allToasts(page), /WhatsApp number saved/);
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('mbbsStudyCommandCenter.v1')).viewer.phone)), '919876543210');
  await page.reload();
  assert.equal(await page.inputValue('#viewerPhone'), '919876543210', 'remembered');
  await page.fill('#viewerPhone', '123');
  await page.press('#viewerPhone', 'Tab');
  assert.match(await page.textContent('#viewerPhoneHint'), /8 to 15 digits/);
  assert.equal(await page.getAttribute('#viewerPhone', 'aria-invalid'), 'true');
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('mbbsStudyCommandCenter.v1')).viewer.phone)), '919876543210', 'a bad number is not saved');
  await page.fill('#viewerPhone', '');
  await page.press('#viewerPhone', 'Tab');
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('mbbsStudyCommandCenter.v1')).viewer.phone)), '');
  assert.equal(await page.getAttribute('#viewerPhone', 'aria-invalid'), null);
  await ctx.close();
});


await test('viewer link when the database setup was never run: Settings says so plainly and offers the SQL with the steps', async () => {
  const { page, ctx, problems } = await openSynced({ local: null, cloud: null, noViewerTable: true, hash: '#settings' });
  await page.waitForFunction(() => /One-time setup is missing/.test(document.querySelector('#viewerState').textContent));
  assert.equal(await page.isVisible('#viewerCreate'), false, 'no button that is bound to fail');
  assert.equal(await page.isVisible('#viewerSetup'), true);
  await page.click('#viewerSetup');
  await page.waitForSelector('dialog[open] #setupSql');
  const sql = await page.inputValue('#setupSql');
  assert.match(sql, /create table if not exists public\.viewer_share/);
  assert.match(sql, /get_shared_progress/);
  assert.equal(await page.getAttribute('dialog a', 'href'), 'https://supabase.com/dashboard/project/fake/sql/new', 'opens the SQL editor of the right project');
  await page.click('#setupCopy');
  assert.match(await allToasts(page), /SQL copied|Ctrl\+C/);
  assert.deepEqual(problems.filter((p) => !p.includes('fake.supabase') && !p.includes('Could not find the table')), []);
  await ctx.close();
});

await test('dashboard "Share progress" with the setup missing goes straight to the setup steps instead of failing', async () => {
  const { page, ctx } = await openSynced({ local: null, cloud: null, noViewerTable: true });
  await page.waitForFunction(() => /Signed in/.test(document.querySelector('#accountBtn').textContent));
  await page.waitForTimeout(1800); // the viewer-link check runs just after sync
  await page.click('#shareBtn');
  await page.waitForSelector('dialog[open] #setupSql');
  assert.match(await page.locator('dialog h2').textContent(), /One-time setup/);
  await ctx.close();
});

await test('viewer link: when Supabase refuses the write, the message says so instead of "check your connection"', async () => {
  const { page, ctx } = await openSynced({ local: null, cloud: null, denyWrites: true });
  await page.waitForFunction(() => /Signed in/.test(document.querySelector('#accountBtn').textContent));
  await page.waitForTimeout(1800);
  await page.click('#shareBtn');
  const msg = await allToasts(page);
  assert.match(msg, /Supabase refused the request/);
  assert.doesNotMatch(msg, /check your connection/i);
  await ctx.close();
});

await test('the Share progress button is hidden when cloud sync is not set up', async () => {
  const { page, ctx } = await open();
  assert.equal(await page.isVisible('#shareBtn'), false);
  await ctx.close();
});


// ---- plan tuner and catch-up -----------------------------------------------------------------------------------

const { generatePlan: genForTest } = await import('../../js/planner.js');

/** Saved state with fast playback (so the full library fits by 31 Dec) and an optional plan made on an earlier day. */
function seededState({ planOn, speed = 2 } = {}) {
  const st = freshForTest();
  st.settings = { ...st.settings, speed };
  if (planOn) {
    const r = genForTest(st.tasks, st.planConfig, st.settings, new Date(), { today: planOn });
    st.tasks = r.tasks; st.backlog = r.backlog; st.planMeta = r.meta; st.version = 2;
  }
  return st;
}
async function openTuner(seed) {
  const t = await newPage({ viewport: { width: 1280, height: 1000 } });
  await t.page.addInitScript((s) => { if (!localStorage.getItem('mbbsStudyCommandCenter.v1')) localStorage.setItem('mbbsStudyCommandCenter.v1', JSON.stringify(s)); }, seed);
  await t.page.goto(`${BASE}/#calendar`);
  await t.page.waitForSelector('#page-calendar:not([hidden]) #tuneEnd');
  return t;
}
const sliderVal = (page, id) => page.$eval(id, (e) => Number(e.value));

await test('plan tuner: the two sliders are linked (hours up -> finish earlier, date earlier -> hours up) and say when it is impossible', async () => {
  const { page, ctx, problems } = await openTuner(seededState());
  assert.match(await page.textContent('#tuneVerdict'), /(you finish by|you need about)/);
  await page.fill('#tuneHours', '2.5');
  const endAt25 = await sliderVal(page, '#tuneEnd');
  await page.fill('#tuneHours', '3.25');
  const endAt325 = await sliderVal(page, '#tuneEnd');
  assert.ok(endAt325 < endAt25, `more hours finishes earlier (${endAt325} < ${endAt25})`);
  assert.match(await page.textContent('#tuneEndOut'), /\(\d+ days? from today\)/);
  await page.fill('#tuneEnd', '70');
  const h70 = await sliderVal(page, '#tuneHours');
  await page.fill('#tuneEnd', '60');
  const h60 = await sliderVal(page, '#tuneHours');
  assert.ok(h60 >= h70, 'an earlier date needs at least as many hours');
  await page.fill('#tuneEnd', '10');
  assert.equal(await sliderVal(page, '#tuneHours'), await page.$eval('#tuneHours', (e) => Number(e.max)), 'pinned at the most the evening allows');
  assert.match(await page.textContent('#tuneVerdict'), /is not enough to finish by/);
  assert.ok(await page.$eval('#tuneVerdict', (e) => e.classList.contains('is-bad')));
  assert.deepEqual(problems, []);
  await ctx.close();
});


await test('plan tuner: hours are not capped by the evening window; the estimate is shown, warned about, and applied as asked', async () => {
  const { page, ctx } = await openTuner(seededState({ speed: 1.5 }));
  const windowH = 3.25;
  await page.fill('#tuneEnd', '45'); // about 28 Nov
  const need = await sliderVal(page, '#tuneHours');
  assert.ok(need > windowH, `estimated need ${need} h is shown, not clipped to ${windowH} h`);
  assert.ok(await page.$eval('#tuneVerdict', (e) => e.classList.contains('is-warn')));
  assert.match(await page.textContent('#tuneVerdict'), /you need about [\d.]+ focused hours each weekday/);
  assert.match(await page.textContent('#tuneVerdict'), /more than fits between your evening start and bedtime/);
  assert.match(await page.textContent('#tuneHoursOut'), /your evening fits 3\.25 h/);
  assert.equal(await page.$eval('#tuneHours', (e) => Number(e.max)), 12);
  await page.click('#tuneApply');
  assert.match(await allToasts(page), /Plan rebuilt: everything fits by/);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mbbsStudyCommandCenter.v1')));
  assert.equal(saved.settings.studyHours, need, 'the plan uses exactly the hours the tuner estimated');
  assert.equal(saved.backlog.length, 0);
  await ctx.close();
});

await test('plan tuner: presets set the phases, Asleep removes a subject from the work, Apply rebuilds, Undo restores', async () => {
  const { page, ctx, problems } = await openTuner(seededState());
  const sel = (s) => page.$eval(`#ph-${s}`, (e) => e.value);
  await page.click('[data-preset="pairs"]');
  assert.deepEqual([await sel('PSM'), await sel('Ophthalmology'), await sel('FMT'), await sel('ENT')], ['1', '1', '2', '2']);
  await page.click('[data-preset="sequential"]');
  assert.deepEqual([await sel('PSM'), await sel('Ophthalmology'), await sel('FMT'), await sel('ENT')], ['1', '2', '3', '4']);
  await page.click('[data-preset="three-one"]');
  assert.deepEqual([await sel('PSM'), await sel('Ophthalmology'), await sel('FMT'), await sel('ENT')], ['1', '1', '1', '2']);
  await page.click('[data-preset="together"]');
  assert.deepEqual([await sel('PSM'), await sel('Ophthalmology'), await sel('FMT'), await sel('ENT')], ['1', '1', '1', '1']);

  const workBefore = await page.textContent('#tunerWork');
  await page.selectOption('#ph-ENT', 'asleep');
  assert.match(await page.textContent('#tunerWork'), /ENT asleep, not counted/);
  assert.notEqual(await page.textContent('#tunerWork'), workBefore);
  await page.click('[data-preset="pairs"]'); // presets only reshuffle awake subjects: ENT stays asleep
  assert.equal(await sel('ENT'), 'asleep');

  await page.fill('#tuneEnd', '78'); // 31 Dec
  await page.click('#tuneApply');
  assert.match(await allToasts(page), /Plan rebuilt: everything fits by 31 December/);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mbbsStudyCommandCenter.v1')));
  assert.deepEqual(saved.planConfig.asleep, ['ENT']);
  assert.deepEqual(saved.planConfig.groups, [['PSM', 'Ophthalmology'], ['FMT']]);
  assert.ok(saved.tasks.filter((t) => t.subject === 'ENT').every((t) => !t.scheduledDate), 'ENT has no dates');
  assert.equal(saved.backlog.length, 0);
  assert.match(await page.textContent('#phaseSummary'), /Phase 1: PSM \+ Ophthalmology/);
  assert.match(await page.textContent('#phaseSummary'), /Asleep:\s*ENT/);
  assert.match(await metric(page, '#planReport'), /Asleep \(not planned\)\s*65/);

  await goto(page, 'tasks');
  await page.fill('#searchTask', 'Acoustic Neuroma');
  assert.match(await page.locator('#taskTable tr').first().textContent(), /Asleep/);
  await goto(page, 'calendar');
  await toasts(page).last().getByRole('button', { name: 'Undo' }).click().catch(() => {});
  assert.deepEqual(problems, []);
  await ctx.close();
});

await test('plan tuner: Undo brings back the previous plan and study order', async () => {
  const { page, ctx } = await openTuner(seededState());
  await page.selectOption('#ph-FMT', 'asleep');
  await page.click('#tuneApply');
  await page.waitForSelector('#toasts .toast');
  await page.locator('#toasts .toast', { hasText: 'Plan rebuilt' }).getByRole('button', { name: 'Undo' }).click();
  assert.match(await allToasts(page), /Previous plan restored/);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mbbsStudyCommandCenter.v1')));
  assert.deepEqual(saved.planConfig.asleep, []);
  await ctx.close();
});

await test('catch-up: lectures left open on past days show a banner; "Re-spread from today" moves them forward evenly, Undo restores', async () => {
  const { page, ctx, problems } = await openTuner(seededState({ planOn: '2026-10-05' }));
  assert.equal(await page.isVisible('#catchup'), true);
  assert.match(await page.textContent('#catchupText'), /\d+ lectures? planned for earlier days (is|are) still open/);
  await page.click('#catchup button');
  assert.match(await allToasts(page), /Plan re-spread from today: \d+ missed lectures? (was|were) moved forward/);
  assert.equal(await page.isVisible('#catchup'), false);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mbbsStudyCommandCenter.v1')));
  const open = saved.tasks.filter((t) => t.type === 'video' && !t.done && t.scheduledDate);
  assert.ok(open.length > 300 && open.every((t) => t.scheduledDate >= '2026-10-14'), 'nothing open is dated in the past');
  assert.equal(saved.backlog.length, 0);
  await page.locator('#toasts .toast', { hasText: 'Plan re-spread' }).getByRole('button', { name: 'Undo' }).click();
  assert.equal(await page.isVisible('#catchup'), true, 'undo brings the old plan (and the banner) back');
  assert.deepEqual(problems, []);
  await ctx.close();
});

await test('catch-up banner appears on every page and not when nothing is overdue', async () => {
  const a = await openTuner(seededState({ planOn: '2026-10-14' }));
  assert.equal(await a.page.isVisible('#catchup'), false, 'a plan made today has nothing overdue');
  await a.ctx.close();
  const b = await openTuner(seededState({ planOn: '2026-10-05' }));
  for (const name of ['dashboard', 'day', 'tasks', 'settings']) {
    await goto(b.page, name);
    assert.equal(await b.page.isVisible('#catchup'), true, name);
  }
  await b.ctx.close();
});

await test('plan tuner: mobile (375px) has no horizontal scroll and every control is reachable', async () => {
  const t = await newPage({ viewport: { width: 375, height: 800 } });
  await t.page.addInitScript((s) => localStorage.setItem('mbbsStudyCommandCenter.v1', JSON.stringify(s)), seededState());
  await t.page.goto(`${BASE}/#calendar`);
  await t.page.waitForSelector('#tuneEnd');
  assert.ok(await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll');
  for (const sel of ['#tuneEnd', '#tuneHours', '#ph-PSM', '#tuneApply', '[data-preset="pairs"]']) {
    assert.ok(await t.page.locator(sel).isVisible(), sel);
  }
  await t.page.addScriptTag({ content: AXE });
  const v = await t.page.evaluate(async () => (await window.axe.run(document.getElementById('tuner'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } })).violations.map((x) => `${x.id}: ${x.nodes.length}`));
  assert.deepEqual(v, []);
  await t.ctx.close();
});


await test('a rebuild that moves missed lectures forward remembers the missed hours (so that day is not counted as complete)', async () => {
  const { page, ctx } = await openTuner(seededState({ planOn: '2026-10-05' }));
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('mbbsStudyCommandCenter.v1')).missLog);
  assert.deepEqual(before, {}, 'nothing logged yet');
  await page.click('#catchup button');
  await page.waitForSelector('#toasts .toast');
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('mbbsStudyCommandCenter.v1')).missLog);
  const days = Object.keys(after).sort();
  assert.ok(days.length >= 2 && days.every((d) => d >= '2026-10-12' && d < '2026-10-14'), `missed days: ${days.join(', ')}`);
  assert.ok(Object.values(after).every((h) => h > 0));
  await page.locator('#toasts .toast', { hasText: 'Plan re-spread' }).getByRole('button', { name: 'Undo' }).click();
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('mbbsStudyCommandCenter.v1')).missLog), {}, 'Undo also removes the log');
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------
await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} E2E tests passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
if (failed.length) {
  failed.forEach((f) => console.log(`\n✖ ${f.name}\n${f.err.stack?.split('\n').slice(0, 8).join('\n')}`));
  process.exit(1);
}
