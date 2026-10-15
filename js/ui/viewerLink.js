// Settings panel for the viewer link.
import { cloudConfigured, onStatus, signInCloud } from '../cloud.js';
import { disableShare, enableShare, explainShareError, onShare, onShareProblem, regenerateShare, viewerUrl } from '../share.js';
import { supabaseConfig } from '../supabase-config.js';
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
  let problem = null;
  let busy = false;
  const setupBtn = $('#viewerSetup');

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
    const needsSetup = signedIn && problem?.kind === 'setup';
    setupBtn.hidden = !needsSetup;
    if (needsSetup) create.hidden = true;
    stateEl.textContent = !cloudConfigured() ? 'Viewer links need cloud sync. Set it up first (see README, "Cloud sync").'
      : !signedIn ? 'Sign in with Google (top right) to create a viewer link.'
      : needsSetup ? problem.message
      : signedIn && problem ? problem.message
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
    } catch (e) {
      reportError(e);
    }
    busy = false;
    buttons.forEach((b) => { b.disabled = false; });
  };

  setupBtn.addEventListener('click', showSetupDialog);
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
  onShareProblem((p) => { problem = p; paint(); });
  shareBtn.addEventListener('click', async () => {
    if (!signedIn) {
      toast('Sign in with Google first, then you can share a viewer link.', { action: { label: 'Sign in', run: () => signInCloud() }, ms: 9000 });
      return;
    }
    if (problem?.kind === 'setup') { showSetupDialog(); return; }
    if (!share?.enabled) {
      if (busy) return;
      busy = true;
      shareBtn.disabled = true;
      try { await enableShare(); } catch (e) {
        reportError(e);
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

/** Say what went wrong in plain words; when the database is not set up yet, offer the setup steps right there. */
function reportError(e) {
  const x = explainShareError(e);
  toast(x.message, x.kind === 'setup'
    ? { type: 'error', ms: 15000, action: { label: 'Show setup steps', run: showSetupDialog } }
    : { type: 'error', ms: 9000 });
}

/** Where the person pastes the SQL: the SQL editor of their own Supabase project. */
export const sqlEditorUrl = () => {
  const ref = new URL(supabaseConfig.url).hostname.split('.')[0];
  return `https://supabase.com/dashboard/project/${ref}/sql/new`;
};

/** One-time database setup: shows the SQL ready to copy, with the steps. */
export async function showSetupDialog() {
  let sql = '';
  try {
    const res = await fetch('supabase/viewer.sql', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    sql = await res.text();
  } catch {
    sql = '-- Could not load the SQL here. Open supabase/viewer.sql from the project files and paste its contents instead.';
  }
  await openDialog({
    title: 'One-time setup for viewer links',
    submitLabel: null,
    cancelLabel: 'Done',
    body: `<ol class="steps">
        <li>Press <strong>Copy SQL</strong> below.</li>
        <li><a href="${esc(sqlEditorUrl())}" target="_blank" rel="noopener noreferrer">Open the SQL editor of your Supabase project</a> (sign in if asked).</li>
        <li>Paste the SQL into the editor and press <strong>Run</strong>. It says "Success" when done. It is safe to run again.</li>
        <li>Come back here and press <strong>Create viewer link</strong>.</li>
      </ol>
      <label class="sr-only" for="setupSql">Setup SQL</label>
      <textarea id="setupSql" readonly rows="9" style="width:100%;font-family:monospace;font-size:12px">${esc(sql)}</textarea>
      <div class="row"><button type="button" id="setupCopy" class="primary">Copy SQL</button></div>`,
    onOpen: (form) => {
      const area = form.querySelector('#setupSql');
      form.querySelector('#setupCopy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(sql); toast('SQL copied. Paste it into the Supabase SQL editor.'); } catch { area.select(); toast('Press Ctrl+C to copy the selected SQL.'); }
      });
    },
  });
}
