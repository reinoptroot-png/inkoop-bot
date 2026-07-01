-- K-16/M-11: twijfelgevallen (€/g, maar juiste eenheid onzeker) in de review-queue.
-- oordeel 'twijfel' (amber); best-guess voorstel zodat Rein 1-klik kan toepassen of dismissen.
insert into import_review (inkoop_prijs_id, naam, leverancier, kostprijs, eenheid, oordeel, reden, voorstel, bron, status)
select ip.id, ip.naam, ip.leverancier, ip.kostprijs, ip.eenheid,
       'twijfel', v.reden, v.voorstel::jsonb, 'regel', 'open'
from inkoop_prijzen ip
join (values
  ('382025fb-08ca-815b-82d8-eaa93bb1716c', '€/g onwaarschijnlijk — vermoedelijk per kg (of per pot). Bevestig eenheid.', '{"eenheid":"kg"}'),
  ('382025fb-08ca-81aa-a1bf-f5a556f0275e', '€/g onwaarschijnlijk — saus, vermoedelijk per liter. Bevestig eenheid.', '{"eenheid":"liter"}'),
  ('382025fb-08ca-817e-88ef-daf7265d7c3e', '€/g onwaarschijnlijk — saus, vermoedelijk per liter. Bevestig eenheid.', '{"eenheid":"liter"}'),
  ('382025fb-08ca-816c-a33e-fe4c36809e38', '€/g onwaarschijnlijk — sap, vermoedelijk per liter. Bevestig eenheid.', '{"eenheid":"liter"}'),
  ('382025fb-08ca-81c0-b26e-d8479819743a', '€/g onwaarschijnlijk — "blik", vermoedelijk per stuk. Bevestig eenheid.', '{"eenheid":"stuk"}'),
  ('377025fb-08ca-818d-a104-cfa866504988', '€/g onwaarschijnlijk — haring, per kg of per stuk. Bevestig eenheid.', '{"eenheid":"kg"}'),
  ('382025fb-08ca-8181-8a30-c2d6941c7315', '€/g onwaarschijnlijk — augurk, per kg of per pot. Bevestig eenheid.', '{"eenheid":"kg"}'),
  ('382025fb-08ca-8153-99b0-ffeca7e2b2f3', '€/g onwaarschijnlijk — ingelegde peper, per kg of per pot. Bevestig eenheid.', '{"eenheid":"kg"}')
) as v(id, reden, voorstel) on ip.id::text = v.id;
