-- Alias-gaten dichten (net als zout): recept-namen die niet fuzzy matchen op de DB-naam.
-- "eiwit" → dgh vloeibaar eiwit scharrel; "fijnzout" (aan elkaar) → fijn zout.
update inkoop_prijzen set aliassen = 'eiwit'
  where id = '374025fb-08ca-8162-8c62-e837e326aa7b' and coalesce(aliassen,'') = '';
update inkoop_prijzen set aliassen = 'zout, keukenzout, fijnzout'
  where id = '374025fb-08ca-8120-9ea8-cb7c82b50ac2';
