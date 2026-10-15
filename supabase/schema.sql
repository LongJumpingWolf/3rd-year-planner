-- Run once in the Supabase SQL editor. One row per signed-in user; row-level security keeps each account to its own row.
create table if not exists public.user_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  state      jsonb       not null,
  rev        integer     not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.user_state enable row level security;

create policy "own row: read"   on public.user_state for select using (auth.uid() = user_id);
create policy "own row: insert" on public.user_state for insert with check (auth.uid() = user_id);
create policy "own row: update" on public.user_state for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own row: delete" on public.user_state for delete using (auth.uid() = user_id);

-- Live updates between devices.
alter publication supabase_realtime add table public.user_state;
