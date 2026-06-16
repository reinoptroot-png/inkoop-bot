-- The Euro Food Monitor — goedkeuring: archief (bron) vs goedgekeurde recepten.
--
-- Koerswijziging (16 juni 2026): de composer importeert niet langer 500+ recepturen om ze
-- allemaal te costen. De volledige set is een READ-ONLY ARCHIEF; je laadt er één uit, maakt 'm
-- met Passard compleet (concept-koppeling, eenheid-kennis, nesting, yield, kost+zekerheid) en
-- keurt 'm goed → dan pas telt-ie mee. Alleen goedgekeurde recepten gaan de calculatie in.
--
--   goedgekeurd = false  → ARCHIEF: gespiegeld/geladen, maar NIET meegerekend in de calculatie.
--   goedgekeurd = true   → met Passard compleet + door een mens goedgekeurd.
--
-- Orthogonaal aan status (actief/verborgen/methode): een methode telt sowieso niet mee, los van
-- goedkeuring. De calculatie filtert hard op goedgekeurd=true (stuk C, webapp-repo).
--
-- SCHONE LEI: de kolom krijgt default false, dus ALLE bestaande rijen vallen meteen in het
-- archief. Er telt niets mee tot het is goedgekeurd. (Geen blanket-update hieronder, zodat
-- her-draaien een echte goedkeuring nooit terugzet.)
--
-- Draai dit in de Supabase SQL editor.

alter table public.bereiding
  add column if not exists goedgekeurd      boolean not null default false,
  add column if not exists goedgekeurd_op   timestamptz,
  add column if not exists goedgekeurd_door text;   -- audit: wie keurde goed (marge herleidbaar, vgl. updated_by)

create index if not exists bereiding_goedgekeurd_idx on public.bereiding (goedgekeurd);
