-- =====================================================================
-- LOGINY PRACOWNIKÓW: dwie pierwsze litery imienia + dwie pierwsze litery nazwiska
-- (małe litery, bez polskich znaków), np. Jan Kowalski -> jako, Łukasz Żak -> luza.
-- Ta sama reguła jest w js/app.js (funkcja employeeLoginBase).
--
--  * Zmienia login KAŻDEMU pracownikowi (także nieaktywnym). Hasła zostają bez zmian,
--    ale od tej chwili pracownicy logują się NOWYM loginem - trzeba im go przekazać.
--    Pełna lista stary -> nowy pojawia się na końcu jako wynik skryptu.
--  * Zajęty login dostaje kolejny numer: jako, jako2, jako3...
--    Kto ma już właściwy login, zachowuje go; pozostali dostają numery według id.
--  * Adres konta w Supabase Auth zmienia istniejący wyzwalacz app_sync_login (sql/01).
--  * Pracownik bez imienia i nazwiska zachowuje dotychczasowy login.
--  * Stare loginy zostają w tabeli employees_login_backup (cofnięcie - na końcu pliku).
--
-- Wszystko albo nic: przy błędzie baza zostaje bez zmian. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

-- Reguła loginu (funkcje tymczasowe - znikają po zakończeniu sesji)
create or replace function pg_temp.login_plain(p text)
returns text language sql immutable as $$
  select regexp_replace(
    lower(translate(coalesce(p, ''),
      'ĄĆĘŁŃÓŚŹŻąćęłńóśźżÄÖÜäöüÉÈÁÀÍÚÝéèáàíúýČŠŽčšž',
      'ACELNOSZZacelnoszzAOUaouEEAAIUYeeaaiuyCSZcsz')),
    '[^a-z0-9]', '', 'g')
$$;

create or replace function pg_temp.login_base(p_first text, p_last text)
returns text language sql immutable as $$
  select left(pg_temp.login_plain(p_first), 2) || left(pg_temp.login_plain(p_last), 2)
$$;

-- Kopia starych loginów. Bez polityk RLS: dostępna tylko w panelu Supabase, nie ze strony.
create table if not exists public.employees_login_backup (
  employee_id bigint not null,
  old_login text,
  new_login text,
  changed_at timestamptz not null default now()
);
alter table public.employees_login_backup enable row level security;

create temp table _login_plan (
  id bigint primary key,
  old_login text,
  new_login text not null
) on commit drop;

do $$
declare
  r record;
  v_login text;
  v_n int;
begin
  -- bez tego wyzwalacza zmiana loginu odcięłaby pracowników od ich kont
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.employees'::regclass and tgname = 'app_sync_login' and tgenabled <> 'D'
  ) then
    raise exception 'Brak wyzwalacza app_sync_login na tabeli employees (sql/01_przygotowanie.sql). Nic nie zmieniono.';
  end if;

  -- 1. Nowe loginy. Zajęte są też loginy osób, którym ich nie zmieniamy (brak imienia i nazwiska).
  create temp table _login_taken (login text primary key) on commit drop;
  insert into _login_taken
    select distinct lower(btrim(e.login)) from public.employees e
    where pg_temp.login_base(e.first_name, e.last_name) = '' and btrim(coalesce(e.login, '')) <> ''
    on conflict do nothing;

  for r in
    select e.id, e.login, e.auth_id, pg_temp.login_base(e.first_name, e.last_name) as base
    from public.employees e
    where pg_temp.login_base(e.first_name, e.last_name) <> ''
    order by (e.login = pg_temp.login_base(e.first_name, e.last_name)) desc nulls last, e.id
  loop
    v_login := r.base;
    v_n := 1;
    -- wolny = nie ma go inny pracownik ani osierocone konto w Auth (bez pracownika)
    while exists (select 1 from _login_taken t where t.login = v_login)
       or exists (
         select 1 from auth.users u
         where u.email = public.app_email('employee', v_login)
           and u.id is distinct from r.auth_id
           and not exists (select 1 from public.employees e where e.auth_id = u.id)
       )
    loop
      v_n := v_n + 1;
      v_login := r.base || v_n;
    end loop;
    insert into _login_taken values (v_login);
    insert into _login_plan values (r.id, r.login, v_login);
  end loop;

  delete from _login_plan where old_login is not distinct from new_login;

  -- 2. Najpierw loginy tymczasowe, potem docelowe: nowy login jednej osoby bywa
  --    starym loginem innej, a adresy kont w Auth muszą być przez cały czas unikalne
  update public.employees e set login = 'tmp-' || e.id
    from _login_plan p where p.id = e.id;
  update public.employees e set login = p.new_login
    from _login_plan p where p.id = e.id;

  -- 3. Kontrola: każde zmienione konto ma adres zgodny z nowym loginem
  if exists (
    select 1 from _login_plan p
    join public.employees e on e.id = p.id
    join auth.users u on u.id = e.auth_id
    where u.email <> public.app_email('employee', p.new_login)
  ) then
    raise exception 'Adres konta nie zgadza się z nowym loginem. Nic nie zmieniono.';
  end if;

  insert into public.employees_login_backup (employee_id, old_login, new_login)
    select id, old_login, new_login from _login_plan;

  raise notice 'Zmieniono loginów: %', (select count(*) from _login_plan);
end $$;

commit;

-- Lista do przekazania pracownikom
select e.id,
       e.first_name as imie,
       e.last_name as nazwisko,
       b.old_login as stary_login,
       e.login as nowy_login,
       e.auth_id is not null as ma_konto,
       e.active as aktywny
from public.employees e
left join lateral (
  select old_login from public.employees_login_backup k
  where k.employee_id = e.id order by k.changed_at desc limit 1
) b on true
order by e.last_name, e.first_name;

-- ---------------------------------------------------------------------
-- COFNIĘCIE ostatniej zmiany: zaznacz poniższe linie bez "--" i uruchom.
-- ---------------------------------------------------------------------
-- begin;
-- update public.employees e set login = 'tmp-' || e.id
--   from public.employees_login_backup b
--   where b.employee_id = e.id and b.changed_at = (select max(changed_at) from public.employees_login_backup);
-- update public.employees e set login = b.old_login
--   from public.employees_login_backup b
--   where b.employee_id = e.id and b.changed_at = (select max(changed_at) from public.employees_login_backup);
-- delete from public.employees_login_backup
--   where changed_at = (select max(changed_at) from public.employees_login_backup);
-- commit;
