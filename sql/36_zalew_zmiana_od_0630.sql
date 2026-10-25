-- =====================================================================
-- ZALEW: zmiana I od 06:30 (zamiast 06:40)
--
-- Przy dodaniu zalewu baza sama wpisuje zmianę i dzień produkcyjny według
-- aktualnej godziny (czas polski) - teraz tak jak w całym systemie:
--   Zmiana I   06:30 - 14:30
--   Zmiana II  14:30 - 22:30
--   Zmiana III 22:30 - 06:30 (po północy nadal dzień, w którym zmiana się zaczęła)
-- Przy edycji zmiana i dzień zostają takie, jakie były.
-- Wpisy zapisane wcześniej (np. o 06:35 jako zmiana III) się nie zmieniają.
--
-- Zastępuje funkcję z 16_zalew_zmiana_automatyczna.sql. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

create or replace function public.app_trg_zalewy_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_id bigint;
  v_local timestamp := now() at time zone 'Europe/Warsaw';
  v_time time := (now() at time zone 'Europe/Warsaw')::time;
begin
  if new.model_id is not null and (tg_op = 'INSERT' or new.model_id is distinct from old.model_id) then
    select m.nr_modelu, m.weight into new.nr_modelu, new.waga
    from public.modele m where m.id = new.model_id;
    if not found then
      raise exception 'Nie znaleziono wybranego modelu.';
    end if;
  end if;

  if tg_op = 'INSERT' then
    -- zmiana według aktualnej godziny
    new.zmiana := case
      when v_time >= time '06:30' and v_time < time '14:30' then 'Zmiana I'
      when v_time >= time '14:30' and v_time < time '22:30' then 'Zmiana II'
      else 'Zmiana III'
    end;
    -- dzień produkcyjny: przed 06:30 trwa jeszcze zmiana III z poprzedniego dnia
    new.data_zalewu := (v_local - interval '6 hours 30 minutes')::date;

    select z.id, nullif(btrim(coalesce(z.first_name, '') || ' ' || coalesce(z.last_name, '')), '')
      into v_id, v_name
    from public.zalew_users z
    where z.auth_id = auth.uid();
    new.created_by_id := v_id;
    new.created_by := v_name;
    new.created_at := now();
  else
    -- zmiana, dzień, autor i czas pierwszego wpisu się nie zmieniają
    new.zmiana := old.zmiana;
    new.data_zalewu := old.data_zalewu;
    new.created_by_id := old.created_by_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;

  return new;
end $$;

notify pgrst, 'reload schema';
