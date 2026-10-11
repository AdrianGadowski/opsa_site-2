-- =====================================================================
-- OCHRONA KONT ADMINISTRATORÓW
--
-- Strona nie pokazuje kont administratorów w module "Użytkownicy".
-- Ten skrypt wymusza to samo w bazie - żadne żądanie ze strony
-- (nawet od osoby z uprawnieniem "Użytkownicy") nie może:
--   - usunąć ani zmienić konta administratora,
--   - nadać komuś roli Administrator,
--   - ustawić administratorowi hasła.
--
-- Co nadal działa:
--   - administrator zmienia własne hasło w "Moje konto",
--   - wszystko można zmienić ręcznie w panelu Supabase (Table Editor / SQL Editor).
--
-- Nowego administratora tworzy się tak: załóż zwykłego użytkownika na stronie
-- (z hasłem), a potem w panelu Supabase zmień mu role_id na rolę Administrator.
--
-- Wymaga wcześniejszego 01_przygotowanie.sql. Można uruchomić ponownie.
-- =====================================================================

-- Czy rola o podanym id to "Administrator"
create or replace function public.app_role_is_admin(p_role_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.role r
    where r.id = p_role_id and lower(btrim(r.role)) = 'administrator'
  )
$$;

-- Wyzwalacz celowo NIE jest "security definer": current_user musi pokazywać,
-- kto naprawdę wykonuje zmianę (strona = anon/authenticated, panel i funkcje bazy = inne role).
create or replace function public.app_trg_protect_admin_user()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op in ('UPDATE', 'DELETE') and public.app_role_is_admin(old.role_id) then
      raise exception 'Konta administratora nie można zmienić ani usunąć ze strony.';
    end if;
    if tg_op in ('INSERT', 'UPDATE') and public.app_role_is_admin(new.role_id) then
      raise exception 'Roli Administrator nie można nadać ze strony.';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

drop trigger if exists app_protect_admin_user on public.users;
create trigger app_protect_admin_user
  before insert or update or delete on public.users
  for each row execute function public.app_trg_protect_admin_user();

-- Ustawianie hasła: to samo co w 01_przygotowanie.sql, z jedną różnicą -
-- cudzego konta administratora nie da się ruszyć.
create or replace function public.app_set_password(p_kind text, p_id bigint, p_password text)
returns void
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_login text;
  v_auth uuid;
  v_role bigint;
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
    select u.login, u.auth_id, u.role_id into v_login, v_auth, v_role from public.users u where u.id = p_id;
    if v_login is null or btrim(v_login) = '' then
      raise exception 'Nie znaleziono użytkownika albo nie ma on loginu.';
    end if;
    v_own := v_auth is not null and v_auth = auth.uid();
    if public.app_role_is_admin(v_role) and not v_own then
      raise exception 'Hasła administratora nie można ustawić ze strony.';
    end if;
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

notify pgrst, 'reload schema';
