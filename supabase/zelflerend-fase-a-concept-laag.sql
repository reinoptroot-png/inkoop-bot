-- Euro Food Monitor — Fase A: canonieke kennis-laag (zie ROADMAP-zelflerend-systeem.md).
--
-- Tot nu hangen feiten (alias, gram_per_stuk, prijs) PER inkooprij. Dubbele rijen van
-- hetzelfde concept (20 gevonden, o.a. peterselie/oesters/zwarte knoflook) arbitreren dan
-- niet en pakken stil de verkeerde prijs. Deze laag introduceert één canoniek
-- ingredient-concept waar de feiten aan hangen, plus een kennis-tabel
-- (concept × eenheid → gram) die generaliseert ("1 bol knoflook = 60 g" als gedeeld feit).
--
-- Bewust GEEN aanpassing aan de Notion->Supabase mirror-kolommen: concept_id is een
-- Supabase-only kolom. De bot-upsert raakt 'm niet (upsert update alleen aangeleverde
-- kolommen). canonical_naam blijft de bron van waarheid voor de grouping.
--
-- Draai dit eenmalig in de Supabase SQL editor (project viqxafualoybzuycsked).

-- ---------------------------------------------------------------------------
-- 1) ingredient_concept — het canonieke concept. Eén rij per schone naam.
--    Feiten die over het concept gaan (niet over een specifieke inkooprij) hangen hier.
-- ---------------------------------------------------------------------------
create table if not exists public.ingredient_concept (
  id                 uuid primary key default gen_random_uuid(),
  canonical_naam     text not null unique,                 -- schone, lowercase naam (= grouping-sleutel)
  categorie          text,
  dichtheid_g_per_ml numeric,                               -- optioneel: verfijnt de ml≈g default per concept
  voorkeur_prijs_id  text references public.inkoop_prijzen(id) on delete set null, -- handmatig gekozen "waarheid"-rij; null = auto-arbitrage op genormaliseerde €/basis
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- 2) Koppeling inkooprij -> concept. Supabase-only (Notion kent dit niet).
--    Meerdere inkoop_prijzen-rijen (leveranciers/varianten) onder één concept.
-- ---------------------------------------------------------------------------
alter table public.inkoop_prijzen
  add column if not exists concept_id uuid references public.ingredient_concept(id) on delete set null;
create index if not exists inkoop_prijzen_concept_idx on public.inkoop_prijzen (concept_id);

-- ---------------------------------------------------------------------------
-- 3) concept_eenheid_kennis — (concept × eenheid -> gram), met confidence + bron.
--    Generaliseert gram_per_stuk: "1 bol knoflook = 60 g" wordt één gedeeld feit,
--    overal hergebruikt. Fase B seedt dit met wereldkennis (bron 'llm'); de mens
--    bevestigt (bron 'mens', hoogste trust).
-- ---------------------------------------------------------------------------
create table if not exists public.concept_eenheid_kennis (
  id               uuid primary key default gen_random_uuid(),
  concept_id       uuid not null references public.ingredient_concept(id) on delete cascade,
  eenheid          text not null,                          -- 'bol','teen','bos','blad','stuk','el'…
  gram_per_eenheid numeric not null check (gram_per_eenheid > 0),
  confidence       numeric,                                -- 0-100
  bron             text not null default 'mens'
                     check (bron in ('mens','llm','inkoopnaam','afgeleid')),
  toelichting      text,
  updated_by       text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  unique (concept_id, eenheid)
);
create index if not exists concept_eenheid_kennis_concept_idx on public.concept_eenheid_kennis (concept_id);

-- ---------------------------------------------------------------------------
-- 4) Backfill — pure SQL, idempotent.
-- ---------------------------------------------------------------------------
-- 4a) Eén concept per distinct schone naam (canonical_naam, val terug op naam).
insert into public.ingredient_concept (canonical_naam, categorie)
select lower(trim(coalesce(nullif(canonical_naam,''), naam))) as cn,
       (array_agg(categorie order by laatste_update desc nulls last))[1]
  from public.inkoop_prijzen
 where coalesce(nullif(canonical_naam,''), naam) is not null
 group by 1
on conflict (canonical_naam) do nothing;

-- 4b) Koppel elke inkooprij aan zijn concept.
update public.inkoop_prijzen p
   set concept_id = c.id
  from public.ingredient_concept c
 where c.canonical_naam = lower(trim(coalesce(nullif(p.canonical_naam,''), p.naam)))
   and (p.concept_id is distinct from c.id);

-- 4c) Bestaande handmatige gram_per_stuk (spoor 3) -> kennis-tabel als eenheid 'stuk'.
--     bron 'mens' want het was met de hand ingevuld in de composer.
insert into public.concept_eenheid_kennis (concept_id, eenheid, gram_per_eenheid, confidence, bron, toelichting)
select p.concept_id, 'stuk', p.gram_per_stuk, 95, 'mens', 'overgenomen uit inkoop_prijzen.gram_per_stuk (spoor 3)'
  from public.inkoop_prijzen p
 where p.gram_per_stuk is not null and p.gram_per_stuk > 0 and p.concept_id is not null
on conflict (concept_id, eenheid) do nothing;

-- ---------------------------------------------------------------------------
-- 5) RLS — gelijk aan de overige tabellen: open lezen/schrijven met de anon key.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['ingredient_concept','concept_eenheid_kennis']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "%s anon all" on public.%I;', t, t);
    execute format('create policy "%s anon all" on public.%I for all to anon, authenticated using (true) with check (true);', t, t);
  end loop;
end $$;
