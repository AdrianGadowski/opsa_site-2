-- =====================================================================
-- ZALEW: numer kadzi musi mieć dokładnie 7 cyfr
--
-- Baza odrzuca nowe i zmieniane zalewy z innym numerem kadzi.
-- "not valid": istniejące wpisy z innym numerem zostają, dopóki ktoś ich nie zmieni.
--
-- Wymaga wcześniejszego 14_zalew_zalewy.sql. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

alter table public.zalewy drop constraint if exists zalewy_numer_kadzi_check;
alter table public.zalewy add constraint zalewy_numer_kadzi_check
  check (numer_kadzi ~ '^[0-9]{7}$') not valid;

notify pgrst, 'reload schema';
