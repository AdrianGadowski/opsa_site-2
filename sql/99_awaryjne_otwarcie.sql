-- =====================================================================
-- AWARYJNIE: cofnięcie kroku 2 (baza znowu otwarta jak przed zabezpieczeniem)
--
-- Użyj tylko wtedy, gdy po kroku 2 nie da się zalogować albo coś ważnego
-- przestało działać. Przywraca stan "każdy z kluczem strony może wszystko",
-- więc traktuj to jako rozwiązanie na chwilę, do czasu naprawy.
--
-- Działa z nową i ze starą wersją strony (stara wymaga, żeby krok 3
-- nie był jeszcze wykonany).
-- =====================================================================

begin;

do $$
declare
  p record;
  t text;
  tables text[] := array[
    'users', 'employees', 'work_reports', 'business', 'department', 'role',
    'Check_version', 'update_list', 'Closed_Periods'
  ];
begin
  for p in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename = any (tables)
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;

  foreach t in array tables loop
    execute format(
      'create policy awaryjne_wszystko on public.%I for all to anon, authenticated using (true) with check (true)', t
    );
  end loop;
end $$;

-- blokada zamkniętego miesiąca w bazie też jest zdejmowana
drop trigger if exists app_block_locked_month on public.work_reports;

commit;

notify pgrst, 'reload schema';
