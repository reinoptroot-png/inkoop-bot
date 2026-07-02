-- spitskool bio wordt per stuk geprijsd maar in recepten in grammen gebruikt; zonder gram_per_stuk
-- kan de rekenkern 200 g niet omrekenen → recept onoplosbaar. Gebruiker bevestigde ~1000 g per stuk.
update inkoop_prijzen set gram_per_stuk = 1000 where id = '377025fb-08ca-816f-960c-cf246a12eaaa';
