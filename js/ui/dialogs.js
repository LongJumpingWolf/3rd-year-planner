// Accessible modal dialogs built on <dialog>: focus is trapped, Esc cancels, focus returns to the opener.
import { esc } from '../utils.js';

let seq = 0;

/**
 * Open a modal form dialog.
 *  title        heading text
 *  body         HTML for the form body
 *  submitLabel  text of the primary button (null hides it)
 *  cancelLabel  text of the cancel button
 *  danger       style the primary button as destructive
 *  onOpen(form) optional hook after the dialog is shown (wire up live filtering etc.)
 *  onSubmit(values, form)  return an error string to keep the dialog open, or anything else to close it
 * Resolves with the submit result (true if onSubmit returned nothing) or null if cancelled.
 */
export function openDialog({ title, body, submitLabel = 'OK', cancelLabel = 'Cancel', danger = false, onOpen, onSubmit, initialFocus }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const id = `dlg${++seq}`;
    const dlg = document.createElement('dialog');
    dlg.setAttribute('aria-labelledby', `${id}-t`);
    dlg.innerHTML = `<form method="dialog" novalidate>
      <div class="dlg-head"><h2 id="${id}-t">${esc(title)}</h2></div>
      <div class="dlg-body">${body}<p class="error-text" role="alert" hidden></p></div>
      <div class="dlg-foot">
        <button type="button" data-cancel>${esc(cancelLabel)}</button>
        ${submitLabel ? `<button type="submit" class="${danger ? 'danger' : 'primary'}">${esc(submitLabel)}</button>` : ''}
      </div></form>`;
    document.body.append(dlg);
    const form = dlg.querySelector('form');
    const errEl = dlg.querySelector('.error-text');
    let result = null;

    const showError = (msg) => { errEl.textContent = msg; errEl.hidden = !msg; };
    const close = (value) => { result = value; dlg.close(); };

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(form).entries());
      const checked = {};
      form.querySelectorAll('input[type=checkbox][name]:checked').forEach((el) => {
        (checked[el.name] ??= []).push(el.value);
      });
      const out = onSubmit ? onSubmit({ ...values, _all: checked }, form) : undefined;
      if (typeof out === 'string') { showError(out); return; }
      close(out === undefined ? true : out);
    });
    form.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    dlg.addEventListener('cancel', () => { result = null; }); // Esc
    dlg.addEventListener('close', () => {
      dlg.remove();
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
      resolve(result);
    });
    // Keep Tab / Shift+Tab cycling inside the dialog.
    dlg.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = [...dlg.querySelectorAll('button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    // Click on the backdrop (outside the dialog box) cancels.
    dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) close(null); });

    dlg.showModal();
    onOpen?.(form, showError);
    const target = (initialFocus && form.querySelector(initialFocus)) || form.querySelector('input:not([type=hidden]), select, textarea') || form.querySelector('button[type=submit]') || form.querySelector('[data-cancel]');
    target?.focus();
  });
}

/** Yes/no confirmation. Resolves true or false. */
export async function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  const r = await openDialog({ title, body: `<p>${esc(message)}</p>`, submitLabel: confirmLabel, danger, initialFocus: '[data-cancel]' });
  return r === true;
}

/** Read-only information dialog. */
export function infoDialog({ title, body, closeLabel = 'Close' }) {
  return openDialog({ title, body, submitLabel: null, cancelLabel: closeLabel });
}
