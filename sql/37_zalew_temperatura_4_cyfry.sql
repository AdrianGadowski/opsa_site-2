-- !!! ZASTĄPIONE przez 39_zalew_kontrola_temperatury_i_acel.sql - NIE URUCHAMIAJ.
-- !!! To ograniczenie blokowało usuwanie modeli (stare zalewy bez ACEL / temperatury).
-- =====================================================================
-- ZALEW: temperatura metalu zawsze 4 cyfry (1000-9999 °C) i obowiązkowa
--
-- Dotyczy nowych wpisów i edycji. Wpisy zapisane wcześniej (np. bez temperatury)
-- zostają, ale przy ich edycji trzeba już podać poprawną temperaturę.
--
-- Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

alter table public.zalewy drop constraint if exists zalewy_temperatura_4_cyfry_check;
alter table public.zalewy add constraint zalewy_temperatura_4_cyfry_check
  check (temperatura_metalu is not null and temperatura_metalu between 1000 and 9999) not valid;

notify pgrst, 'reload schema';
