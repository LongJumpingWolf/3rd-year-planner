// Settings panel for the viewer link.
import { cloudConfigured, onStatus } from '../cloud.js';
import { disableShare, enableShare, onShare, regenerateShare, viewerUrl } from '../share.js';
import { confirmDialog } from './dialogs.js';
import { $ } from './dom.js';
import { toast } from './toast.js';

export function initViewerLink() {
  const stateEl = $('#viewerState');
  const row = $('#viewerLinkRow');
  const buttons = [$('#viewerCreate'), $('#viewerNew'), $('#viewerOff')];
  const [create, again, off] = buttons;
  let signedIn = false;
  let share = null;
  let busy = false;

  const paint = () => {
    const on = !!share?.enabled;
    create.hidden = on || !signedIn;
    again.hidden = !on;
    off.hidden = !on;
    row.hidden = !on;
    if (on) {
      const url = viewerUrl(share.token);
      $('#viewerUrl').value = url;
      $('#viewerOpen').href = url;
    }
    stateEl.textContent = !cloudConfigured() ? 'Viewer links need cloud sync. Set it up first (see README, "Cloud sync").'
      : !signedIn ? 'Sign in with Google (top right) to create a viewer link.'
      : on ? 'Your viewer link is on.'
      : share ? 'Your viewer link is off. The old link no longer works.'
      : 'No viewer link yet.';
  };

  const run = async (fn, okMsg) => {
    if (busy) return;
    busy = true;
    buttons.forEach((b) => { b.disabled = true; });
    try {
      await fn();
      toast(okMsg);
    } catch {
      toast('Could not update the viewer link. Check your connection and that supabase/viewer.sql was run.', { type: 'error', ms: 8000 });
    }
    busy = false;
    buttons.forEach((b) => { b.disabled = false; });
  };

  create.addEventListener('click', () => run(enableShare, 'Viewer link created. Copy it and send it to your viewer.'));
  again.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Make a new link?', message: 'The current link stops working straight away. Anyone you shared it with will need the new one.', confirmLabel: 'Make new link' });
    if (ok) run(regenerateShare, 'New viewer link created. The old one no longer works.');
  });
  off.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Turn off the viewer link?', message: 'Your viewer will see a "link is off" message and the shared summary is deleted. You can create a new link later.', confirmLabel: 'Turn off', danger: true });
    if (ok) run(disableShare, 'Viewer link turned off.');
  });
  $('#viewerCopy').addEventListener('click', async () => {
    const input = $('#viewerUrl');
    try {
      await navigator.clipboard.writeText(input.value);
      toast('Link copied.');
    } catch {
      input.select();
      toast('Press Ctrl+C (or long-press) to copy the selected link.');
    }
  });
  $('#viewerUrl').addEventListener('focus', (e) => e.target.select());

  onStatus((s) => { signedIn = !!s.user; paint(); });
  onShare((s) => { share = s; paint(); });
}
