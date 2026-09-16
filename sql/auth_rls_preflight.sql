-- عبيد | Auth/RLS preflight (READ-ONLY)
-- Run this before applying the Auth migration.
-- It intentionally performs no schema changes.

select table_name, column_name, data_type
from information_schema.columns
where table_schema='public'
  and table_name in ('users','orders','technicians','invoices')
order by table_name, ordinal_position;

select schemaname, tablename, rowsecurity
from pg_tables
where schemaname='public'
  and tablename in ('users','orders','technicians','invoices','notifications','push_subscriptions','complaints','ratings','discount_codes','settings')
order by tablename;

select t.tgname, c.relname as table_name
from pg_trigger t
join pg_class c on c.oid=t.tgrelid
join pg_namespace n on n.oid=c.relnamespace
where not t.tgisinternal
  and n.nspname='public'
  and c.relname in ('orders','invoices','technicians','notifications')
order by c.relname,t.tgname;
