-- =====================================================================
-- ZALEW: tabela zalewy - co zalewamy z każdej kadzi (zakładki Lora, HWS, HWS-D, SMS)
--
-- Jeden wiersz = jeden model zalany z jednej kadzi:
--   numer_kadzi, linia, temperatura_metalu, acel, model, ilosc_form.
-- Numer modelu i waga są przepisywane z tabeli modele w chwili zapisu
-- (żeby późniejsza zmiana wagi modelu nie zmieniała starych zalewów),
-- a waga_razem = waga x ilosc_form liczy sama baza.
-- Data zalewu, autor i czas wpisu też ustawia baza.
--
-- Wymaga wcześniejszych 09_zalew.sql i 13_zalew_modele.sql. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

create table if not exists public.zalewy (
  id bigint generated always as identity primary key,
  data_zalewu date not null default ((now() at time zone 'Europe/Warsaw')::date),
  numer_kadzi text not null,
  linia text not null check (linia in ('Lora', 'HWS', 'HWS-D', 'SMS')),
  temperatura_metalu integer,                     -- °C
  acel numeric(10, 3),
  model_id bigint references public.modele (id) on delete set null,
  nr_modelu text,                                 -- kopia z modele
  waga bigint,                                    -- kopia z modele
  ilosc_form integer not null check (ilosc_form > 0),
  waga_razem bigint generated always as (coalesce(waga, 0) * ilosc_form) stored,
  created_at timestamptz not null default now(),
  created_by text,                                -- imię i nazwisko z zalew_users
  created_by_id bigint
);

create index if not exists zalewy_linia_data_idx on public.zalewy (linia, data_zalewu);

-- Numer i waga modelu z tabeli modele; autor i czas wpisu - z sesji
create or replace function public.app_trg_zalewy_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_id bigint;
begin
  if new.model_id is not null and (tg_op = 'INSERT' or new.model_id is distinct from old.model_id) then
    select m.nr_modelu, m.weight into new.nr_modelu, new.waga
    from public.modele m where m.id = new.model_id;
    if not found then
      raise exception 'Nie znaleziono wybranego modelu.';
    end if;
  end if;

  if tg_op = 'INSERT' then
    select z.id, nullif(btrim(coalesce(z.first_name, '') || ' ' || coalesce(z.last_name, '')), '')
      into v_id, v_name
    from public.zalew_users z
    where z.auth_id = auth.uid();
    new.created_by_id := v_id;
    new.created_by := v_name;
    new.created_at := now();
  else
    -- autor i czas pierwszego wpisu się nie zmieniają
    new.created_by_id := old.created_by_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;

  return new;
end $$;

drop trigger if exists app_zalewy_fill on public.zalewy;
create trigger app_zalewy_fill
  before insert or update on public.zalewy
  for each row execute function public.app_trg_zalewy_fill();

-- Dostęp: osoby zalogowane do Zalewu
alter table public.zalewy enable row level security;

drop policy if exists zalewy_select on public.zalewy;
create policy zalewy_select on public.zalewy
  for select to authenticated
  using ((select public.app_zalew_id()) is not null);

drop policy if exists zalewy_insert on public.zalewy;
create policy zalewy_insert on public.zalewy
  for insert to authenticated
  with check ((select public.app_zalew_id()) is not null);

drop policy if exists zalewy_update on public.zalewy;
create policy zalewy_update on public.zalewy
  for update to authenticated
  using ((select public.app_zalew_id()) is not null)
  with check ((select public.app_zalew_id()) is not null);

drop policy if exists zalewy_delete on public.zalewy;
create policy zalewy_delete on public.zalewy
  for delete to authenticated
  using ((select public.app_zalew_id()) is not null);

commit;

notify pgrst, 'reload schema';
