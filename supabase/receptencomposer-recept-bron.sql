-- Receptencomposer — read-cache van de ruwe receptdata uit Notion.
-- Zelfde patroon als inkoop_prijzen (de ingrediënten-mirror): Notion blijft bron van waarheid,
-- Supabase is de read-cache. Hiermee hoeft het matchen/her-matchen Notion niet meer live te
-- lezen (dat front-loadde ~60 pagina's sequentieel → traag + timeouts).
--
-- Vulling: `node import-recepten.js --commit` (of een losse mirror-run) schrijft hier de
-- geparste regels naartoe, mét page-mentions al geresolved. `--from-mirror` leest hieruit.
--
-- Draai dit in de Supabase SQL editor.

create table if not exists public.recept_bron (
  notion_page_id    text primary key,
  locatie           text not null check (locatie in ('europizza','europa')),
  naam              text,
  opbrengst         numeric,                 -- gemeten 'Opbrengst' uit Notion (kan null zijn)
  opbrengst_eenheid text,
  regels            jsonb not null default '[]'::jsonb,  -- [{ naam, hoeveelheid, eenheid }]
  gemirrord_op      timestamptz default now()
);
create index if not exists recept_bron_locatie_idx on public.recept_bron (locatie);

alter table public.recept_bron enable row level security;
create policy "anon read"   on public.recept_bron for select using (true);
create policy "anon insert" on public.recept_bron for insert with check (true);
create policy "anon update" on public.recept_bron for update using (true);
create policy "anon delete" on public.recept_bron for delete using (true);
