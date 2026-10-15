-- Run once in the Supabase SQL editor (after schema.sql). Adds the viewer link.
-- Viewer link: a numbers-only summary that anyone holding the secret token can read (no sign-in needed).
-- The summary is a separate row, so the viewer can never reach user_state (your full planner data).
create table if not exists public.viewer_share (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  token      text        not null unique check (length(token) >= 32),
  enabled    boolean     not null default true,
  snapshot   jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.viewer_share enable row level security;

create policy "own share: read"   on public.viewer_share for select using (auth.uid() = user_id);
create policy "own share: insert" on public.viewer_share for insert with check (auth.uid() = user_id);
create policy "own share: update" on public.viewer_share for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own share: delete" on public.viewer_share for delete using (auth.uid() = user_id);

-- The only door for viewers: look up one summary by its token.
-- Returns null when the token is wrong or the link is switched off.
create or replace function public.get_shared_progress(p_token text)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select snapshot from public.viewer_share where token = p_token and enabled limit 1;
$$;

revoke all on function public.get_shared_progress(text) from public;
grant execute on function public.get_shared_progress(text) to anon, authenticated;
