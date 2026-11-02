-- =====================================================================
-- TELEFON PRACOWNIKA: przy ustawianiu własnego hasła pracownik może opcjonalnie
-- podać numer telefonu, jeśli nie ma go jeszcze w bazie (kolumna employees.phone_number).
--
-- Pracownik nie ma prawa zmieniać tabeli employees (RLS), dlatego zapis idzie przez funkcję,
-- która pozwala tylko na jedno: wpisać numer SOBIE i tylko wtedy, gdy pole jest puste.
-- Numer już wpisany zmienia dalej osoba z uprawnieniem "Baza pracowników".
-- Ta sama kontrola formatu jest w js/password.js (forcePhoneValid).
--
-- Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

-- Numer z "+" i spacjami zapisze się tylko w kolumnie tekstowej
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'employees' and column_name = 'phone_number'
      and data_type in ('text', 'character varying')
  ) then
    raise exception 'Kolumna employees.phone_number nie istnieje albo nie jest tekstowa. Nic nie zmieniono.';
  end if;
end $$;

-- Zwraca true, gdy numer zapisano; false, gdy pracownik ma już numer
create or replace function public.app_set_own_phone(p_phone text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text := btrim(coalesce(p_phone, ''));
  v_digits int := length(regexp_replace(v_phone, '\D', '', 'g'));
begin
  if auth.uid() is null then
    raise exception 'Brak sesji. Zaloguj się ponownie.';
  end if;
  if v_phone !~ '^\+?[0-9][0-9 -]*$' or v_digits < 9 or v_digits > 15 then
    raise exception 'Nieprawidłowy numer telefonu.';
  end if;

  update public.employees
     set phone_number = v_phone
   where auth_id = auth.uid()
     and btrim(coalesce(phone_number, '')) = '';
  return found;
end $$;

revoke execute on function public.app_set_own_phone(text) from public, anon;
grant execute on function public.app_set_own_phone(text) to authenticated;

commit;

notify pgrst, 'reload schema';
