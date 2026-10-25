-- =====================================================================
-- ZALEW: formy dobre i formy zabrakowane
--
-- ilosc_form       - formy dobre (jak dotąd; waga_razem = waga x formy dobre),
-- ilosc_form_brak  - formy zabrakowane (nowa kolumna, domyślnie 0; nie wlicza się do wagi).
-- Formy dobre mogą być 0 (wszystkie zabrakowane), ale wpis musi mieć choć jedną formę.
--
-- Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

alter table public.zalewy add column if not exists ilosc_form_brak integer not null default 0;

alter table public.zalewy drop constraint if exists zalewy_ilosc_form_check;
alter table public.zalewy add constraint zalewy_ilosc_form_check check (ilosc_form >= 0);

alter table public.zalewy drop constraint if exists zalewy_ilosc_form_brak_check;
alter table public.zalewy add constraint zalewy_ilosc_form_brak_check check (ilosc_form_brak >= 0);

alter table public.zalewy drop constraint if exists zalewy_formy_razem_check;
alter table public.zalewy add constraint zalewy_formy_razem_check check (ilosc_form + ilosc_form_brak > 0);

notify pgrst, 'reload schema';
