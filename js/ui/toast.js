// Non-blocking messages announced to screen readers via the #toasts live region.
const MAX = 3;

export function toast(message, { type = 'ok', ms = 4500, action } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type === 'ok' ? '' : type}`.trim();
  const text = document.createElement('span');
  text.textContent = message;
  el.append(text);
  const remove = () => el.remove();
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => { action.run(); remove(); });
    el.append(b);
  }
  host.append(el);
  while (host.children.length > MAX) host.firstElementChild.remove();
  if (ms) setTimeout(remove, type === 'error' ? ms * 1.6 : ms);
}
