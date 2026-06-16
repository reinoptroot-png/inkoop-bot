-- Receptencomposer — spoor 3: handmatig gram-per-stuk per ingrediënt (zelflerend).
-- Voor tel-eenheden (bos/bol/blad/teen…) waarvan het gewicht NIET uit de inkoopnaam af te leiden is
-- (geen "circa X gram"). Je vult 't één keer in de composer in → voortaan prijst elke bereiding die
-- dat ingrediënt met die eenheid gebruikt automatisch door.
--
-- Prioriteit in de rekenkern: deze handmatige waarde > "circa X gram" uit de naam.
--
-- Draai dit in de Supabase SQL editor.

alter table public.inkoop_prijzen
  add column if not exists gram_per_stuk numeric;
