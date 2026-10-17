-- =====================================================================
-- MODUŁY: tylko trzy rodzaje logowania (Opcje -> Moduły)
--
-- Przełączane są teraz wyłącznie: logowanie użytkowników (user_login),
-- portal pracowników (employee_portal) i Zalew (zalew). Moduły wewnątrz systemu
-- (raporty, harmonogram, logi itd.) zależą tylko od uprawnień użytkownika,
-- więc ich wiersze z 10_moduly_i_zalew.sql są usuwane.
--
-- Wymaga wcześniejszego 10_moduly_i_zalew.sql. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

delete from public.app_modules
where key not in ('user_login', 'employee_portal', 'zalew');

insert into public.app_modules (key) values
  ('user_login'), ('employee_portal'), ('zalew')
on conflict (key) do nothing;

notify pgrst, 'reload schema';
