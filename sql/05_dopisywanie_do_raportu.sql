-- =====================================================================
-- DOPISYWANIE DO RAPORTU MISTRZA PRZEZ ADMINISTRATORA
--
-- Administrator w "Rozliczaniu czasu" może dopisać osoby do raportu innej osoby
-- (wiersze dostają autora tamtego raportu). Dotychczasowa polityka pozwalała
-- na to tylko administratorowi z uprawnieniem "Lista raportów"; po tej zmianie
-- wystarcza "Rozliczanie czasu" albo "Lista raportów".
--
-- Zwykły użytkownik nadal może zapisywać raporty tylko na własne nazwisko.
--
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

drop policy if exists work_reports_insert on public.work_reports;

create policy work_reports_insert on public.work_reports
  for insert to authenticated
  with check (
    ((select public.app_perm('allow_time_reporting')) or (select public.app_perm('allow_reports')))
    and (add_first_name_id = (select public.app_user_id()) or (select public.app_is_admin()))
  );

commit;

notify pgrst, 'reload schema';
