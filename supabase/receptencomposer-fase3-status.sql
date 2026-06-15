-- Receptencomposer — Fase 3: status-veld op bereiding.
-- Maakt "verwijderen zonder uit Notion te halen" (soft-delete) en "afwijzen als methode"
-- mogelijk. Notion blijft de bron; dit is puur de zichtbaarheid/classificatie in de composer.
--
--   actief    — normale bereiding, telt mee, kiesbaar in de Calculator (fase 4)
--   verborgen — soft-deleted: uit de lijst, maar Notion-pagina + import blijven intact
--               (de importer raakt status nooit aan, dus een import zet 'm niet terug)
--   methode   — "zuiver een methode, geen bouwsteen": zichtbaar met badge, géén prijs
--               verwacht (geen "prijs onbekend"-ruis), niet kiesbaar als ingrediënt
--
-- Draai dit in de Supabase SQL editor. Bestaande rijen worden 'actief'.

alter table public.bereiding
  add column if not exists status text not null default 'actief';

-- check-constraint los toevoegen (idempotent: eerst droppen als die al bestond)
alter table public.bereiding drop constraint if exists bereiding_status_check;
alter table public.bereiding
  add constraint bereiding_status_check check (status in ('actief','verborgen','methode'));

create index if not exists bereiding_status_idx on public.bereiding (status);
