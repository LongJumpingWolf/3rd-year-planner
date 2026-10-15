// Settings panel for the viewer link.
import { cloudConfigured, onStatus, signInCloud } from '../cloud.js';
import { disableShare, enableShare, onShare, regenerateShare, viewerUrl } from '../share.js';
import { esc } from '../utils.js';
import { confirmDialog, openDialog } from './dialogs.js';
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

  // Dashboard shortcut: one button that creates the link if needed and shows it ready to copy.
  const shareBtn = $('#shareBtn');
  shareBtn.hidden = !cloudConfigured();
  onStatus((s) => { signedIn = !!s.user; paint(); });
  onShare((s) => { share = s; paint(); });
  shareBtn.addEventListener('click', async () => {
    if (!signedIn) {
      toast('Sign in with Google first, then you can share a viewer link.', { action: { label: 'Sign in', run: () => signInCloud() }, ms: 9000 });
      return;
    }
    if (!share?.enabled) {
      if (busy) return;
      busy = true;
      shareBtn.disabled = true;
      try { await enableShare(); } catch {
        toast('Could not create the viewer link. Check your connection and that supabase/viewer.sql was run.', { type: 'error', ms: 8000 });
        busy = false;
        shareBtn.disabled = false;
        return;
      }
      busy = false;
      shareBtn.disabled = false;
    }
    showLinkDialog(viewerUrl(share.token));
  });
}

function showLinkDialog(url) {
  openDialog({
    title: 'Share your progress',
    submitLabel: null,
    cancelLabel: 'Done',
    body: `<p>Send this link to a parent or friend. They see big, simple numbers only: no lecture titles, no planner, no controls.</p>
      <div class="row"><label class="sr-only" for="shareUrl">Viewer link</label><input id="shareUrl" type="text" readonly value="${esc(url)}" style="flex:1 1 240px;min-width:0"><button type="button" id="shareCopy">Copy link</button></div>
      <p class="small muted">Anyone who has the link can open it. To switch it off or get a new link, go to Settings > Viewer link.</p>`,
    onOpen: (form) => {
      const input = form.querySelector('#shareUrl');
      input.select();
      form.querySelector('#shareCopy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(url); toast('Link copied.'); } catch { input.select(); toast('Press Ctrl+C (or long-press) to copy the selected link.'); }
      });
    },
  });
}
