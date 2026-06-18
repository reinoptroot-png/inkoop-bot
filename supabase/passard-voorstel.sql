-- Passard #5: bewaar de twijfel-suggestie op de review-regel, zodat de composer 'm als
-- één-klik "Bevestig" kan tonen i.p.v. de mens opnieuw te laten zoeken.
alter table bereiding_import_review
  add column if not exists voorstel_type  text,     -- 'ingredient' | 'bereiding'
  add column if not exists voorstel_id    uuid,
  add column if not exists voorstel_naam  text,
  add column if not exists voorstel_score numeric;   -- 0..1 Passard-zekerheid (Haiku/lokaal)
