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
  await sb.from(TABLE).update({ snapshot: snapshotNow(), updated_at: new Date().toISOString() }).eq('user_id', user.id);
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
      } catch { /* offline or table missing: the link simply keeps its last summary */ }
    }, 800);
  });
}
