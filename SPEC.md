# Inkoop bot — onderdeel van het Europizza/Europa-systeem

> **De volledige specificatie is samengevoegd tot één bron van waarheid (15 juni 2026).**
> Deze bot is geen losstaand project meer maar één van drie samenwerkende onderdelen
> (webapp · Notion · inkoop bot). De complete, actuele SPEC — inclusief het canonical-koppeling
> kernprincipe, de bot-filtering/dedup/auto-merge, verkoopdata-import (Lightspeed/Tebi) en de
> roadmap — staat in de **webapp-repo**:
>
> 👉 **`reinoptroot-png/europizza-calculator` → [`SPEC.md`](https://github.com/reinoptroot-png/europizza-calculator/blob/main/SPEC.md)**
>
> Wijzigingen: zie **`CHANGELOG.md`** in dezelfde repo.
> Toekomstige samenvoeging van deze twee code-repo's: zie **`MONOREPO-PLAN.md`** daar.

## Operationeel (deze repo)
- Hoe de bot te draaien (cronjob, scan-commando's, env vars): zie **[README.md](README.md)**.
- Supabase-schema's: `supabase/`.
- Werk je in de SPEC? Bewerk de **canonieke versie in de webapp-repo**, niet dit bestand —
  dit is bewust een stub om drift tussen twee specs te voorkomen.
