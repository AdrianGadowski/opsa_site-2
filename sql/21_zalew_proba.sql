-- =====================================================================
-- ZALEW: próba przylana przy kadzi (tak / nie)
--
-- Dodaje kolumnę proba_przylana w tabeli zalewy (domyślnie: nie).
-- Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

alter table public.zalewy
  add column if not exists proba_przylana boolean not null default false;

notify pgrst, 'reload schema';
