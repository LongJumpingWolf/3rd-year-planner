// Small DOM helpers shared by every view.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Attribute string for an action button: delegated click handler + a stable key for focus restoration. */
export function actionAttrs(action, id = '', ctx = '') {
  const esc = (s) => String(s).replace(/"/g, '&quot;');
  return `data-action="${esc(action)}" data-id="${esc(id)}" data-key="${esc(`${action}:${id}:${ctx}`)}"`;
}

/**
 * Re-render a region without throwing keyboard users back to the top of the page:
 * remember which keyed control had focus and put focus back on its replacement.
 */
export function renderKeepingFocus(render) {
  const active = document.activeElement;
  const key = active && active !== document.body ? active.getAttribute?.('data-key') : null;
  const id = active && !key ? active.id : '';
  render();
  if (key) {
    const next = [...document.querySelectorAll('[data-key]')].find((el) => el.getAttribute('data-key') === key && el.offsetParent !== null);
    if (next) next.focus({ preventScroll: true });
  } else if (id) {
    document.getElementById(id)?.focus({ preventScroll: true });
  }
}

/** Download a text blob as a file. */
export function downloadText(name, text, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export function setProgress(wrapEl, barEl, pct, color) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  barEl.style.width = `${v}%`;
  barEl.style.background = color || '';
  wrapEl?.setAttribute('aria-valuenow', String(v));
}
