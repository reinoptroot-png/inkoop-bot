-- Scan-wachter (bewakingsagent facturen/pakbonnen-pijplijn) — zie wachter.js + WACHTER.md.
-- Gaten-inbox: idempotent ge-upsert op gap_id. Status 'genegeerd' wordt door een MENS gezet
-- (dashboard) en mag door de wachter nooit terug naar 'open' worden gezet.
create table if not exists scan_wachter_gaten (
  gap_id            text primary key,          -- sha256(message_id|bijlage_index|type) — deterministisch
  cyclus_id         text not null,
  message_id        text,                      -- null bij machine-/pijplijngaten (bv. scan niet gedraaid)
  type              text not null check (type in ('missend','parse_mislukt','mogelijk_duplicaat','connectiviteit','hangend','onderbreking_gedetecteerd')),
  ernst             text not null check (ernst in ('laag','midden','hoog')),
  status            text not null default 'open' check (status in ('open','opgelost','genegeerd')),
  eerste_detectie   timestamptz not null,
  laatst_gezien     timestamptz not null,
  retry_teller      integer not null default 0,
  bron_verwijzing   text,                      -- mailbox/folder + Message-ID zodat een mens het origineel vindt
  bewijs            text,                      -- concrete logregel / queryresultaat (bewijsplicht)
  details           text,
  voorgestelde_actie text,
  domein            text                       -- detectie-domein; alleen gaten uit een dit-cyclus-geslaagd domein worden auto-opgelost
);
create index if not exists scan_wachter_gaten_status_idx on scan_wachter_gaten (status, ernst, laatst_gezien);

-- Cyclus-logboek: interne spiegel van de heartbeat. Een extern systeem (healthchecks.io of een
-- cron op andere hardware) bewaakt het UITBLIJVEN van de ping; deze tabel maakt de laatste
-- heartbeat daarnaast queryable voor het dashboard.
create table if not exists scan_wachter_cycli (
  cyclus_id     text primary key,
  gestart       timestamptz not null,
  klaar         timestamptz,
  machine       text,
  is_scanmachine boolean,
  gaten_open    integer,
  heartbeat_ok  boolean,
  samenvatting  jsonb
);
create index if not exists scan_wachter_cycli_gestart_idx on scan_wachter_cycli (gestart desc);
