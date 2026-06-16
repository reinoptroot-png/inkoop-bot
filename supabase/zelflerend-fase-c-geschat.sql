-- Euro Food Monitor — Fase C: markeer of een berekende bereidingsprijs 'geschat' is.
-- geschat = true zodra een component leunt op een schatting (llm-kennis, gewicht-uit-naam,
-- of een vaste el/tl-benadering). De rekenkern zet dit; de UI toont een "≈ geschat"-badge.
-- Draai dit in de Supabase SQL editor; daarna een keer de compute-run (Recepten → herbereken).

alter table public.bereiding_kostprijs add column if not exists geschat boolean;
