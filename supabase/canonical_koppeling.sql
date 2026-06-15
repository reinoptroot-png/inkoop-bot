-- Canonical ingredient-koppelingsysteem — het lerende "ingredient-brein".
-- Claude Haiku matcht elk onbekend scan-product tegen de bestaande canonicals
-- (schone restaurantnamen). Dit script voegt de benodigde kolommen en tabellen toe.
--
-- Draai dit eenmalig in de Supabase SQL editor (project viqxafualoybzuycsked).

-- 1) Canonical naam op de gespiegelde inkoop_prijzen. Notion blijft bron van
--    waarheid (kolom "Canonical naam"); dit is de read-cache voor de webapp.
alter table public.inkoop_prijzen add column if not exists canonical_naam text;

-- 2) Confidence log — leergeschiedenis per koppeling, zichtbaar in het detail
--    paneel van het ingredient.
create table if not exists public.koppeling_log (
  id            uuid primary key default gen_random_uuid(),
  scan_naam     text not null,        -- naam zoals de leverancier het noemt
  canonical     text not null,        -- canonical waaraan gekoppeld
  leverancier   text,
  confidence    numeric not null,     -- 0-100, Haiku zekerheid
  haiku_uitleg  text,                 -- één zin uitleg van Haiku
  created_at    timestamptz default now()
);
create index if not exists koppeling_log_canonical_idx on public.koppeling_log (canonical, created_at desc);

-- 3) Lerende koppeling-blacklist — leverancier+scan_naam combinaties die de
--    gebruiker heeft afgewezen (koppeling afgewezen of non-food gemarkeerd).
--    De bot slaat Haiku-matching voor deze combinaties over.
create table if not exists public.koppeling_blacklist (
  id           uuid primary key default gen_random_uuid(),
  leverancier  text not null,
  scan_naam    text not null,
  reden        text,                  -- 'afgewezen' | 'non_food'
  created_at   timestamptz default now(),
  unique (leverancier, scan_naam)
);

-- 4) scan_meldingen: kolom voor de Haiku-uitleg bij koppeling_voorgesteld.
alter table public.scan_meldingen add column if not exists haiku_uitleg text;

-- RLS gelijk aan de overige bot-tabellen: open lezen/schrijven met de anon key.
alter table public.koppeling_log enable row level security;
drop policy if exists "koppeling_log anon all" on public.koppeling_log;
create policy "koppeling_log anon all" on public.koppeling_log
  for all to anon, authenticated using (true) with check (true);

alter table public.koppeling_blacklist enable row level security;
drop policy if exists "koppeling_blacklist anon all" on public.koppeling_blacklist;
create policy "koppeling_blacklist anon all" on public.koppeling_blacklist
  for all to anon, authenticated using (true) with check (true);
