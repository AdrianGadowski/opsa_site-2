-- =====================================================================
-- KROK 1 z 3: PRZYGOTOWANIE (nic nie psuje - stara wersja strony działa dalej)
--
-- Co robi:
--   1. dodaje kolumny auth_id i must_change_password do users i employees,
--   2. zakłada konta w Supabase Auth dla obecnych użytkowników i pracowników
--      (z ich dotychczasowych haseł),
--   3. tworzy funkcje i wyzwalacze używane przez nową wersję strony,
--   4. dodaje TYMCZASOWE polityki dla zalogowanych, żeby nowa wersja strony
--      działała jeszcze przed krokiem 2.
--
-- Skrypt można bezpiecznie uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 1. Kolumny
-- ---------------------------------------------------------------------
alter table public.users
  add column if not exists auth_id uuid unique references auth.users (id) on delete set null;
alter table public.employees
  add column if not exists auth_id uuid unique references auth.users (id) on delete set null;

do $$
begin
  -- Obecni użytkownicy mają już własne hasła: jeśli kolumna dopiero powstaje, nie wymuszaj u nich zmiany.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'must_change_password'
  ) then
    alter table public.users add column must_change_password boolean not null default true;
    update public.users set must_change_password = false;
  end if;

  -- Pracownicy mają wspólne hasło startowe: zmiana przy pierwszym logowaniu zostaje wymuszona.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'employees' and column_name = 'must_change_password'
  ) then
    alter table public.employees add column must_change_password boolean not null default true;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Funkcje pomocnicze
-- ---------------------------------------------------------------------

-- Sztuczny adres e-mail konta: login zapisany szesnastkowo + końcówka.
-- Ta sama reguła jest w js/app.js (funkcja authEmail).
create or replace function public.app_email(p_kind text, p_login text)
returns text
language sql
immutable
as $$
  select encode(convert_to(btrim(p_login), 'UTF8'), 'hex')
         || case when p_kind = 'employee' then '@p.opsa.local' else '@u.opsa.local' end
$$;

-- Zakłada konto w Supabase Auth albo zmienia hasło i adres istniejącego.
-- Tylko do użytku wewnątrz innych funkcji - nie da się jej wywołać ze strony.
create or replace function public.app_internal_upsert_account(p_email text, p_password text, p_auth_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_id uuid := p_auth_id;
  v_hash text := extensions.crypt(p_password, extensions.gen_salt('bf', 10));
begin
  if v_id is not null and exists (select 1 from auth.users where id = v_id) then
    update auth.users
       set encrypted_password = v_hash, email = p_email, updated_at = now()
     where id = v_id;
    update auth.identities
       set identity_data = coalesce(identity_data, '{}'::jsonb) || jsonb_build_object('email', p_email),
           updated_at = now()
     where user_id = v_id and provider = 'email';
    return v_id;
  end if;

  v_id := gen_random_uuid();

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change, email_change_token_new
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', p_email, v_hash, now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
    '', '', '', ''
  );

  insert into auth.identities (
    id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), v_id, v_id::text, 'email',
    jsonb_build_object('sub', v_id::text, 'email', p_email, 'email_verified', true, 'phone_verified', false),
    now(), now(), now()
  );

  return v_id;
end $$;

revoke execute on function public.app_internal_upsert_account(text, text, uuid) from public, anon, authenticated;

-- Kim jest zalogowana osoba (używane w politykach i funkcjach poniżej)
create or replace function public.app_user_id()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select u.id::bigint from public.users u where u.auth_id = auth.uid() limit 1
$$;

create or replace function public.app_employee_id()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select e.id::bigint from public.employees e where e.auth_id = auth.uid() and e.active is true limit 1
$$;

create or replace function public.app_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.users u
    join public.role r on r.id = u.role_id
    where u.auth_id = auth.uid() and lower(r.role) = 'administrator'
  )
$$;

-- Czy zalogowany użytkownik ma uprawnienie, np. app_perm('allow_reports')
create or replace function public.app_perm(p text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select (to_jsonb(u) ->> p)::boolean from public.users u where u.auth_id = auth.uid() limit 1),
    false
  )
