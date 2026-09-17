-- ============================================================
-- عبيد للصيانة | 2026-09-17 final fixes
-- هذه migration إضافية للتغييرات التي تم تطبيقها على Production.
-- لا تحذف بيانات المستخدمين أو الطلبات أو الفواتير.
-- ============================================================

begin;

-- 1) باركود الفاتورة المجمد
alter table public.invoices add column if not exists payment_barcode_image text;

-- 2) عزل إشعارات الفنيين
alter table public.tech_notifications enable row level security;
drop policy if exists "allow all - temporary" on public.tech_notifications;
drop policy if exists "p_technotif" on public.tech_notifications;
drop policy if exists "tech_notifications_insert" on public.tech_notifications;
drop policy if exists "tech_notifications_select" on public.tech_notifications;
drop policy if exists "tech_notifications_update" on public.tech_notifications;

create policy "tech_notifications_select" on public.tech_notifications
for select to authenticated
using ((select private.my_role()) = 'admin' or tech_id = (select private.my_tech_id()));

create policy "tech_notifications_insert" on public.tech_notifications
for insert to authenticated
with check (
  (select private.my_role()) = 'admin'
  or tech_id = (select private.my_tech_id())
  or exists (
    select 1 from public.orders o
    where o.id = order_id
      and o.user_id = (select private.my_user_id())
      and o.status = 'pending'
      and o.accepted_by_tech is null
  )
);

create policy "tech_notifications_update" on public.tech_notifications
for update to authenticated
using ((select private.my_role()) = 'admin' or tech_id = (select private.my_tech_id()))
with check ((select private.my_role()) = 'admin' or tech_id = (select private.my_tech_id()));

-- 3) تحويل إشعار الطلب الجديد إلى notifications للمستخدم المرتبط بالفني.
-- هذا يعتمد على Trigger الـPush الموجود مسبقاً على public.notifications.
create or replace function public.fanout_tech_notification_to_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id bigint;
begin
  select t.user_ref_id into v_user_id
  from public.technicians t
  where t.id = new.tech_id and t.is_active = true
  limit 1;

  if v_user_id is not null then
    insert into public.notifications (user_id, message, type, related_id, is_read)
    values (v_user_id, new.message, coalesce(new.type,'new_order'), new.order_id, false);
  end if;
  return new;
end;
$$;

revoke all on function public.fanout_tech_notification_to_user() from public;
grant execute on function public.fanout_tech_notification_to_user() to authenticated;

drop trigger if exists trg_fanout_tech_notification on public.tech_notifications;
create trigger trg_fanout_tech_notification
after insert on public.tech_notifications
for each row execute function public.fanout_tech_notification_to_user();

-- 4) العملاء يستطيعون رفع إيصالهم فقط، بدون تغيير بيانات الفاتورة الأساسية.
drop policy if exists "invoices_update_admin_only" on public.invoices;
drop policy if exists "invoices_update_isolated" on public.invoices;
create policy "invoices_update_isolated" on public.invoices
for update to authenticated
using ((select private.my_role()) = 'admin' or customer_id = (select private.my_user_id()))
with check ((select private.my_role()) = 'admin' or customer_id = (select private.my_user_id()));

create or replace function public.prevent_customer_invoice_tamper()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select private.my_role()) = 'admin' then return new; end if;
  if (select private.my_role()) = 'user' then
    if old.customer_id is distinct from new.customer_id
       or old.order_id is distinct from new.order_id
       or old.tech_id is distinct from new.tech_id
       or old.invoice_number is distinct from new.invoice_number
       or old.total is distinct from new.total
       or old.base_price is distinct from new.base_price
       or old.tax is distinct from new.tax
       or old.service is distinct from new.service
       or old.customer_name is distinct from new.customer_name
       or old.customer_email is distinct from new.customer_email
       or old.customer_phone is distinct from new.customer_phone
       or old.payment_barcode_image is distinct from new.payment_barcode_image then
      raise exception 'غير مسموح بتعديل بيانات الفاتورة الأساسية';
    end if;
    if new.status not in ('pending_verification','pending_payment','awaiting_payment','overdue') then
      raise exception 'غير مسموح بتغيير حالة الفاتورة إلى هذه القيمة';
    end if;
    if new.receipt_status not in ('none','pending_verification') then
      raise exception 'غير مسموح بتغيير حالة إيصال الدفع إلى هذه القيمة';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_customer_invoice_tamper on public.invoices;
