-- !!! ZASTĄPIONE przez 39_zalew_kontrola_temperatury_i_acel.sql - NIE URUCHAMIAJ.
-- !!! To ograniczenie blokowało usuwanie modeli (stare zalewy bez ACEL / temperatury).
-- =====================================================================
-- ZALEW: ACEL zawsze 3 cyfry (0,00-9,99); strona zapisuje 0,00, gdy pole zostanie puste
--
-- Dotyczy nowych wpisów i edycji. Wpisy zapisane wcześniej (np. bez ACEL albo
-- z inną liczbą cyfr) zostają, ale przy ich edycji trzeba już podać poprawny ACEL.
--
-- Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

alter table public.zalewy drop constraint if exists zalewy_acel_3_cyfry_check;
alter table public.zalewy add constraint zalewy_acel_3_cyfry_check
  check (acel is not null and acel >= 0 and acel <= 9.99 and acel = round(acel, 2)) not valid;

notify pgrst, 'reload schema';