$$;

-- ---------------------------------------------------------------------
-- 3. Funkcje wywoływane ze strony
-- ---------------------------------------------------------------------

-- Ustawienie hasła komuś (moduł Użytkownicy / Baza pracowników).
-- Zakłada konto, jeśli go jeszcze nie ma. Hasło jest tymczasowe: wymusza zmianę
-- przy logowaniu, chyba że ktoś ustawia hasło samemu sobie.
create or replace function public.app_set_password(p_kind text, p_id bigint, p_password text)
returns void
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_login text;
  v_auth uuid;
  v_own boolean;
begin
  if auth.uid() is null then
    raise exception 'Brak sesji. Zaloguj się ponownie.';
  end if;
  if length(coalesce(p_password, '')) < 6 then
    raise exception 'Hasło musi mieć co najmniej 6 znaków.';
  end if;

  if p_kind = 'user' then
    if not public.app_perm('allow_users') then
      raise exception 'Brak uprawnień do zarządzania użytkownikami.';
    end if;
    select u.login, u.auth_id into v_login, v_auth from public.users u where u.id = p_id;
    if v_login is null or btrim(v_login) = '' then
      raise exception 'Nie znaleziono użytkownika albo nie ma on loginu.';
    end if;
    v_own := v_auth is not null and v_auth = auth.uid();
    v_auth := public.app_internal_upsert_account(public.app_email('user', v_login), p_password, v_auth);
    update public.users set auth_id = v_auth, must_change_password = not v_own where id = p_id;

  elsif p_kind = 'employee' then
    if not public.app_perm('allow_employees') then
      raise exception 'Brak uprawnień do zarządzania pracownikami.';
    end if;
    select e.login, e.auth_id into v_login, v_auth from public.employees e where e.id = p_id;
    if v_login is null or btrim(v_login) = '' then
      raise exception 'Nie znaleziono pracownika albo nie ma on loginu.';
    end if;
    v_auth := public.app_internal_upsert_account(public.app_email('employee', v_login), p_password, v_auth);
    update public.employees set auth_id = v_auth, must_change_password = true where id = p_id;

  else
    raise exception 'Nieznany rodzaj konta: %', p_kind;
  end if;
end $$;

-- Zmiana własnego hasła (Moje konto oraz wymuszona zmiana po zalogowaniu).
create or replace function public.app_change_own_password(p_current text, p_new text)
returns void
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_hash text;
begin
  if v_uid is null then
    raise exception 'Brak sesji. Zaloguj się ponownie.';
  end if;
  if length(coalesce(p_new, '')) < 6 then
    raise exception 'Hasło musi mieć co najmniej 6 znaków.';
  end if;

  select encrypted_password into v_hash from auth.users where id = v_uid;
  if v_hash is null or v_hash <> extensions.crypt(coalesce(p_current, ''), v_hash) then
    raise exception 'Obecne hasło jest nieprawidłowe.';
  end if;
  if p_new = p_current then
    raise exception 'Nowe hasło musi być inne niż obecne.';
  end if;

  update auth.users
     set encrypted_password = extensions.crypt(p_new, extensions.gen_salt('bf', 10)), updated_at = now()
   where id = v_uid;
  update public.users set must_change_password = false where auth_id = v_uid;
  update public.employees set must_change_password = false where auth_id = v_uid;
end $$;

grant execute on function public.app_set_password(text, bigint, text) to authenticated;
grant execute on function public.app_change_own_password(text, text) to authenticated;
revoke execute on function public.app_set_password(text, bigint, text) from anon;
revoke execute on function public.app_change_own_password(text, text) from anon;

-- ---------------------------------------------------------------------
-- 4. Wyzwalacze na users i employees
-- ---------------------------------------------------------------------

-- Powiązania z kontem (auth_id) nie da się ustawić ani zmienić ze strony - robią to tylko funkcje bazy.
create or replace function public.app_trg_protect_auth_id()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.auth_id := null;
    else
      new.auth_id := old.auth_id;
    end if;
  end if;
  return new;
