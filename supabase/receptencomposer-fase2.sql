-- Receptencomposer — Fase 2: extra velden voor de import.
-- Draai dit in de Supabase SQL editor (na receptencomposer.sql).

-- Geschatte yield: als 'Opbrengst' in Notion ontbreekt schat de importer de yield
-- uit de som van de inputs. Dit flagt dat (zodat de UI "geschat" kan tonen).
alter table public.bereiding add column if not exists yield_geschat boolean not null default false;
alter table public.bereiding add column if not exists yield_bron text;   -- 'opbrengst' | 'som van inputs'

-- Review-queue: receptregels die de importer niet kon koppelen aan een
-- ingrediënt of bereiding. Verschijnen later in de webapp ter handmatige koppeling.
create table if not exists public.bereiding_import_review (
  id           uuid primary key default gen_random_uuid(),
  bereiding_id uuid references public.bereiding(id) on delete cascade,
  regel_naam   text not null,
  hoeveelheid  numeric,
  eenheid      text,
  status       text default 'pending',   -- pending | gekoppeld | genegeerd
  created_at   timestamptz default now()
);
create index if not exists bereiding_import_review_status_idx on public.bereiding_import_review (status, created_at desc);

alter table public.bereiding_import_review enable row level security;
drop policy if exists "bereiding_import_review anon all" on public.bereiding_import_review;
create policy "bereiding_import_review anon all" on public.bereiding_import_review
  for all to anon, authenticated using (true) with check (true);
