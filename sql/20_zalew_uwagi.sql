-- =====================================================================
-- ZALEW: uwagi do zalewu
--
-- Dodaje kolumnę uwagi (tekst, do 500 znaków) w tabeli zalewy.
-- Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

alter table public.zalewy add column if not exists uwagi text;

alter table public.zalewy drop constraint if exists zalewy_uwagi_check;
alter table public.zalewy add constraint zalewy_uwagi_check
  check (uwagi is null or char_length(uwagi) <= 500);

notify pgrst, 'reload schema';
