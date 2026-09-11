-- Real, shared comments and likes for posts. The previous implementation
-- stored both in browser localStorage, so nothing was ever visible to any
-- visitor other than the one who wrote it — this replaces that with actual
-- rows anyone's browser can read, moderated the same way contact requests
-- already are (public can submit, only staff sees/approves the queue).

create table public.post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  author_name text not null,
  author_email text,
  content text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  constraint post_comments_author_name_length check (length(btrim(author_name)) between 2 and 80),
  constraint post_comments_content_length check (length(btrim(content)) between 2 and 2000)
);

create index post_comments_post_status_idx on public.post_comments (post_id, status, created_at desc);

alter table public.post_comments enable row level security;

-- Public sees only comments a staff member has approved.
create policy "public can read approved comments" on public.post_comments
for select using (status = 'approved');

-- Public can submit a comment; the trigger below forces status back to
-- 'pending' regardless of what's in the request body, same pattern as
-- contact_requests' own sanitize trigger.
create policy "public can submit comments" on public.post_comments
for insert with check (status = 'pending');

create policy "staff manage comments" on public.post_comments
for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());

create or replace function public.sanitize_public_comment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    new.status := 'pending';
  end if;
  return new;
end;
$$;

create trigger sanitize_public_comment_before_insert
before insert on public.post_comments
for each row execute function public.sanitize_public_comment();

-- Likes: a simple counter column on posts, moved by two narrow
-- security-definer functions rather than a direct public UPDATE grant on
-- posts (which would need to open far more of that table than "one number"
-- to anonymous writers). Both are no-ops on anything not currently public.
alter table public.posts add column like_count integer not null default 0;

create or replace function public.increment_post_like(target_post_id uuid)
returns integer language sql security definer set search_path = public as $$
  update public.posts set like_count = like_count + 1
  where id = target_post_id and status = 'published' and archived_at is null
  returning like_count;
$$;

create or replace function public.decrement_post_like(target_post_id uuid)
returns integer language sql security definer set search_path = public as $$
  update public.posts set like_count = greatest(like_count - 1, 0)
  where id = target_post_id and status = 'published' and archived_at is null
  returning like_count;
$$;

grant execute on function public.increment_post_like(uuid) to anon, authenticated;
grant execute on function public.decrement_post_like(uuid) to anon, authenticated;
