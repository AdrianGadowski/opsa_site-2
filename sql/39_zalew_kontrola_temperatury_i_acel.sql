-- =====================================================================
-- ZALEW: kontrola temperatury i ACEL bez blokowania starych wpisów
--
-- Reguły z 37 i 38 (ograniczenia CHECK) były sprawdzane przy KAŻDEJ zmianie wiersza -
-- także gdy baza sama zmienia stary zalew, np. przy usuwaniu modelu (model_id -> null).
-- Stare wpisy bez ACEL / temperatury blokowały wtedy usunięcie modelu:
--   new row for relation "zalewy" violates check constraint "zalewy_acel_3_cyfry_check".
--
-- Ten plik usuwa tamte ograniczenia i sprawdza wartości wyzwalaczem, tylko gdy:
--   - zalew jest dodawany,
--   - przy edycji zmienia się temperatura albo ACEL (strona zawsze je wysyła przy zapisie zalewu).
-- Zasady bez zmian: temperatura 1000-9999 °C (4 cyfry), obowiązkowa;
--                   ACEL 0,00-9,99 (dwa miejsca po przecinku), obowiązkowy (strona wpisuje 0,00).
--
-- Można uruchomić ponownie (także gdy 37 i 38 nie były uruchomione).
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

alter table public.zalewy drop constraint if exists zalewy_temperatura_4_cyfry_check;
alter table public.zalewy drop constraint if exists zalewy_acel_3_cyfry_check;

create or replace function public.app_trg_zalewy_validate()
returns trigger
language plpgsql
as $$
begin
  if new.temperatura_metalu is null or new.temperatura_metalu not between 1000 and 9999 then
    raise exception 'Temperatura metalu musi mieć 4 cyfry (1000-9999 °C).';
  end if;
  if new.acel is null or new.acel < 0 or new.acel > 9.99 or new.acel <> round(new.acel, 2) then
    raise exception 'ACEL musi mieć 3 cyfry, np. 4,32 (0,00-9,99).';
  end if;
  return new;
end $$;

-- "update of": przy zmianie innych kolumn (np. model_id po usunięciu modelu) wyzwalacz się nie uruchamia
drop trigger if exists app_zalewy_validate on public.zalewy;
create trigger app_zalewy_validate
  before insert or update of temperatura_metalu, acel on public.zalewy
  for each row execute function public.app_trg_zalewy_validate();

commit;

notify pgrst, 'reload schema';
