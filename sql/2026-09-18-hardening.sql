-- عبيد للصيانة | 2026-09-18 hardening
-- Idempotent production hardening already applied to the connected Supabase project.

begin;

alter table public.technicians add column if not exists barcode_hash text;
create unique index if not exists technicians_barcode_hash_uidx
  on public.technicians(barcode_hash) where barcode_hash is not null;

alter table public.users add column if not exists auth_uid uuid;
create unique index if not exists users_auth_uid_uidx
  on public.users(auth_uid) where auth_uid is not null;

-- Notifications are server-created; clients may only read/update their own records.
alter table public.notifications enable row level security;
drop policy if exists notifications_insert_open on public.notifications;
drop policy if exists insert_notifications on public.notifications;
drop policy if exists notifications_insert_admin on public.notifications;
create policy notifications_insert_admin on public.notifications
for insert to authenticated
with check ((select private.my_role()) = 'admin');

-- Technician notification isolation.
alter table public.tech_notifications enable row level security;
drop policy if exists tech_notifications_select on public.tech_notifications;
create policy tech_notifications_select on public.tech_notifications
for select to authenticated
using ((select private.my_role()) = 'admin' or tech_id = (select private.my_tech_id()));

commit;
