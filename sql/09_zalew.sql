-- =====================================================================
-- MODUŁ ZALEW: konta do logowania (zakładka "Zalew" na ekranie logowania)
--
-- Tabela zalew_users ma kolumny login, password, first_name, last_name.
-- Kolumna password służy WYŁĄCZNIE do wpisania hasła: wyzwalacz od razu
-- przenosi je do Supabase Auth (zaszyfrowane) i czyści pole. Hasło nigdy
-- nie zostaje w tabeli jawnym tekstem - tak jak u użytkowników i pracowników.
--
-- Jak dodać osobę: Supabase -> Table Editor -> zalew_users -> Insert row,
-- wpisz login, password (min. 6 znaków), first_name, last_name -> Save.
-- Po zapisie pole password będzie puste - to prawidłowe. Przy pierwszym
-- logowaniu osoba ustawi własne hasło.
-- Zmiana hasła: wpisz nowe w kolumnie password i zapisz (znów zniknie).
-- Usunięcie wiersza usuwa też konto logowania.
--
-- Wymaga wcześniejszego 01_przygotowanie.sql. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

-- 1. Tabela kont
create table if not exists public.zalew_users (
  id bigint generated always as identity primary key,
  login text not null unique,
  password text,
  first_name text,
  last_name text,
  auth_id uuid unique references auth.users (id) on delete set null,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now()
);

comment on column public.zalew_users.password is
  'Tylko do wpisania hasła - wyzwalacz przenosi je do Supabase Auth i czyści to pole.';

alter table public.zalew_users enable row level security;

-- Zalogowana osoba widzi tylko swój wiersz. Zmiany wyłącznie w panelu Supabase.
drop policy if exists zalew_users_select on public.zalew_users;
create policy zalew_users_select on public.zalew_users
  for select to authenticated
  using (auth_id = (select auth.uid()));

-- 2. Adres konta dla nowego rodzaju (ta sama reguła co authEmail w js/app.js)
create or replace function public.app_email(p_kind text, p_login text)
returns text
language sql
immutable
as $$
  select encode(convert_to(btrim(p_login), 'UTF8'), 'hex')
         || case p_kind
              when 'employee' then '@p.opsa.local'
              when 'zalew' then '@z.opsa.local'
              else '@u.opsa.local'
            end
$$;

-- 3. Hasło z kolumny password -> Supabase Auth; zmiana loginu -> zmiana adresu konta
create or replace function public.app_trg_zalew_account()
returns trigger
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_email text;
begin
  if new.login is null or btrim(new.login) = '' then
    raise exception 'Login nie może być pusty.';
  end if;
  new.login := btrim(new.login);
  v_email := public.app_email('zalew', new.login);

  if new.password is not null and btrim(new.password) <> '' then
    if length(new.password) < 6 then
      raise exception 'Hasło musi mieć co najmniej 6 znaków.';
    end if;
    -- zakłada konto albo zmienia hasło (i adres, gdyby zmienił się login)
    new.auth_id := public.app_internal_upsert_account(v_email, new.password, new.auth_id);
    new.must_change_password := true;   -- hasło wpisane przez kogoś innego jest tymczasowe
  elsif tg_op = 'UPDATE' and new.auth_id is not null and new.login is distinct from old.login then
    update auth.users set email = v_email, updated_at = now() where id = new.auth_id;
    update auth.identities
       set identity_data = coalesce(identity_data, '{}'::jsonb) || jsonb_build_object('email', v_email),
           updated_at = now()
     where user_id = new.auth_id and provider = 'email';
  end if;

  new.password := null;   -- nigdy nie zostaje w tabeli
  return new;
end $$;

drop trigger if exists app_zalew_account on public.zalew_users;
create trigger app_zalew_account
  before insert or update on public.zalew_users
  for each row execute function public.app_trg_zalew_account();

-- usunięcie wiersza usuwa konto logowania (funkcja z 01_przygotowanie.sql)
drop trigger if exists app_delete_account on public.zalew_users;
create trigger app_delete_account
  after delete on public.zalew_users
  for each row execute function public.app_trg_delete_account();

-- 4. Zmiana własnego hasła: to samo co w 01_przygotowanie.sql + zdjęcie wymogu zmiany w zalew_users
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
  update public.zalew_users set must_change_password = false where auth_id = v_uid;
end $$;

notify pgrst, 'reload schema';
