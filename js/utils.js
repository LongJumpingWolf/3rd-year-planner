// Pure helpers: dates, formatting, escaping, CSV. No DOM access, so they are unit-testable in Node.

const pad = (n) => String(n).padStart(2, '0');

export function dateISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for real calendar dates in YYYY-MM-DD form (rejects 2026-02-31). */
export function isValidISO(s) {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  const d = new Date(`${s}T12:00:00`);
  return !Number.isNaN(d.getTime()) && dateISO(d) === s;
}

/** Parse YYYY-MM-DD at local noon (avoids DST edge cases). Falls back to today. */
export function fromISO(s) {
  const d = new Date(`${s || dateISO(new Date())}T12:00:00`);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Monday of the week containing d, at local noon. */
export function weekStart(d) {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  x.setHours(12, 0, 0, 0);
  return x;
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m${s ? ` ${s}s` : ''}`;
  return `${s}s`;
}

/** '1 h 10 min', '45 min', '0 min' - the format used for block totals. */
export function fmtDur(sec) {
  const m = Math.max(0, Math.round(sec / 60));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h && r) return `${h} h ${r} min`;
  if (h) return `${h} h`;
  return `${r} min`;
}

export function fmtHours(sec) {
  const h = sec / 3600;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

export function fmtDate(iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  return fromISO(iso).toLocaleDateString(undefined, opts);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Number() that returns `fallback` for blank / non-numeric input (but keeps a legitimate 0). */
export function num(v, fallback = 0) {
  if (v === '' || v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function csvEscape(v) {
  let s = String(v ?? '');
  // Neutralise spreadsheet formula injection when the file is opened in Excel/Sheets.
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCSV(rows) {
  return rows.map((r) => r.map(csvEscape).join(',')).join('\n');
}

/** Parse CSV text (with quoted multi-line fields) into an array of row objects keyed by header. */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x !== '')) rows.push(row);
  if (!rows.length) return [];
  const heads = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(heads.map((h, i) => [h, r[i] ?? ''])));
}
