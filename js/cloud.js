// Google sign-in + cross-device sync on Supabase. The SDK is loaded lazily from the CDN, and only when js/supabase-config.js is
// filled in, so the app stays fully offline-first: localStorage is still what the UI reads, the cloud copy is a mirror.
import { supabaseConfig } from './supabase-config.js';
import { commit, freshState, replaceState, sanitizeState, state, subscribe } from './store.js';
import { decideSync, describeState, hasLocalProgress } from './syncLogic.js';
import { openDialog } from './ui/dialogs.js';
import { toast } from './ui/toast.js';

const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const TABLE = 'user_state';
const META_KEY = 'mbbsSyncMeta';
const PUSH_DELAY_MS = 1500;
const LIBRARY_SIZE = freshState().tasks.length;

/** status.code: unconfigured | signed-out | connecting | syncing | synced | offline | paused | error */
let status = { code: 'unconfigured', user: null, syncedAt: null };
const statusListeners = new Set();
export const getStatus = () => status;
export function onStatus(fn) { statusListeners.add(fn); fn(status); return () => statusListeners.delete(fn); }
function setStatus(code, extra = {}) {
  status = { ...status, code, ...extra };
  statusListeners.forEach((fn) => fn(status));
}

/** The live client and signed-in user, for modules that talk to other tables (viewer link). */
export const getContext = () => ({ sb, user });

export const cloudConfigured = () => !!(supabaseConfig?.url && supabaseConfig?.anonKey);

let meta = loadMeta(); // { uid, rev, dirty } - what this device last agreed on with the cloud
let sb = null;         // Supabase client, created lazily
let initPromise = null; // prevent concurrent SDK loads when the account button is clicked during startup
let user = null;       // { id, email, name }
let channel = null;
let pushTimer = null;
let pushing = false;
let applying = false;  // true while a cloud copy is being written into local state (so it is not echoed back)
let paused = false;    // a conflict was left undecided; nothing is uploaded or overwritten until resolved
let asking = false;
let changeSeq = 0;

function loadMeta() {
  try {
    const m = JSON.parse(localStorage.getItem(META_KEY));
    if (m && typeof m === 'object') return { uid: m.uid ?? null, rev: Number(m.rev) || 0, dirty: !!m.dirty };
  } catch { /* ignore */ }
  return { uid: null, rev: 0, dirty: false };
}
function saveMeta() {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch { /* ignore */ }
}

// ---- local changes -> cloud ----------------------------------------------------------------------

function onLocalCommit() {
  if (applying) return;
  changeSeq++;
  meta.dirty = true;
  saveMeta();
  if (user && !paused) schedulePush();
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => push(), PUSH_DELAY_MS);
}

async function fetchRemote() {
  const { data, error } = await sb.from(TABLE).select('state, rev, updated_at').eq('user_id', user.id).maybeSingle();
  if (error) throw error;
  return data;
}

/** Write this device's state. Resolves { rev } on success or { conflict: row } when the cloud moved on (compare-and-swap on rev). */
async function upload(expected, force) {
  const body = { state, updated_at: new Date().toISOString() };
  if (force) {
    const cur = await fetchRemote();
    const rev = (cur?.rev || 0) + 1;
    const { error } = await sb.from(TABLE).upsert({ user_id: user.id, rev, ...body });
    if (error) throw error;
    return { rev };
  }
  if (expected === 0) {
    const { error } = await sb.from(TABLE).insert({ user_id: user.id, rev: 1, ...body });
    if (!error) return { rev: 1 };
    if (error.code === '23505') return { conflict: await fetchRemote() }; // a row appeared meanwhile
    throw error;
  }
  const { data, error } = await sb.from(TABLE).update({ rev: expected + 1, ...body }).eq('user_id', user.id).eq('rev', expected).select('rev');
  if (error) throw error;
  if (data.length) return { rev: expected + 1 };
  return { conflict: await fetchRemote() };
}

async function push({ force = false } = {}) {
  if (!user || !sb || pushing || (paused && !force)) return;
  clearTimeout(pushTimer);
  pushing = true;
  setStatus('syncing');
  const seq = changeSeq;
  const expected = meta.uid === user.id ? meta.rev : 0;
  try {
    const res = await upload(expected, force);
    if (res.conflict) {
      pushing = false;
      await resolveConflict(res.conflict);
      return;
    }
    meta = { uid: user.id, rev: res.rev, dirty: seq !== changeSeq };
    saveMeta();
    paused = false;
    setStatus('synced', { syncedAt: Date.now() });
    if (meta.dirty) schedulePush();
  } catch {
    setStatus(navigator.onLine ? 'error' : 'offline');
  } finally {
    pushing = false;
  }
}

// ---- cloud -> local ------------------------------------------------------------------------------

function parseRemote(row) {
  try {
    const s = sanitizeState(row.state);
    return s ? { state: s, rev: Number(row.rev) || 0 } : null;
  } catch { return null; }
}

function applyRemote(remote) {
  applying = true;
  try {
    replaceState(remote.state);
    commit();
  } finally {
    applying = false;
  }
  meta = { uid: user.id, rev: remote.rev, dirty: false };
  saveMeta();
  paused = false;
  setStatus('synced', { syncedAt: Date.now() });
}

