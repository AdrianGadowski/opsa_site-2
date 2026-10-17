-- =====================================================================
-- ZALEW: metal wlany do kadzi (kg)
--
-- Dodaje kolumnę metal_kadz (liczba całkowita, kg) w tabeli zalewy.
-- Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

alter table public.zalewy add column if not exists metal_kadz bigint;

alter table public.zalewy drop constraint if exists zalewy_metal_kadz_check;
alter table public.zalewy add constraint zalewy_metal_kadz_check
  check (metal_kadz is null or metal_kadz >= 0);

notify pgrst, 'reload schema';
