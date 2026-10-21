-- =====================================================================
-- DZIAŁ RAPORTU (dział mistrza, który utworzył raport)
--
-- work_reports.id_department -> department.id
--   * przy dodaniu wiersza baza sama wpisuje dział autora raportu
--     (users.department_id osoby z add_first_name_id);
--   * osoba dopisana do istniejącego raportu dostaje dział tego raportu,
--     więc cały raport ma zawsze jeden dział;
--   * przy edycji raportu dział się nie zmienia (nie da się go podmienić z zewnątrz);
--   * istniejące raporty dostają dział swojego autora.
--
-- Uwaga: work_reports.department_id to nadal dział PRACOWNIKA w danym wierszu.
--
-- Wymaga wcześniejszego 02_zabezpieczenie.sql. Można uruchomić ponownie.
-- Uruchom w Supabase: SQL Editor -> wklej całość -> Run.
-- =====================================================================

begin;

alter table public.work_reports
  add column if not exists id_department bigint
  references public.department (id) on delete set null;

create index if not exists work_reports_id_department_idx on public.work_reports (id_department);

-- Uzupełnienie istniejących raportów działem autora.
-- Blokada miesięcy wyłączona tylko na czas uzupełniania (zmienia się wyłącznie nowa kolumna).
alter table public.work_reports disable trigger app_block_locked_month;

update public.work_reports w
set id_department = u.department_id
from public.users u
where u.id = w.add_first_name_id
  and w.id_department is null
  and u.department_id is not null;

alter table public.work_reports enable trigger app_block_locked_month;

create or replace function public.app_trg_report_department()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    new.id_department := old.id_department;   -- dział raportu jest stały
    return new;
  end if;

  -- dopisanie do istniejącego raportu: dział tego raportu
  select w.id_department into new.id_department
  from public.work_reports w
  where w.number_report = new.number_report
    and w.id_department is not null
  limit 1;

  -- nowy raport: dział autora (mistrza)
  if new.id_department is null then
    select u.department_id into new.id_department
    from public.users u
    where u.id = new.add_first_name_id;
  end if;

  return new;
end $$;

drop trigger if exists app_report_department on public.work_reports;
create trigger app_report_department
  before insert or update on public.work_reports
  for each row execute function public.app_trg_report_department();

commit;

notify pgrst, 'reload schema';
