-- =====================================================================
-- SŁOWNIKI: dodawanie i usuwanie działów, firm i ról ze strony (Opcje -> Działy / Firmy / Role)
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

-- ---------------------------------------------------------------------
-- Role (Opcje -> Role): dodawanie i usuwanie z uprawnieniem "Opcje".
-- Roli "Administrator" nie da się usunąć ani dodać drugi raz: po jej nazwie
-- baza i strona rozpoznają administratora.
-- ---------------------------------------------------------------------
begin;

drop policy if exists role_insert on public.role;
create policy role_insert on public.role
  for insert to authenticated
  with check (
    (select public.app_perm('allow_options'))
    and lower(btrim(role)) <> 'administrator'
  );

drop policy if exists role_delete on public.role;
create policy role_delete on public.role
  for delete to authenticated
  using (
    (select public.app_perm('allow_options'))
    and lower(btrim(role)) <> 'administrator'
  );

commit;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Rola "Administrator" jest nietykalna także w samej bazie: żadne żądanie
-- ze strony (nawet z uprawnieniem "Opcje") jej nie usunie, nie zmieni jej
-- nazwy ani nie przemianuje innej roli na "Administrator".
-- Zmiany w panelu Supabase nadal są możliwe.
-- ---------------------------------------------------------------------
create or replace function public.app_trg_protect_admin_role()
returns trigger
language plpgsql
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    -- panel Supabase i funkcje bazy
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op in ('UPDATE', 'DELETE') and lower(btrim(old.role)) = 'administrator' then
    raise exception 'Roli Administrator nie można zmienić ani usunąć.';
  end if;
  if tg_op = 'UPDATE' and lower(btrim(new.role)) = 'administrator' then
    raise exception 'Nazwa Administrator jest zastrzeżona.';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists app_protect_admin_role on public.role;
create trigger app_protect_admin_role
  before update or delete on public.role
  for each row execute function public.app_trg_protect_admin_role();
