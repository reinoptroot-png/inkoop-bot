-- Receptencomposer — Fase 1: datamodel voor gedeelde bereidingen (sauzen, bases,
-- bouillons, deeg) met canonical-koppeling, locatie-varianten, nesting en een
-- kostprijs-cache. Sluit aan op het bestaande canonical-patroon (canonical_koppeling.sql)
-- en op inkoop_prijzen (de Notion->Supabase mirror van de Scan Bot).
--
-- Notion = bron van waarheid voor de invoer (ingrediententabel per bereiding).
-- Supabase = opslag + rekencache. De rekensom draait in code (webapp), niet hier.
--
-- Draai dit eenmalig in de Supabase SQL editor (project viqxafualoybzuycsked).

-- ---------------------------------------------------------------------------
-- 1) Canonical bereiding — de schone, locatie-onafhankelijke naam.
--    Zelfde idee als canonical_naam bij ingredienten: één naam, meerdere varianten.
-- ---------------------------------------------------------------------------
create table if not exists public.canonical_bereiding (
  id             uuid primary key default gen_random_uuid(),
  canonical_naam text not null unique,                 -- bv. "tomatensaus"
  output_eenheid text not null check (output_eenheid in ('gram','ml','stuks')),
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- 2) Bereiding — een locatie-variant van een canonical bereiding, met eigen
--    componenten en eigen gemeten eind-yield.
-- ---------------------------------------------------------------------------
create table if not exists public.bereiding (
  id                  uuid primary key default gen_random_uuid(),
  canonical_id        uuid not null references public.canonical_bereiding(id) on delete restrict,
  locatie             text not null check (locatie in ('europizza','europa')),
  notion_page_id      text unique,            -- stabiele sleutel voor sync/idempotentie (fase 2)
  eind_yield          numeric,                -- GEMETEN eindopbrengst in output_eenheid; null = incompleet
  batch_basis         numeric,                -- gedefinieerde batchgrootte (alleen display-anker, raakt prijs/eenheid NOOIT)
  is_private          boolean not null default false,   -- "Deel 1/Deel 2": private sub-bereiding (TODO/BESLIS, zie DECISIONS.md)
  parent_bereiding_id uuid references public.bereiding(id) on delete set null,
  gram_per_stuk       numeric,                -- optioneel conversie-anker stuks<->gram (TODO/BESLIS, nog niet afgedwongen)
  dichtheid_g_per_ml  numeric,                -- optioneel conversie-anker ml<->gram (TODO/BESLIS, nog niet afgedwongen)
  is_incompleet       boolean not null default true,    -- gezet door de rekenkern (geen yield of onopgeloste component)
  updated_by          text,                   -- audit: wie bewerkte als laatste (margeverschuiving herleidbaar)
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  unique (canonical_id, locatie)
);
create index if not exists bereiding_canonical_idx on public.bereiding (canonical_id);
create index if not exists bereiding_parent_idx on public.bereiding (parent_bereiding_id);

-- ---------------------------------------------------------------------------
-- 3) Bereiding-component — óf een ingrediënt, óf een geneste bereiding (XOR).
--    ingredient_id verwijst naar inkoop_prijzen.id (= Notion page-id, TEXT) —
--    er is bewust geen aparte canonical_ingredient-tabel; dat is de bestaande mirror.
-- ---------------------------------------------------------------------------
create table if not exists public.bereiding_component (
  id               uuid primary key default gen_random_uuid(),
  bereiding_id     uuid not null references public.bereiding(id) on delete cascade,
  ingredient_id    text references public.inkoop_prijzen(id) on delete restrict,  -- Notion page-id van het ingredient
  sub_bereiding_id uuid references public.bereiding(id) on delete restrict,
  hoeveelheid      numeric not null,
  eenheid          text not null,             -- genormaliseerd naar de eenheid waarin de bron geprijsd is (g / stuks / ml)
  created_at       timestamptz default now(),
  -- XOR: precies één van beide gevuld
  constraint bereiding_component_xor
    check ( (ingredient_id is not null) <> (sub_bereiding_id is not null) )
);
create index if not exists bereiding_component_bereiding_idx on public.bereiding_component (bereiding_id);
create index if not exists bereiding_component_sub_idx on public.bereiding_component (sub_bereiding_id);

-- ---------------------------------------------------------------------------
-- 4) Cycle-preventie — weiger een component die (transitief) een lus zou sluiten
--    (A->B->A). De rekenkern heeft daarnaast nog een eigen guard.
-- ---------------------------------------------------------------------------
create or replace function public.check_bereiding_cyclus()
returns trigger language plpgsql as $$
declare
  v_cyclus boolean;
begin
  if new.sub_bereiding_id is null then
    return new;
  end if;
  if new.sub_bereiding_id = new.bereiding_id then
    raise exception 'Cyclus geweigerd: een bereiding kan zichzelf niet als component hebben (%).', new.bereiding_id;
  end if;
  -- Kan sub_bereiding_id via zijn eigen componenten terug naar bereiding_id?
  with recursive afh as (
    select sub_bereiding_id as id
      from public.bereiding_component
     where bereiding_id = new.sub_bereiding_id and sub_bereiding_id is not null
    union
    select bc.sub_bereiding_id
      from public.bereiding_component bc
      join afh on bc.bereiding_id = afh.id
     where bc.sub_bereiding_id is not null
  )
  select exists (select 1 from afh where id = new.bereiding_id) into v_cyclus;
  if v_cyclus then
    raise exception 'Cyclus geweigerd: % zit (transitief) al in % .', new.bereiding_id, new.sub_bereiding_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_bereiding_cyclus on public.bereiding_component;
create trigger trg_bereiding_cyclus
  before insert or update on public.bereiding_component
  for each row execute function public.check_bereiding_cyclus();

-- ---------------------------------------------------------------------------
-- 5) Kostprijs-cache — resultaat van de rekenkern (current-only, geen historie).
--    null = incompleet (geen yield of onopgeloste component) — NOOIT 0.
-- ---------------------------------------------------------------------------
create table if not exists public.bereiding_kostprijs (
  bereiding_id      uuid primary key references public.bereiding(id) on delete cascade,
  batch_totaal_kost numeric,            -- null als (een component) onopgelost is
  prijs_per_eenheid numeric,            -- null als incompleet (geen yield of onopgelost)
  berekend_op       timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- RLS — gelijk aan de overige tabellen: open lezen/schrijven met de anon key.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['canonical_bereiding','bereiding','bereiding_component','bereiding_kostprijs']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "%s anon all" on public.%I;', t, t);
    execute format('create policy "%s anon all" on public.%I for all to anon, authenticated using (true) with check (true);', t, t);
  end loop;
end $$;
