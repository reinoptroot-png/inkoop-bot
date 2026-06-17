-- Backlog-fix (17 juni 2026): "winterpeen gangbaar" hoort NIET in ajo rojo saus.
-- Geverifieerd tegen de Notion-bron: de echte regel is "gele biet gaar 600 gr" (Deel 2),
-- die de importer verkeerd matchte aan "winterpeen gangbaar, kist 5kg." (beide 600 gr).
-- Verwijder de foute component. De juiste regel (gele biet) kan via de composer opnieuw gekoppeld.
delete from bereiding_component where id = 'aeec796e-4548-4c89-87d9-08300d6dc33c';
