// Read-only viewer page. Reads one numbers-only summary through a single database function, keyed by the secret token in the
// link. It has no sign-in, no navigation back to the planner, and imports none of the planner code.
import { supabaseConfig } from './supabase-config.js';
import { agoText, statusView, targetView, todayView } from './viewerModel.js';
import { dateISO, esc, fmtDate } from './utils.js';

const REFRESH_MS = 60000;
const app = document.getElementById('app');
const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('t') || '';
let last = null;   // last good snapshot, kept on screen if a refresh fails
let timer = null;

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function message(text, { retry = false } = {}) {
  app.setAttribute('aria-busy', 'false');
  app.innerHTML = `<p class="msg">${esc(text)}</p>${retry ? '<p class="msg"><button type="button" id="retry">Try again</button></p>' : ''}`;
  document.getElementById('retry')?.addEventListener('click', load);
}

async function fetchSnapshot() {
  const res = await fetch(`${supabaseConfig.url}/rest/v1/rpc/get_shared_progress`, {
    method: 'POST',
    headers: { apikey: supabaseConfig.anonKey, Authorization: `Bearer ${supabaseConfig.anonKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: token }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

function render(snap) {
  const now = new Date();
  const today = dateISO(now);
  const st = statusView(snap.status, snap.startsOn);
  const td = todayView(snap, today);
  const target = targetView(snap, today);
  const maxWeek = Math.max(1, ...snap.week.map((d) => d.count));
  const weekTotal = snap.week.reduce((s, d) => s + d.count, 0);
  const title = snap.name ? `${snap.name}’s study progress` : 'Study progress';
  document.title = `${snap.pct}% · ${title}`;

  app.setAttribute('aria-busy', 'false');
  app.innerHTML = `
    <header><h1>${esc(title)}</h1></header>

    <div class="status ${st.tone}" role="status">
      <div class="ico" aria-hidden="true"><span>${st.icon}</span></div>
      <div>${esc(st.text)}${st.detail ? `<span class="detail">${esc(st.detail)}</span>` : ''}</div>
    </div>

    <section class="card" aria-labelledby="h-overall">
      <h2 id="h-overall">Overall progress</h2>
      <p class="big">${snap.pct}<small>%</small></p>
      <p class="count">${snap.done} of ${snap.total} lectures done</p>
      <div class="bar" role="progressbar" aria-label="Overall lectures completed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${snap.pct}"><span style="width:${snap.pct}%"></span></div>
    </section>

    <div class="pair">
      <section class="card" aria-labelledby="h-today">
        <h2 id="h-today">Studied today?</h2>
        <p class="num">${esc(td.headline)}</p>
        <p class="sub">${esc(td.line)}</p>
      </section>
      <section class="card" aria-labelledby="h-streak">
        <h2 id="h-streak">Study streak</h2>
        <p class="num">${plural(snap.streak, 'day')}</p>
        <p class="sub">${snap.streak ? 'in a row' : 'Starts with the next lecture done'}</p>
      </section>
    </div>

    <section class="card" aria-labelledby="h-week">
      <h2 id="h-week">Last 7 days</h2>
      <div class="week" role="img" aria-label="Lectures done each day: ${snap.week.map((d) => `${fmtDate(d.iso, { weekday: 'long' })} ${d.count}`).join(', ')}">
        ${snap.week.map((d) => `<div class="col" aria-hidden="true"><span class="n">${d.count}</span><div class="stick${d.count ? '' : ' zero'}" style="height:${Math.max(3, Math.round((d.count / maxWeek) * 100))}%"></div><span class="d">${esc(fmtDate(d.iso, { weekday: 'short' }))}</span></div>`).join('')}
      </div>
      <p class="sub" style="margin-top:10px">${weekTotal ? `${plural(weekTotal, 'lecture')} done this week.` : 'No lectures done in the last 7 days.'}</p>
    </section>

    <section class="card" aria-labelledby="h-subj">
      <h2 id="h-subj">Lectures by subject</h2>
      <ul class="subj">
        ${snap.subjects.map((s) => `<li><div class="head"><span>${esc(s.subject)}</span><b>${s.done} of ${s.total}</b></div>
          <div class="bar" role="progressbar" aria-label="${esc(s.subject)} lectures completed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${s.pct}"><span style="width:${s.pct}%"></span></div></li>`).join('')}
      </ul>
    </section>

    ${snap.extras?.length ? `<section class="card" aria-labelledby="h-extras">
      <h2 id="h-extras">Also done recently</h2>
      <ul class="days">
        ${snap.extras.map((e) => `<li><h3>${esc(fmtDate(e.date, { weekday: 'long', day: 'numeric', month: 'short' }))}</h3><ul>${e.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></li>`).join('')}
      </ul>
    </section>` : ''}

    ${target ? `<section class="card" aria-labelledby="h-target">
      <h2 id="h-target">Countdown</h2>
      <p class="num">${esc(target.num)}</p>
      <p class="sub">${esc(target.label)}</p>
    </section>` : ''}

    <footer>
      <p class="small" id="updated">Updated ${esc(agoText(snap.updatedAt, now))}</p>
      <button type="button" id="refresh">Refresh</button>
    </footer>`;
  document.getElementById('refresh').addEventListener('click', load);
}

async function load() {
  clearTimeout(timer);
  timer = setTimeout(load, REFRESH_MS);
  if (!supabaseConfig?.url || !supabaseConfig?.anonKey) { message('This page is not set up yet.'); return; }
  if (token.length < 32) { message('This link is incomplete. Please ask for a new link.'); return; }
  try {
    const snap = await fetchSnapshot();
    if (!snap) { last = null; message('This link is not active any more. Please ask for a new link.'); return; }
    if (!snap.v || !Array.isArray(snap.week) || !Array.isArray(snap.subjects)) { message('Nothing has been shared yet. Please check back in a little while.'); return; }
    last = snap;
    render(snap);
  } catch {
    if (last) {
      const el = document.getElementById('updated');
      if (el) el.textContent = `Could not refresh. Showing the update from ${agoText(last.updatedAt)}.`;
    } else {
      message('Could not load the progress right now. Check the internet connection.', { retry: true });
    }
  }
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
load();
