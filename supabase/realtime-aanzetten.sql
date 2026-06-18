-- Realtime aanzetten: voeg de gedeelde tabellen toe aan de supabase_realtime-publicatie,
-- zodat wijzigingen van collega's live naar alle clients pushen (geen verversknop nodig).
alter publication supabase_realtime add table
  inkoop_prijzen, bereiding, bereiding_component, ingredient_concept,
  concept_eenheid_kennis, menu_status, price_overrides;
