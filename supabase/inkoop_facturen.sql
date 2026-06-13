-- inkoop_facturen — één rij per leveranciersfactuur met het totaalbedrag.
-- Voedt de /inkoop-grafiek in de calculator: echte ingekochte euro's per dag
-- i.p.v. de prijs-index. De Euro Scan Bot upsert hierin op factuurnr, zodat
-- herhaalde scans van dezelfde factuur niet dubbel invoegen.
--
-- Draai dit eenmalig in de Supabase SQL editor (project viqxafualoybzuycsked).

create table if not exists public.inkoop_facturen (
  factuurnr      text primary key,            -- uniek; upsert-sleutel
  leverancier    text,
  factuurdatum   date,
  totaalbedrag   numeric,                      -- in valuta hieronder
  btw_inclusief  boolean default false,        -- true = totaalbedrag is incl. btw, false = excl. (netto)
  aantal_regels  integer,
  valuta         text default 'EUR',
  aangemaakt_op  timestamptz default now()
);

create index if not exists inkoop_facturen_datum_idx on public.inkoop_facturen (factuurdatum);

-- RLS gelijk aan de overige bot-tabellen: open lezen/schrijven met de anon key
-- (de bot en de calculator gebruiken beide de anon key).
alter table public.inkoop_facturen enable row level security;

drop policy if exists "inkoop_facturen anon all" on public.inkoop_facturen;
create policy "inkoop_facturen anon all" on public.inkoop_facturen
  for all to anon, authenticated using (true) with check (true);
