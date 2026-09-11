-- Media storage for uploaded images (post images, lawyer photos, case
-- featured images). The `media` bucket itself is created via the Storage
-- Management API (not plain SQL), so create it manually first if replaying
-- this migration on a fresh project:
--
--   POST {SUPABASE_URL}/storage/v1/bucket   (service_role key)
--   { "id": "media", "name": "media", "public": true,
--     "file_size_limit": 5242880,
--     "allowed_mime_types": ["image/jpeg","image/png","image/webp","image/gif"] }
--
-- This file only adds the RLS policies on storage.objects, governing who can
-- read/write objects inside that bucket. The bucket is public for reads
-- (these are public-facing site images), matching public.posts/lawyers/cases
-- media fields, which already store plain URLs anyone can already fetch.
-- Writes reuse the exact same public.is_admin_or_editor() staff check as
-- every other table in this schema.

-- storage.objects has row level security enabled by default on every
-- Supabase project; the owning role for that table is supabase_storage_admin,
-- not postgres, so re-running ENABLE ROW LEVEL SECURITY here would fail with
-- "must be owner of table objects" even though it's already on. Policies can
-- still be created against it without table ownership.

create policy "public can read media bucket"
on storage.objects for select
using (bucket_id = 'media');

create policy "staff can upload to media bucket"
on storage.objects for insert
with check (bucket_id = 'media' and public.is_admin_or_editor());

create policy "staff can update media bucket objects"
on storage.objects for update
using (bucket_id = 'media' and public.is_admin_or_editor())
with check (bucket_id = 'media' and public.is_admin_or_editor());

create policy "staff can delete media bucket objects"
on storage.objects for delete
using (bucket_id = 'media' and public.is_admin_or_editor());
