-- K-16/M-11 datacorrectie: eenduidige vlees/vis/fruit-rijen stonden op "/g" terwijl de
-- prijs per kg is. Alleen de eenheid corrigeren (g → kg); kostprijs blijft ongewijzigd.
update inkoop_prijzen set eenheid = 'kg'
where id in (
  '37c025fb-08ca-8100-a784-df37b6bbe2f1', -- ny strip €30
  '382025fb-08ca-814a-8655-e53c096ab656', -- sepia bolo €26,22
  '382025fb-08ca-81d2-9723-d817879b161c', -- hollandse garnalen trassi €20
  '382025fb-08ca-815b-b080-da05bf9298cf', -- hollandse garnalen trassi €15
  '382025fb-08ca-8194-8314-f6bababa29c5', -- venkelsalami €17,6
  '382025fb-08ca-8133-bce4-f155a98bf373', -- lomo embuchado €17,6
  '380025fb-08ca-81f7-b054-c970b84928bb', -- verse chorizo €13,44
  '374025fb-08ca-8153-96a0-fea7de1955df'  -- frambozen €4,79
);
