create extension if not exists pgcrypto;

create type public.publication_status as enum ('draft', 'published');
create type public.inquiry_status as enum ('new', 'in_progress', 'resolved', 'archived');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null default 'editor' check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now()
);

create table public.practice_areas (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.lawyers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  title text,
  bio text,
  photo_url text,
  email text,
  phone text,
  is_public boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  practice_area_id uuid references public.practice_areas(id) on delete set null,
  display_order integer not null default 0,
  status public.publication_status not null default 'draft',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text not null unique,
  category text not null,
  image text,
  content text not null,
  seo_title text,
  seo_description text,
  status public.publication_status not null default 'draft',
  published_at timestamptz,
  archived_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.cases (
  id uuid primary key default gen_random_uuid(),
  internal_reference text not null unique,
  title text not null,
  case_type text,
  practice_area_id uuid references public.practice_areas(id) on delete set null,
  client_reference text,
  opposing_party text,
  court text,
  jurisdiction text,
  case_number text,
  filing_date date,
  hearing_date date,
  status text not null default 'open',
  outcome text,
  outcome_date date,
  assigned_lawyer_id uuid references public.lawyers(id) on delete set null,
  internal_notes text,
  public_title text,
  public_summary text,
  public_description text,
  public_outcome text,
  public_year integer,
  featured_image text,
  public_status public.publication_status not null default 'draft',
  public_slug text unique,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.contact_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text not null,
  message text not null,
  services text[] not null default '{}',
  status public.inquiry_status not null default 'new',
  handled_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index posts_public_idx on public.posts (status, published_at desc) where archived_at is null;
create index cases_public_idx on public.cases (public_status, public_year desc) where archived_at is null;
create index inquiries_status_idx on public.contact_requests (status, created_at desc);

create or replace function public.is_admin_or_editor()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'editor'));
$$;

alter table public.profiles enable row level security;
alter table public.practice_areas enable row level security;
alter table public.lawyers enable row level security;
alter table public.services enable row level security;
alter table public.posts enable row level security;
alter table public.cases enable row level security;
alter table public.contact_requests enable row level security;

create policy "public can read active practice areas" on public.practice_areas for select using (is_active);
create policy "public can read published services" on public.services for select using (status = 'published' and archived_at is null);
create policy "public can read public lawyers" on public.lawyers for select using (is_public and archived_at is null);
create policy "public can read published posts" on public.posts for select using (status = 'published' and archived_at is null);
create policy "public can read published cases" on public.cases for select using (public_status = 'published' and archived_at is null);
create policy "public can submit contact requests" on public.contact_requests
for insert with check (status = 'new' and handled_by is null);

create policy "staff manage practice areas" on public.practice_areas for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy "staff manage lawyers" on public.lawyers for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy "staff manage services" on public.services for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy "staff manage posts" on public.posts for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy "staff manage cases" on public.cases for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy "staff manage inquiries" on public.contact_requests for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy "users read own profile" on public.profiles for select using (id = auth.uid());

create or replace function public.sanitize_public_inquiry()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    new.status := 'new';
    new.handled_by := null;
  end if;
  return new;
end;
$$;

create trigger sanitize_public_inquiry_before_insert
before insert on public.contact_requests
for each row execute function public.sanitize_public_inquiry();

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

do $$ declare table_name text; begin
  foreach table_name in array array['practice_areas','lawyers','services','posts','cases','contact_requests']
  loop execute format('create trigger %I_updated_at before update on public.%I for each row execute function public.set_updated_at()', table_name, table_name); end loop;
end $$;
