-- =====================================================================
-- SŁOWNIKI: dodawanie i usuwanie działów i firm ze strony (Opcje -> Działy / Firmy)
--
-- Po zabezpieczeniu bazy tabele department i business są tylko do odczytu.
-- Ten skrypt pozwala DODAWAĆ i USUWAĆ pozycje osobie z uprawnieniem "Opcje".
-- Zmiana nazw nadal jest możliwa tylko w panelu Supabase.
--
-- Strona nie pozwala usunąć działu ani firmy, do których są przypisani
-- pracownicy, użytkownicy albo wpisy w raportach.
--
-- Skrypt można uruchomić ponownie (także po wcześniejszej wersji bez usuwania).
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

drop policy if exists department_insert on public.department;
create policy department_insert on public.department
  for insert to authenticated
  with check ((select public.app_perm('allow_options')));

drop policy if exists department_delete on public.department;
create policy department_delete on public.department
  for delete to authenticated
  using ((select public.app_perm('allow_options')));

drop policy if exists business_insert on public.business;
create policy business_insert on public.business
  for insert to authenticated
  with check ((select public.app_perm('allow_options')));

drop policy if exists business_delete on public.business;
create policy business_delete on public.business
  for delete to authenticated
  using ((select public.app_perm('allow_options')));

commit;

notify pgrst, 'reload schema';
