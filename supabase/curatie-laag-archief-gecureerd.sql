-- The Euro Food Monitor — curatie-laag: archief (bron) vs gecureerd (eigen kookboek).
--
-- Koerswijziging (16 juni 2026): de composer importeert niet langer 500+ recepturen om ze
-- allemaal te costen. De volledige set is een READ-ONLY ARCHIEF; je laadt er één uit, maakt 'm
-- met Passard compleet (concept-koppeling, eenheid-kennis, nesting, yield, kost+zekerheid) en
-- keurt 'm goed → dan pas komt-ie in ons EIGEN KOOKBOEK. Alleen het kookboek telt mee in de
-- calculatie.
--
--   gecureerd = false  → ARCHIEF: gespiegeld/geladen, maar NIET meegerekend in de calculatie.
--   gecureerd = true   → EIGEN KOOKBOEK: met Passard compleet + door een mens goedgekeurd.
--
-- Orthogonaal aan status (actief/verborgen/methode): een methode telt sowieso niet mee, los van
-- curatie. De calculatie filtert straks hard op gecureerd=true (stuk C, in de webapp-repo).
--
-- SCHONE LEI: de kolom krijgt default false, dus ALLE bestaande rijen vallen meteen in het
-- archief. Er telt niets mee tot het door de curatie-flow is. (Geen blanket-update hieronder, zodat
-- her-draaien een echte curatie nooit terugzet.)
--
-- Draai dit in de Supabase SQL editor.

alter table public.bereiding
  add column if not exists gecureerd     boolean not null default false,
  add column if not exists gecureerd_op  timestamptz,
  add column if not exists gecureerd_door text;   -- audit: wie keurde goed (marge herleidbaar, vgl. updated_by)

create index if not exists bereiding_gecureerd_idx on public.bereiding (gecureerd);
