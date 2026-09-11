-- Comments were launched as a moderation queue (new ones start 'pending' and
-- stay invisible to every visitor, including the author, until a staff
-- member approves them) — the same pattern used for contact_requests. That
-- turned out to be the wrong call for this feature: a comment is expected to
-- post immediately and stay visible to everyone, not sit in a review queue.
-- This migration switches the default outcome of a public submission from
-- 'pending' to 'approved', while keeping every other guarantee in place:
-- the trigger still runs server-side and still overrides whatever status
-- value a client sends, so a visitor still cannot forge 'approved' in a way
-- that bypasses this decision, and staff can still hide or delete any
-- individual comment after the fact via the existing Comments admin tab.

create or replace function public.sanitize_public_comment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    new.status := 'approved';
  end if;
  return new;
end;
$$;

alter policy "public can submit comments" on public.post_comments
with check (status = 'approved');