create trigger trg_prevent_customer_invoice_tamper
before update on public.invoices
for each row execute function public.prevent_customer_invoice_tamper();

-- 5) الفني يعدل سجله هو فقط، والـtrigger يسمح فقط بالباركود وحالة التوفر.
drop policy if exists "technicians_update_admin_only" on public.technicians;
drop policy if exists "technicians_update_admin_or_self" on public.technicians;
create policy "technicians_update_admin_or_self" on public.technicians
for update to authenticated
using ((select private.my_role()) = 'admin' or id = (select private.my_tech_id()))
with check ((select private.my_role()) = 'admin' or id = (select private.my_tech_id()));

create or replace function public.prevent_tech_self_update_overreach()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select private.my_role()) = 'admin' then return new; end if;
  if old.id is distinct from new.id
     or old.name is distinct from new.name
     or old.code is distinct from new.code
     or old.governorate is distinct from new.governorate
     or old.phone is distinct from new.phone
     or old.permissions is distinct from new.permissions
     or old.is_active is distinct from new.is_active
     or old.user_ref_id is distinct from new.user_ref_id
     or old.specialty is distinct from new.specialty
     or old.created_at is distinct from new.created_at
     or old.last_login is distinct from new.last_login then
    raise exception 'الفني غير مسموح له بتعديل هذا الحقل - المسموح فقط: الباركود وحالة التوفر';
  end if;
  return new;
end;
$$;

-- 6) عرض عام آمن للفنيين للحجز فقط، بدون user_ref_id أو permissions أو barcode.
create or replace view public.technicians_public as
select id, name, governorate, is_active, is_available
from public.technicians;
revoke all on public.technicians from anon;
grant select on public.technicians_public to anon, authenticated;

-- 7) إنشاء سجل الفني ذاتياً عبر Auth عند الحاجة.
create or replace function public.ensure_my_technician_row(p_name text, p_phone text)
returns public.technicians
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id bigint;
  v_role text;
  v_row public.technicians;
begin
  select id, role into v_user_id, v_role
  from public.users
  where auth_uid = (select auth.uid())
  limit 1;
  if v_user_id is null or v_role <> 'technician' then
    raise exception 'غير مسموح: هذا الحساب ليس فنياً';
  end if;
  select * into v_row from public.technicians where user_ref_id = v_user_id limit 1;
  if found then return v_row; end if;
  insert into public.technicians (name, code, phone, permissions, is_active, user_ref_id)
  values (coalesce(p_name,'فني'), 'tech_' || v_user_id || '_' || extract(epoch from now())::bigint,
          coalesce(p_phone,''), '{"viewOrders":true,"updateStatus":true,"viewCustomer":false,"allGovernorates":false}'::jsonb,
          true, v_user_id)
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.ensure_my_technician_row(text,text) from public;
grant execute on function public.ensure_my_technician_row(text,text) to authenticated;

-- 8) منع الفني غير النشط من الحصول على my_tech_id.
create or replace function private.my_tech_id()
returns bigint language sql stable security definer set search_path to ''
as $$
  select t.id from public.technicians t
  join public.users u on u.id=t.user_ref_id
  where u.auth_uid=(select auth.uid())
    and coalesce(u.role,'user')='technician'
    and coalesce(t.is_active,true)=true
  limit 1
$$;

commit;
