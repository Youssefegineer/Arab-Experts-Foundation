-- Case confidentiality hardening.
--
-- The original "public can read published cases" policy on public.cases only
-- filtered ROWS (public_status = 'published' and archived_at is null). RLS in
-- PostgreSQL is row-level only: it does not restrict which COLUMNS a role may
-- select. Because Supabase grants broad table-level SELECT to anon/authenticated
-- by default, any published case row was fully readable through the REST API
-- with `select=*`, including internal_reference, client_reference,
-- opposing_party, court, jurisdiction, case_number, internal_notes and
-- assigned_lawyer_id. Verified live: an anonymous request for
-- `cases?select=internal_notes,client_reference,opposing_party,case_number`
-- returned HTTP 200 (permitted), not a permission error.
--
-- Fix: remove public/anon row access to the base table entirely and replace it
-- with a view that exposes only the intentionally public columns (the
-- `public_*` fields plus non-sensitive display fields). Staff access to the
-- full table for CRUD is untouched (the "staff manage cases" policy still
-- grants admins/editors full row and column access to public.cases directly).

drop policy if exists "public can read published cases" on public.cases;

create view public.cases_public as
select
  id,
  public_title,
  public_summary,
  public_description,
  public_outcome,
  public_year,
  featured_image,
  practice_area_id,
  public_slug,
  created_at,
  updated_at
from public.cases
where public_status = 'published' and archived_at is null;

comment on view public.cases_public is
  'Public-safe projection of public.cases. Never add internal_reference, internal_notes, client_reference, opposing_party, court, jurisdiction, case_number, filing_date, hearing_date, assigned_lawyer_id, status or outcome_date to this view — those are confidential case fields.';

grant select on public.cases_public to anon, authenticated;
