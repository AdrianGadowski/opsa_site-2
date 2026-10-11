-- =====================================================================
-- KROK 3 z 3: USUNIĘCIE JAWNYCH HASEŁ
--
-- Uruchom dopiero po kilku dniach bezproblemowej pracy na nowej wersji.
-- Po tym kroku nie da się już wrócić do starej wersji strony (logowała się
-- hasłami z tych kolumn). Hasła są od kroku 1 w Supabase Auth, w postaci
-- zaszyfrowanej, i tych kolumn nikt już nie używa.
-- =====================================================================

alter table public.users drop column if exists password;
alter table public.employees drop column if exists password;

notify pgrst, 'reload schema';
