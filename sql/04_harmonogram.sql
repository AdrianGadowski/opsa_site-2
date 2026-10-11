-- =====================================================================
-- HARMONOGRAM: zapis godzin pracy z uprawnieniem "Harmonogram" (allow_schedule)
--
-- Tabelę employees może zmieniać tylko osoba z uprawnieniem "Baza pracowników".
-- Ta funkcja pozwala osobie z uprawnieniem "Harmonogram" zmienić WYŁĄCZNIE
-- kolumny week_1 ... week_53 - bez dostępu do reszty danych pracownika.
--
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

create or replace function public.app_set_schedule(p_employee_id bigint, p_week integer, p_value text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  if not public.app_perm('allow_schedule') then
    raise exception 'Brak uprawnień do harmonogramu.';
  end if;
  if p_week is null or p_week < 1 or p_week > 53 then
    raise exception 'Nieprawidłowy numer tygodnia: %', p_week;
  end if;

  -- pusta wartość czyści godziny
  execute format('update public.employees set %I = $1 where id = $2', 'week_' || p_week)
    using nullif(btrim(coalesce(p_value, '')), ''), p_employee_id;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'Nie znaleziono pracownika.';
  end if;
end $$;

grant execute on function public.app_set_schedule(bigint, integer, text) to authenticated;
revoke execute on function public.app_set_schedule(bigint, integer, text) from anon;

notify pgrst, 'reload schema';
