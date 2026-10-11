-- =====================================================================
-- KROK 2 z 3: ZABEZPIECZENIE BAZY
--
-- UWAGA: po tym kroku stara wersja strony przestaje działać, a bez zalogowania
-- baza nie oddaje niczego (poza numerem wersji na ekranie logowania).
-- Uruchom dopiero, gdy nowa wersja strony jest opublikowana i sprawdziłeś,
-- że logowanie użytkownika i pracownika działa po kroku 1.
--
-- Co robi:
--   - usuwa WSZYSTKIE dotychczasowe polityki na tabelach systemu (także tymczasowe),
--   - włącza RLS i zakłada właściwe polityki,
--   - dodaje w bazie blokadę zmian w zamkniętym miesiącu.
--
-- Całość jest jedną transakcją: przy błędzie nic się nie zmienia.
-- =====================================================================

begin;

-- Zabezpieczenie przed zamknięciem sobie dostępu
do $$
begin
  if not exists (
    select 1
    from public.users u
    join public.role r on r.id = u.role_id
    where lower(r.role) = 'administrator' and u.auth_id is not null
  ) then
    raise exception 'Żaden administrator nie ma konta logowania (auth_id). Najpierw uruchom 01_przygotowanie.sql i sprawdź logowanie w nowej wersji strony.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Czyste konto: usuń wszystkie stare polityki i włącz RLS
-- ---------------------------------------------------------------------
do $$
declare
  p record;
  t text;
  tables text[] := array[
    'users', 'employees', 'work_reports', 'business', 'department', 'role',
    'Check_version', 'update_list', 'Closed_Periods'
  ];
begin
  for p in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename = any (tables)
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;

  foreach t in array tables loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2. Użytkownicy systemu
--    Czytać może każdy zalogowany użytkownik systemu (nazwiska w raportach),
--    zmieniać tylko osoba z uprawnieniem "Użytkownicy". Pracownicy nie widzą tej tabeli.
-- ---------------------------------------------------------------------
create policy users_select on public.users
  for select to authenticated
  using ((select public.app_user_id()) is not null);

create policy users_insert on public.users
  for insert to authenticated
  with check ((select public.app_perm('allow_users')));

create policy users_update on public.users
  for update to authenticated
  using ((select public.app_perm('allow_users')))
  with check ((select public.app_perm('allow_users')));

create policy users_delete on public.users
  for delete to authenticated
  using ((select public.app_perm('allow_users')));

-- ---------------------------------------------------------------------
-- 3. Pracownicy
--    Użytkownicy systemu widzą wszystkich; pracownik widzi tylko siebie.
--    Zmienia tylko osoba z uprawnieniem "Baza pracowników".
-- ---------------------------------------------------------------------
create policy employees_select on public.employees
  for select to authenticated
  using ((select public.app_user_id()) is not null or auth_id = (select auth.uid()));

create policy employees_insert on public.employees
  for insert to authenticated
  with check ((select public.app_perm('allow_employees')));

create policy employees_update on public.employees
  for update to authenticated
  using ((select public.app_perm('allow_employees')))
  with check ((select public.app_perm('allow_employees')));

create policy employees_delete on public.employees
  for delete to authenticated
  using ((select public.app_perm('allow_employees')));

-- ---------------------------------------------------------------------
-- 4. Raporty czasu pracy
--    Odczyt: użytkownicy systemu wszystko, pracownik tylko swoje godziny.
--    Tworzenie: uprawnienie "Rozliczanie czasu" i raport na własne nazwisko,
--               albo "Lista raportów" przy dodawaniu pracownika do raportu (autor lub administrator).
--    Edycja i usuwanie: tylko autor raportu albo administrator.
-- ---------------------------------------------------------------------
create policy work_reports_select on public.work_reports
  for select to authenticated
  using (
    (select public.app_user_id()) is not null
    or first_name_id = (select public.app_employee_id())
  );

create policy work_reports_insert on public.work_reports
  for insert to authenticated
  with check (
    ((select public.app_perm('allow_time_reporting')) and add_first_name_id = (select public.app_user_id()))
    or (
      (select public.app_perm('allow_reports'))
      and (add_first_name_id = (select public.app_user_id()) or (select public.app_is_admin()))
    )
  );

