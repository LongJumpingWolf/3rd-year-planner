import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { explainShareError, newToken, viewerUrl } from '../../js/share.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('explainShareError: a missing table or function is reported as one-time setup', () => {
  for (const e of [{ code: 'PGRST205', message: "Could not find the table 'public.viewer_share' in the schema cache" }, { code: 'PGRST202' }, { code: '42P01' }, { message: 'relation "viewer_share" does not exist' }]) {
    assert.equal(explainShareError(e).kind, 'setup', JSON.stringify(e));
  }
  assert.match(explainShareError({ code: 'PGRST205' }).message, /One-time setup/);
});

test('explainShareError: permission, network and other problems each get their own message', () => {
  assert.equal(explainShareError({ code: '42501', message: 'permission denied for table viewer_share' }).kind, 'permission');
  assert.equal(explainShareError({ message: 'new row violates row-level security policy' }).kind, 'permission');
  assert.equal(explainShareError(new TypeError('Failed to fetch')).kind, 'network');
  const other = explainShareError({ code: '23505', message: 'duplicate key value' });
  assert.equal(other.kind, 'other');
  assert.match(other.message, /duplicate key value/);
});

test('tokens are long, URL-safe and different every time; the link keeps the token after #', () => {
  const a = newToken();
  const b = newToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32 && /^[A-Za-z0-9_-]+$/.test(a));
  globalThis.location = { href: 'https://example.vercel.app/#settings' };
  assert.equal(viewerUrl(a), `https://example.vercel.app/view.html#t=${a}`);
  delete globalThis.location;
});

test('the setup SQL can be run more than once and creates everything the app needs', () => {
  const viewer = read('supabase/viewer.sql');
  assert.match(viewer, /create table if not exists public\.viewer_share/);
  assert.match(viewer, /create or replace function public\.get_shared_progress/);
  assert.match(viewer, /grant execute on function public\.get_shared_progress\(text\) to anon/);
  assert.equal((viewer.match(/create policy/g) || []).length, (viewer.match(/drop policy if exists/g) || []).length, 'every policy is dropped first, so re-running does not fail');
  assert.match(viewer, /enable row level security/);
  const schema = read('supabase/schema.sql');
  assert.match(schema, /create table if not exists public\.user_state/);
  assert.equal((schema.match(/create policy/g) || []).length, (schema.match(/drop policy if exists/g) || []).length);
});

test('the supabase folder is shipped with the site so the app can show the setup SQL', () => {
  assert.match(read('scripts/build.mjs'), /'supabase'/);
  assert.match(read('server.js'), /'supabase'/);
});
