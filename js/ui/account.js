// Header + Settings controls for Google sign-in and sync status.
import { cloudConfigured, onStatus, resumeSync, signInCloud, signOutCloud } from '../cloud.js';
import { confirmDialog } from './dialogs.js';
import { $ } from './dom.js';

const LABEL = {
  connecting: 'Connecting…',
  syncing: 'Syncing…',
  offline: 'Offline. Changes are saved on this device and will upload when you are back online.',
  paused: 'Sync is paused until you choose which copy to keep.',
  error: 'Could not reach the cloud. Changes are saved on this device and will retry.',
};

function statusText(s) {
  if (s.code === 'unconfigured') return 'Cloud sync is not set up for this copy of the app. Add a Supabase config (see README, "Cloud sync") to sign in with Google and open your progress on any device.';
  if (s.code === 'signed-out') return 'Sign in with Google to keep your progress in sync across your phone, laptop and tablet. It still works offline.';
  if (s.code === 'error' && s.error) return `Cloud connection error: ${s.error}`;
  const who = s.user?.email ? `Signed in as ${s.user.email}. ` : '';
  if (s.code === 'synced') return `${who}Synced${s.syncedAt ? ` at ${new Date(s.syncedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}.`;
  return `${who}${LABEL[s.code] || ''}`;
}

export function initAccount() {
  const topBtn = $('#accountBtn');
  const setBtn = $('#syncBtn');
  const text = $('#syncStatus');
  if (!cloudConfigured()) {
    topBtn.hidden = true;
    setBtn.hidden = true;
    text.textContent = statusText({ code: 'unconfigured' });
    return;
  }
  const handle = async (s) => {
    if (s.code === 'paused') return resumeSync();
    if (!s.user) return signInCloud();
    const ok = await confirmDialog({
      title: 'Sign out?',
      message: 'Your progress stays on this device and in your Google account. Changes made after signing out will not sync until you sign in again.',
      confirmLabel: 'Sign out',
    });
    if (ok) await signOutCloud();
    return undefined;
  };
  let current = null;
  topBtn.addEventListener('click', () => handle(current));
  setBtn.addEventListener('click', () => handle(current));
  onStatus((s) => {
    current = s;
    const signedIn = !!s.user;
    topBtn.textContent = s.code === 'paused' ? 'Resolve sync' : s.code === 'connecting' ? 'Connecting…' : signedIn ? `Signed in · ${s.code === 'synced' ? 'Synced' : s.code === 'syncing' ? 'Syncing' : s.code === 'offline' ? 'Offline' : 'Check sync'}` : 'Sign in with Google';
    topBtn.title = signedIn ? `${s.user.email} (click to sign out)` : 'Sign in to sync your progress across devices';
    setBtn.textContent = s.code === 'paused' ? 'Resolve sync' : signedIn ? 'Sign out' : 'Sign in with Google';
    text.textContent = statusText(s);
  });
}
