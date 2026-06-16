-- Canonieke prijs per concept (voorkeur_prijs_id) — keuzes Rein, 16 juni 2026.
-- A (doosprijs fout gelabeld → kies de per-stuk/bos-rij):
--   oesters zeeuwse nr 0 → €0,96/stuk ; peterselie blad → €1,42/bos ; spitskool bio → €2,13/stuk
-- B (beide rijen blijven; rekenen met de /kg-prijs):
--   rozemarijn → €22,67/kg ; framboos → €65,8/kg
-- Zet de voorkeur op het concept van de gekozen rij.

update public.ingredient_concept set voorkeur_prijs_id='37c025fb-08ca-818c-b61d-de7b8f5e59e6'
  where id=(select concept_id from public.inkoop_prijzen where id='37c025fb-08ca-818c-b61d-de7b8f5e59e6');
update public.ingredient_concept set voorkeur_prijs_id='37a025fb-08ca-81a2-af65-d9323979bcc0'
  where id=(select concept_id from public.inkoop_prijzen where id='37a025fb-08ca-81a2-af65-d9323979bcc0');
update public.ingredient_concept set voorkeur_prijs_id='377025fb-08ca-816f-960c-cf246a12eaaa'
  where id=(select concept_id from public.inkoop_prijzen where id='377025fb-08ca-816f-960c-cf246a12eaaa');
update public.ingredient_concept set voorkeur_prijs_id='37e025fb-08ca-8157-a75e-e5a0286fcc11'
  where id=(select concept_id from public.inkoop_prijzen where id='37e025fb-08ca-8157-a75e-e5a0286fcc11');
update public.ingredient_concept set voorkeur_prijs_id='37e025fb-08ca-81e4-9f77-c381ca1c644b'
  where id=(select concept_id from public.inkoop_prijzen where id='37e025fb-08ca-81e4-9f77-c381ca1c644b');
