-- =====================================================================
-- ZALEW: hasła wyłącznie w Supabase Auth (bez kolumny password)
--
-- Zastępuje mechanizm z 09_zalew.sql, w którym hasło wpisywało się do kolumny
-- password. Teraz tabela zalew_users NIE ma kolumny password - hasło ustawia
-- funkcja app_set_zalew_password (Opcje -> Konta Zalew) i trafia prosto do
-- Supabase Auth, tak jak u użytkowników i pracowników.
--
-- Wymaga wcześniejszych 01, 09 i 10. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

-- 1. Kolumna password nie jest potrzebna (jeśli jeszcze jest - usuń)
alter table public.zalew_users drop column if exists password;

-- 2. Wyzwalacz bez obsługi hasła: pilnuje tylko loginu i adresu konta przy zmianie loginu
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

  if tg_op = 'UPDATE' and new.auth_id is not null and new.login is distinct from old.login then
    v_email := public.app_email('zalew', new.login);
    update auth.users set email = v_email, updated_at = now() where id = new.auth_id;
    update auth.identities
       set identity_data = coalesce(identity_data, '{}'::jsonb) || jsonb_build_object('email', v_email),
           updated_at = now()
     where user_id = new.auth_id and provider = 'email';
  end if;

  return new;
end $$;

-- 3. Ustawienie hasła kontu Zalew (zakłada konto logowania, jeśli go jeszcze nie ma).
--    Wymaga uprawnienia "Opcje". Hasło jest tymczasowe - osoba zmieni je przy logowaniu.
create or replace function public.app_set_zalew_password(p_id bigint, p_password text)
returns void
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_login text;
  v_auth uuid;
begin
  if auth.uid() is null then
    raise exception 'Brak sesji. Zaloguj się ponownie.';
  end if;
  if not public.app_perm('allow_options') then
    raise exception 'Brak uprawnień do kont Zalew.';
  end if;
  if length(coalesce(p_password, '')) < 6 then
    raise exception 'Hasło musi mieć co najmniej 6 znaków.';
  end if;

  select z.login, z.auth_id into v_login, v_auth from public.zalew_users z where z.id = p_id;
  if v_login is null or btrim(v_login) = '' then
    raise exception 'Nie znaleziono konta Zalew.';
  end if;

  v_auth := public.app_internal_upsert_account(public.app_email('zalew', v_login), p_password, v_auth);
  update public.zalew_users set auth_id = v_auth, must_change_password = true where id = p_id;
end $$;

grant execute on function public.app_set_zalew_password(bigint, text) to authenticated;
revoke execute on function public.app_set_zalew_password(bigint, text) from anon;

commit;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- Ustawienie hasła bez strony (np. dla pierwszego konta), w SQL Editor:
--
--   select public.app_internal_upsert_account(
--     public.app_email('zalew', z.login), 'NoweHaslo123', z.auth_id)
--   from public.zalew_users z where z.login = 'admin';
--
--   update public.zalew_users z set auth_id = u.id
--   from auth.users u
--   where z.login = 'admin' and u.email = public.app_email('zalew', z.login);
-- ---------------------------------------------------------------------
