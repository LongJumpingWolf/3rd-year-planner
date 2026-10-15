// Viewer link: owner-side management of the numbers-only summary that a secret link exposes (see view.html).
import { getContext, onStatus } from './cloud.js';
import { state } from './store.js';
import { dateISO } from './utils.js';
import { buildSnapshot } from './viewerSnapshot.js';

const TABLE = 'viewer_share';
let share = null;          // { enabled, token } for the signed-in user, or null
let loadedFor = null;
let lastSyncedAt = null;
let timer = null;
const listeners = new Set();

/**
 * Turn a Supabase / network error into something a person can act on.
 *  kind: 'setup' (table or function missing: viewer.sql was not run), 'permission', 'network' or 'other'
 */
export function explainShareError(e) {
  const code = String(e?.code || '');
  const msg = String(e?.message || e || '');
  if (['PGRST205', 'PGRST202', '42P01', '42883'].includes(code) || /could not find the (table|function)|does not exist/i.test(msg)) {
    return { kind: 'setup', message: 'One-time setup is missing: the viewer link table does not exist in your Supabase project yet.' };
  }
  if (code === '42501' || /permission denied|row-level security/i.test(msg)) {
    return { kind: 'permission', message: 'Supabase refused the request. Sign out and in again, and check that supabase/viewer.sql ran without errors.' };
  }
  if (e instanceof TypeError || /failed to fetch|network|offline/i.test(msg) || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return { kind: 'network', message: 'No connection to Supabase. Check your internet and try again.' };
  }
  return { kind: 'other', message: `Could not update the viewer link${msg ? ` (${msg.slice(0, 120)})` : ''}.` };
}

let problem = null;
const problemListeners = new Set();
export const getShareProblem = () => problem;
export function onShareProblem(fn) { problemListeners.add(fn); fn(problem); return () => problemListeners.delete(fn); }
function setProblem(p) { problem = p; problemListeners.forEach((fn) => fn(problem)); }

export const getShare = () => share;
export function onShare(fn) { listeners.add(fn); fn(share); return () => listeners.delete(fn); }
function setShare(next) { share = next; listeners.forEach((fn) => fn(share)); }

/** 192 random bits as URL-safe text: cannot be guessed. */
export function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The token goes after # so it is never sent to the server or written to access logs. */
export function viewerUrl(token) {
  return `${new URL('view.html', location.href).href}#t=${token}`;
}

function snapshotNow() {
  const { user } = getContext();
  return buildSnapshot(state, dateISO(new Date()), { name: (user?.name || '').split(' ')[0] });
}

async function loadShare() {
  const { sb, user } = getContext();
  const { data, error } = await sb.from(TABLE).select('token, enabled').eq('user_id', user.id).maybeSingle();
  if (error) throw error;
  loadedFor = user.id;
  setShare(data ? { enabled: !!data.enabled, token: data.token } : null);
}

/** Upload a fresh summary (only while the link is on). */
export async function publishSnapshot() {
  const { sb, user } = getContext();
  if (!sb || !user || !share?.enabled) return;
  const { error } = await sb.from(TABLE).update({ snapshot: snapshotNow(), updated_at: new Date().toISOString() }).eq('user_id', user.id);
  if (error) throw error;
}

async function write(fields) {
  const { sb, user } = getContext();
  const { error } = await sb.from(TABLE).upsert({ user_id: user.id, ...fields, updated_at: new Date().toISOString() });
  if (error) throw error;
}

/** Create the link, or switch an existing one back on. */
export async function enableShare() {
  const token = share?.token || newToken();
  await write({ token, enabled: true, snapshot: snapshotNow() });
  setShare({ enabled: true, token });
}

/** A new secret: the old link stops working immediately. */
export async function regenerateShare() {
  const token = newToken();
  await write({ token, enabled: true, snapshot: snapshotNow() });
  setShare({ enabled: true, token });
}

/** Switch the link off and wipe the stored summary. */
export async function disableShare() {
  const token = share?.token || newToken();
  await write({ token, enabled: false, snapshot: {} });
  setShare({ enabled: false, token });
}

/** Keep the summary fresh: every time cloud sync completes, publish a new one (after a short pause). */
export function initShare() {
  onStatus((s) => {
    if (!s.user) {
      loadedFor = null;
      lastSyncedAt = null;
      if (share) setShare(null);
      return;
    }
    if (s.code !== 'synced' || s.syncedAt === lastSyncedAt) return;
    lastSyncedAt = s.syncedAt;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        if (loadedFor !== getContext().user?.id) await loadShare();
        await publishSnapshot();
        setProblem(null);
      } catch (e) {
        setProblem(explainShareError(e)); // offline or the table is missing: the link keeps its last summary and the Settings panel says why
      }
    }, 800);
  });
}