create policy work_reports_update on public.work_reports
  for update to authenticated
  using (
    ((select public.app_perm('allow_reports')) or (select public.app_perm('allow_time_reporting')))
    and (add_first_name_id = (select public.app_user_id()) or (select public.app_is_admin()))
  )
  with check (
    ((select public.app_perm('allow_reports')) or (select public.app_perm('allow_time_reporting')))
    and (add_first_name_id = (select public.app_user_id()) or (select public.app_is_admin()))
  );

create policy work_reports_delete on public.work_reports
  for delete to authenticated
  using (
    ((select public.app_perm('allow_reports')) or (select public.app_perm('allow_time_reporting')))
    and (add_first_name_id = (select public.app_user_id()) or (select public.app_is_admin()))
  );

-- ---------------------------------------------------------------------
-- 5. Słowniki: firmy, działy, role - tylko odczyt dla zalogowanych
--    (zmiany wyłącznie w panelu Supabase)
-- ---------------------------------------------------------------------
create policy business_select on public.business
  for select to authenticated using (true);
create policy department_select on public.department
  for select to authenticated using (true);
create policy role_select on public.role
  for select to authenticated using (true);

-- ---------------------------------------------------------------------
-- 6. Wersja systemu: odczyt także przed zalogowaniem (ekran logowania),
--    zmiana z uprawnieniem "Aktualizacje"
-- ---------------------------------------------------------------------
create policy check_version_select on public."Check_version"
  for select to anon, authenticated using (true);

create policy check_version_insert on public."Check_version"
  for insert to authenticated
  with check ((select public.app_perm('allow_updates')));

create policy check_version_update on public."Check_version"
  for update to authenticated
  using ((select public.app_perm('allow_updates')))
  with check ((select public.app_perm('allow_updates')));

create policy check_version_delete on public."Check_version"
  for delete to authenticated
  using ((select public.app_perm('allow_updates')));

-- ---------------------------------------------------------------------
-- 7. Lista zmian (Aktualizacje)
-- ---------------------------------------------------------------------
create policy update_list_select on public.update_list
  for select to authenticated
  using ((select public.app_user_id()) is not null);

create policy update_list_insert on public.update_list
  for insert to authenticated
  with check ((select public.app_perm('allow_updates')));

create policy update_list_update on public.update_list
  for update to authenticated
  using ((select public.app_perm('allow_updates')))
  with check ((select public.app_perm('allow_updates')));

create policy update_list_delete on public.update_list
  for delete to authenticated
  using ((select public.app_perm('allow_updates')));

-- ---------------------------------------------------------------------
-- 8. Blokady miesięcy: odczyt dla każdego zalogowanego (także pracownika),
--    zmiana z uprawnieniem "Opcje"
-- ---------------------------------------------------------------------
create policy closed_periods_select on public."Closed_Periods"
  for select to authenticated using (true);

create policy closed_periods_insert on public."Closed_Periods"
  for insert to authenticated
  with check ((select public.app_perm('allow_options')));

create policy closed_periods_update on public."Closed_Periods"
  for update to authenticated
  using ((select public.app_perm('allow_options')))
  with check ((select public.app_perm('allow_options')));

create policy closed_periods_delete on public."Closed_Periods"
  for delete to authenticated
  using ((select public.app_perm('allow_options')));

-- ---------------------------------------------------------------------
-- 9. Zamknięty miesiąc: baza sama odrzuca tworzenie, edycję i usuwanie raportów
--    (report_date ma postać dd.mm.rrrr, year_month ma postać rrrr-mm)
-- ---------------------------------------------------------------------
create or replace function public.app_trg_block_locked_month()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  d text;
begin
  -- przy edycji sprawdzany jest i dotychczasowy, i nowy miesiąc raportu
  foreach d in array array[
    case when tg_op <> 'INSERT' then old.report_date end,
    case when tg_op <> 'DELETE' then new.report_date end
  ] loop
    if d is not null and exists (
      select 1 from public."Closed_Periods"
      where is_locked and year_month = substr(d, 7, 4) || '-' || substr(d, 4, 2)
    ) then
      raise exception 'Miesiąc % jest zablokowany. Raportów nie można tworzyć, edytować ani usuwać.', substr(d, 4, 7);
    end if;
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

drop trigger if exists work_reports_locked_month on public.work_reports;
drop trigger if exists app_block_locked_month on public.work_reports;
create trigger app_block_locked_month
  before insert or update or delete on public.work_reports
  for each row execute function public.app_trg_block_locked_month();

commit;

notify pgrst, 'reload schema';