async function resolveConflict(row) {
  if (asking) return;
  asking = true;
  try {
    const remote = row && parseRemote(row);
    if (!remote) { await push({ force: true }); return; } // the cloud copy is unreadable, so keep this device's data
    const when = row.updated_at ? ` (saved ${new Date(row.updated_at).toLocaleString()})` : '';
    const choice = await openDialog({
      title: 'Which progress do you want to keep?',
      submitLabel: 'Continue',
      cancelLabel: 'Decide later',
      body: `<p>This device and your Google account both have study data that differ.</p>
        <fieldset class="choice"><legend class="sr-only">Choose which copy to keep</legend>
          <label><input type="radio" name="pick" value="cloud"> <span><strong>Use the cloud copy</strong>${when}<br><span class="small muted">${describeState(remote.state)}. Replaces what is on this device.</span></span></label>
          <label><input type="radio" name="pick" value="device"> <span><strong>Keep this device</strong><br><span class="small muted">${describeState(state)}. Replaces the cloud copy.</span></span></label>
        </fieldset>
        <p class="small muted">Tip: use Export backup first if you are unsure. Nothing is changed until you continue.</p>`,
      onSubmit: (v) => (v.pick ? { pick: v.pick } : 'Choose one of the two options.'), // a bare string would be shown as an error
    });
    if (choice?.pick === 'cloud') applyRemote(remote);
    else if (choice?.pick === 'device') await push({ force: true });
    else {
      paused = true;
      setStatus('paused');
    }
  } finally {
    asking = false;
  }
}

async function reconcile() {
  setStatus('syncing');
  try {
    const row = await fetchRemote();
    const action = decideSync({
      meta,
      uid: user.id,
      remoteRev: row ? Number(row.rev) || 0 : null,
      localHasProgress: hasLocalProgress(state, LIBRARY_SIZE),
    });
    if (action === 'push') await push({ force: !!row });
    else if (action === 'pull') {
      const remote = parseRemote(row);
      if (remote) applyRemote(remote); else await push({ force: true });
    } else if (action === 'conflict') await resolveConflict(row);
    else setStatus('synced', { syncedAt: Date.now() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read the cloud copy. Check the user_state table and its row-level security policies.';
    setStatus(navigator.onLine ? 'error' : 'offline', { error: message });
    return;
  }
  if (!paused) listen();
}

/** A row newer than this device has seen: apply it quietly, or ask if this device also has unsent changes. */
function handleRemote(row) {
  if (pushing || applying || paused || !row) return;
  if ((Number(row.rev) || 0) <= meta.rev) return;
  if (meta.dirty) { resolveConflict(row); return; }
  const remote = parseRemote(row);
  if (remote) { applyRemote(remote); toast('Updated from your other device.'); }
}

/** Live updates: a change saved from another device shows up without a reload. */
function listen() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel(`${TABLE}-${user.id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE, filter: `user_id=eq.${user.id}` }, (p) => handleRemote(p.new))
    .subscribe();
}

// ---- sign in / out -------------------------------------------------------------------------------

async function loadClient() {
  const { createClient } = await import(SDK);
  sb = createClient(supabaseConfig.url, supabaseConfig.anonKey, { auth: { persistSession: true, detectSessionInUrl: true } });
}

function setUser(session) {
  const u = session?.user;
  user = u ? { id: u.id, email: u.email || '', name: u.user_metadata?.full_name || '' } : null;
  return user;
}

export async function initCloud() {
  if (!cloudConfigured()) {
    setStatus('unconfigured');
    return;
  }
  if (sb) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    subscribe(onLocalCommit);
    setStatus('connecting');
    try {
      await loadClient();
    } catch (error) {
      sb = null;
      const message = error instanceof Error ? error.message : '';
      setStatus(navigator.onLine ? 'error' : 'offline', { error: message });
      window.addEventListener('online', () => { initPromise = null; initCloud(); }, { once: true });
      return;
    }

    sb.auth.onAuthStateChange((event, session) => {
      // Read the initial session below with getSession(); handling INITIAL_SESSION here as
      // well can start two simultaneous reconciliations and race cloud state restoration.
      if (event === 'INITIAL_SESSION') return;
      const prev = user?.id;
      const u = setUser(session);
      if (!u) {
        if (channel) { sb.removeChannel(channel); channel = null; }
        setStatus('signed-out', { user: null });
      } else if (u.id !== prev) {
        setStatus('syncing', { user: { name: u.name, email: u.email } });
        reconcile();
      }
    });

    window.addEventListener('online', () => {
      if (!user || paused) return;
      if (meta.dirty) push(); else reconcile();
    });
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible' || !user || paused || pushing || asking) return;
      try { handleRemote(await fetchRemote()); } catch { /* offline: try again next time */ }
    });

    try {
      const { data, error } = await sb.auth.getSession();
      if (error) throw error;
      const previous = user?.id;
      const u = setUser(data.session);
      if (u && u.id !== previous) {
        setStatus('syncing', { user: { name: u.name, email: u.email } });
        await reconcile();
      } else if (!u) {
        setStatus('signed-out', { user: null });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not restore the saved session.';
      setStatus('error', { error: message });
    }
  })();

  try {
    await initPromise;
  } finally {
    // Keep the promise while the SDK is ready; clear it only if setup failed before sb existed.
    if (!sb) initPromise = null;
  }
}

export async function signInCloud() {
  try {
    if (!sb) await initCloud();
    if (!sb) {
      const message = status.error || 'The Supabase client could not be initialized.';
      toast(`Sign-in could not start: ${message}`, { type: 'error', ms: 12000 });
      return;
    }
    const redirectTo = new URL('/', location.origin).href;
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    });
    if (error) toast(`Google sign-in failed: ${error.message || 'Please try again.'}`, { type: 'error', ms: 12000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Please try again.';
    toast(`Google sign-in failed: ${message}`, { type: 'error', ms: 12000 });
  }
}

export async function signOutCloud() {
  if (!sb || !user) return;
  if (meta.dirty && !paused) await push(); // upload anything still waiting, best effort
  await sb.auth.signOut();
  paused = false;
}

/** Called when the user clicks the account button while a conflict is waiting. */
export function resumeSync() {
  if (!user) return;
  paused = false;
  reconcile();
}