end $$;

-- Zmiana loginu zmienia adres konta, żeby logowanie nowym loginem działało.
create or replace function public.app_trg_sync_login()
returns trigger
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_email text;
begin
  if new.auth_id is not null and new.login is not null and btrim(new.login) <> ''
     and new.login is distinct from old.login then
    v_email := public.app_email(tg_argv[0], new.login);
    update auth.users set email = v_email, updated_at = now() where id = new.auth_id;
    update auth.identities
       set identity_data = coalesce(identity_data, '{}'::jsonb) || jsonb_build_object('email', v_email),
           updated_at = now()
     where user_id = new.auth_id and provider = 'email';
  end if;
  return new;
end $$;

-- Usunięcie użytkownika lub pracownika usuwa też jego konto logowania.
create or replace function public.app_trg_delete_account()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if old.auth_id is not null then
    delete from auth.users where id = old.auth_id;
  end if;
  return old;
end $$;

drop trigger if exists app_protect_auth_id on public.users;
create trigger app_protect_auth_id before insert or update on public.users
  for each row execute function public.app_trg_protect_auth_id();
drop trigger if exists app_protect_auth_id on public.employees;
create trigger app_protect_auth_id before insert or update on public.employees
  for each row execute function public.app_trg_protect_auth_id();

drop trigger if exists app_sync_login on public.users;
create trigger app_sync_login after update of login on public.users
  for each row execute function public.app_trg_sync_login('user');
drop trigger if exists app_sync_login on public.employees;
create trigger app_sync_login after update of login on public.employees
  for each row execute function public.app_trg_sync_login('employee');

drop trigger if exists app_delete_account on public.users;
create trigger app_delete_account after delete on public.users
  for each row execute function public.app_trg_delete_account();
drop trigger if exists app_delete_account on public.employees;
create trigger app_delete_account after delete on public.employees
  for each row execute function public.app_trg_delete_account();

-- ---------------------------------------------------------------------
-- 5. Konta dla obecnych użytkowników i pracowników (z dotychczasowych haseł)
-- ---------------------------------------------------------------------
do $$
declare
  r record;
  v_email text;
begin
  for r in
    select id, login, password from public.users
    where auth_id is null and login is not null and btrim(login) <> ''
      and password is not null and password <> ''
  loop
    v_email := public.app_email('user', r.login);
    if exists (select 1 from auth.users where email = v_email) then
      raise notice 'Pominięto użytkownika % (id %): konto o tym loginie już istnieje', r.login, r.id;
      continue;
    end if;
    update public.users
       set auth_id = public.app_internal_upsert_account(v_email, r.password, null)
     where id = r.id;
  end loop;

  for r in
    select id, login, password from public.employees
    where auth_id is null and login is not null and btrim(login) <> ''
      and password is not null and password <> ''
  loop
    v_email := public.app_email('employee', r.login);
    if exists (select 1 from auth.users where email = v_email) then
      raise notice 'Pominięto pracownika % (id %): konto o tym loginie już istnieje', r.login, r.id;
      continue;
    end if;
    update public.employees
       set auth_id = public.app_internal_upsert_account(v_email, r.password, null)
     where id = r.id;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 6. TYMCZASOWE polityki dla zalogowanych (krok 2 zastąpi je właściwymi)
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'users', 'employees', 'work_reports', 'business', 'department', 'role',
    'Check_version', 'update_list', 'Closed_Periods'
  ] loop
    execute format('drop policy if exists tmp_authenticated_all on public.%I', t);
    execute format(
      'create policy tmp_authenticated_all on public.%I for all to authenticated using (true) with check (true)', t
    );
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 7. Kontrola: kto ma konto logowania (ma_konto = true)
--    Osoby z false nie zalogują się w nowej wersji, dopóki ktoś nie ustawi im hasła.
-- ---------------------------------------------------------------------
select 'użytkownik' as rodzaj, login, (auth_id is not null) as ma_konto, must_change_password as wymusza_zmiane
from public.users
union all
select 'pracownik', login, (auth_id is not null), must_change_password
from public.employees
order by 1, 2;
