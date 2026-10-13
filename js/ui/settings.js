import { DEFAULT_SETTINGS } from '../planner.js';
import { state } from '../store.js';
import { $ } from './dom.js';

let filledFor = null;

export function renderSettings() {
  if (filledFor === state.settings) return;
  filledFor = state.settings;
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const el = $('#' + k);
    if (el) el.value = state.settings[k];
  }
  clearErrors();
}

export function clearErrors() {
  document.querySelectorAll('#settingsForm [aria-invalid]').forEach((el) => {
    el.removeAttribute('aria-invalid');
    el.removeAttribute('aria-describedby');
  });
  document.querySelectorAll('#settingsForm .error-text').forEach((el) => el.remove());
}

export function showFieldError(name, message) {
  clearErrors();
  const el = $('#' + name);
  if (!el) return;
  const msg = document.createElement('span');
  msg.className = 'error-text';
  msg.id = `${name}-err`;
  msg.textContent = message;
  el.after(msg);
  el.setAttribute('aria-invalid', 'true');
  el.setAttribute('aria-describedby', msg.id);
  el.focus();
}
