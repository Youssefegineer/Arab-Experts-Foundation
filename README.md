# Arab Expert platform

A static HTML site with a Supabase-backed content layer. Public pages read only
published/approved records through the Supabase Data API; the admin panel
(`admin.html`) is a full CMS for posts, cases, lawyers, services, practice
areas and contact requests, gated behind Supabase Auth.

- **Configured mode:** `config.js` supplies a Supabase URL and public anon key.
  Public pages read only published records; contact requests are inserted into
  `contact_requests`. Admin writes require Supabase Auth and the RLS policies
  in `supabase/migrations/`.
- **Local fallback:** without `config.js`, public posts and contact requests
  fall back to browser `localStorage` so the site stays browsable for design
  previews. This is not multi-user storage and is not an authentication
  boundary. The admin panel requires Supabase — there is no local-only admin
  mode.

## Public pages

`index.html`, `about.html`, `services.html`, `cases.html` (the defense-team
page — hand-authored staff profiles, not case studies), `case-studies.html` +
`case-study.html` (published case results, database-driven), `certificates.html`,
`posts.html` + `post-detail.html` (published articles, database-driven),
`contact.html`.

## Setup

For a **fresh** Supabase project, apply the migrations in `supabase/migrations/`,
**in order**, through the Supabase SQL editor or CLI:
- `20260911000000_initial_schema.sql`
- `20260911000001_contact_request_constraints.sql`
- `20260911000002_case_confidentiality_view.sql` — **security-critical**.
  Without it, the public anon key can select every column of `public.cases`,
  including internal notes, client references and opposing-party details, on
  any row that has `public_status = 'published'`. Apply this before ever
  publishing a case.

The project this repo currently points at (`config.js`) already has all three
applied and live-verified (2026-09-11): the base `cases` table returns zero
rows to anonymous/non-staff requests, `cases_public` exposes only the
`public_*` columns, and selecting `internal_notes` through the view fails
with `column does not exist` rather than a permission error. Verified with
real synthetic data (a published test case), not just an empty table.

1. Create a Supabase project and apply the three migrations above (skip if
   using the already-configured project).
2. Create an authenticated user (Supabase Auth), then insert a matching
   `profiles` row with `role` `admin` or `editor` — this requires privileged
   database access (the SQL editor, or a service-role key kept server-side).
   There is no self-service way to become staff: anonymous `INSERT` into
   `profiles` is blocked by RLS by design.
3. Set only the project URL and public anon key in `config.js` (copy
   `config.example.js`). The anon key is publishable; never put a
   service-role/secret key in browser code or commit `config.local.js`.
4. Serve the folder over HTTP, not `file://` (the included
   `.claude/nocache_server.py` works for local preview: `python
   .claude/nocache_server.py 8532 .`). Verify public reads, contact inserts,
   RLS denial for anonymous admin reads, and authenticated admin workflows.

The repository contains only the public anon key for this project; it never
contains a service-role key or database password. Do not attempt to apply DDL
with the anon key — PostgREST does not expose a SQL execution endpoint, and
none should be added.

## Case confidentiality

`public.cases` holds both internal fields (client reference, opposing party,
court, case number, internal notes, assigned lawyer, status/outcome) and a
parallel set of `public_*` fields meant for the website. RLS row policies
alone cannot restrict which *columns* a role sees, so the public site never
queries `cases` directly — it reads `public.cases_public`, a view that
selects only the `public_*` columns (plus `id`, `featured_image`,
`practice_area_id`, `public_slug`, timestamps) for rows where `public_status =
'published' and archived_at is null`. The base table's own public row policy
is dropped; anonymous/non-staff roles get zero rows from `cases` directly and
must go through the view. Staff (`profiles.role in ('admin','editor')`) keep
full read/write access to the base table via the existing `staff manage
cases` policy. See the comment block at the top of migration
`20260911000002` for the exact reasoning and the live test that found the gap.

The admin case form visually separates internal fields (grey box) from public
fields (gold box) and refuses to save a case as `published` unless a public
title and public summary are filled in, with an explicit confirmation prompt
the first time a case is switched from draft to published.

## Storage

Storage is not currently used by the application path; media fields
(`image`, `photo_url`, `featured_image`) store URLs only.

## SEO

Canonical tags and Open Graph metadata are on every static page.
`robots.txt` and `sitemap.xml` are included; `sitemap.xml` needs its
`REPLACE_WITH_YOUR_DOMAIN` placeholder replaced with the real production
domain before it's valid (sitemap URLs must be absolute, and no production
domain exists yet). `post-detail.html` and `case-study.html` update their
`<title>`, meta description and canonical link client-side once the real
post/case content loads.

## Known non-blocking items

- Tailwind is loaded from the CDN (`cdn.tailwindcss.com`) on every page rather
  than a compiled build. This is the Tailwind Play CDN, which is fine for a
  low/medium-traffic site but is not Tailwind's recommended production setup
  (it ships the full JIT compiler to the browser). Introducing a build step
  (npm + Tailwind CLI or PostCSS) is a reasonable future improvement, but is a
  separate infrastructure change from the rest of this codebase and was not
  done as part of this pass to avoid an unrequested build-system rewrite.
- `services.html`, `cases.html` (team page), `about.html` and
  `certificates.html` remain hand-authored static content. The admin panel
  can fully manage the underlying `services`, `lawyers`, `practice_areas` and
  `cases` tables, but these public pages don't read from them yet — wiring
  them up means first entering the current real staff/services data through
  the admin UI, which is a content decision for the site owner, not something
  done silently in this pass.
