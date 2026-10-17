-- =====================================================================
-- ZALEW W PULPICIE UŻYTKOWNIKÓW
--
-- Pozwala użytkownikom systemu z uprawnieniem "Dashboard" ODCZYTYWAĆ zalewy,
-- żeby pulpit mógł pokazać ich podsumowanie (zmiany I, II, III i ogółem).
-- Zmieniać zalewy nadal mogą tylko osoby zalogowane do Zalewu.
--
-- Wymaga wcześniejszego 14_zalew_zalewy.sql. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

drop policy if exists zalewy_select_dashboard on public.zalewy;
create policy zalewy_select_dashboard on public.zalewy
  for select to authenticated
  using ((select public.app_perm('allow_dashboard')));

create index if not exists zalewy_data_idx on public.zalewy (data_zalewu);

notify pgrst, 'reload schema';
