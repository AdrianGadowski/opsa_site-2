-- =====================================================================
-- PLAN ZALEWU: moduł w panelu użytkownika do planowania każdej zmiany
-- (kadzie, metal w kadziach, formy do zalania) dla każdej linii - tabela zalew_cele (sql/40, 41).
--
--  * Uprawnienia (moduł Użytkownicy):
--      allow_pour_plan_view - podgląd planu i realizacji,
--      allow_pour_plan_edit - wpisywanie i zmiana planu (daje też podgląd).
--    Administratorzy dostają oba od razu.
--  * Plan zmiany, która już się skończyła, może zmienić tylko administrator
--    (zmiana I kończy się o 14:30, II o 22:30, III o 06:30 następnego dnia; czas polski).
--  * Podgląd planu widzi też realizację z Zalewu (odczyt tabeli zalewy).
--  * Jeden wpis na linię, dzień i zmianę (zapis ze strony: insert ... on conflict).
--
-- Wymaga wcześniejszych 40_zalew_cele.sql i 41_zalew_cele_dzien_i_zmiana.sql. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

-- 1. Uprawnienia
alter table public.users add column if not exists allow_pour_plan_view boolean not null default false;
alter table public.users add column if not exists allow_pour_plan_edit boolean not null default false;

update public.users u
   set allow_pour_plan_view = true, allow_pour_plan_edit = true
  from public.role r
 where r.id = u.role_id and lower(btrim(r.role)) = 'administrator';

-- 2. Jeden wpis na linię, dzień i zmianę - zwykłe ograniczenie (potrzebne do zapisu "upsert" ze strony)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'zalew_cele_linia_dzien_zmiana_key') then
    alter table public.zalew_cele add constraint zalew_cele_linia_dzien_zmiana_key unique (linia, dzien, zmiana);
  end if;
end $$;

-- 3. Dostęp do planu
drop policy if exists zalew_cele_select on public.zalew_cele;
create policy zalew_cele_select on public.zalew_cele
  for select to authenticated
  using ((select public.app_zalew_id()) is not null or (select public.app_user_id()) is not null);

drop policy if exists zalew_cele_insert on public.zalew_cele;
create policy zalew_cele_insert on public.zalew_cele
  for insert to authenticated
  with check ((select public.app_perm('allow_pour_plan_edit')));

drop policy if exists zalew_cele_update on public.zalew_cele;
create policy zalew_cele_update on public.zalew_cele
  for update to authenticated
  using ((select public.app_perm('allow_pour_plan_edit')))
  with check ((select public.app_perm('allow_pour_plan_edit')));

drop policy if exists zalew_cele_delete on public.zalew_cele;
create policy zalew_cele_delete on public.zalew_cele
  for delete to authenticated
  using ((select public.app_perm('allow_pour_plan_edit')));

-- 4. Realizacja w planie: odczyt zalewów z uprawnieniem do planu
drop policy if exists zalewy_select_plan on public.zalewy;
create policy zalewy_select_plan on public.zalewy
  for select to authenticated
  using ((select public.app_perm('allow_pour_plan_view')) or (select public.app_perm('allow_pour_plan_edit')));

-- 5. Plan zmiany, która już się skończyła - tylko administrator
create or replace function public.app_zalew_shift_ended(p_day date, p_shift text)
returns boolean
language sql
stable
as $$
  select (p_day + case p_shift
            when 'Zmiana I' then time '14:30'
            when 'Zmiana II' then time '22:30'
            else time '06:30' end
          + case when p_shift = 'Zmiana III' then interval '1 day' else interval '0' end)
         <= (now() at time zone 'Europe/Warsaw');
$$;

create or replace function public.app_trg_zalew_cele_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- zmiany robione w panelu Supabase (bez zalogowanego użytkownika strony) przechodzą
  if auth.uid() is null or public.app_is_admin() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op <> 'INSERT' and public.app_zalew_shift_ended(old.dzien, old.zmiana) then
    raise exception 'Zmiana % z dnia % już się skończyła - jej plan może zmienić tylko administrator.', old.zmiana, to_char(old.dzien, 'DD.MM.YYYY');
  end if;
  if tg_op <> 'DELETE' and public.app_zalew_shift_ended(new.dzien, new.zmiana) then
    raise exception 'Zmiana % z dnia % już się skończyła - jej plan może zmienić tylko administrator.', new.zmiana, to_char(new.dzien, 'DD.MM.YYYY');
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists app_zalew_cele_guard on public.zalew_cele;
create trigger app_zalew_cele_guard
  before insert or update or delete on public.zalew_cele
  for each row execute function public.app_trg_zalew_cele_guard();

commit;

notify pgrst, 'reload schema';
