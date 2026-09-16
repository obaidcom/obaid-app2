-- ============================================================
-- عبيد | Security hardening v2
-- يعتمد على: sql/real_auth_migration_and_rls.sql
-- ============================================================

-- 1) نسخة ثابتة من باركود الدفع داخل الفاتورة
alter table public.invoices
  add column if not exists payment_barcode_image text;

-- 2) إغلاق جدول admins القديم أمام العميل
alter table public.admins enable row level security;
drop policy if exists "admins_select_admin_only" on public.admins;
create policy "admins_select_admin_only"
on public.admins for select to authenticated
using ((select private.my_role()) = 'admin');

-- 3) notifications: قراءة/تعديل صاحبها فقط أو الأدمن
alter table public.notifications enable row level security;
drop policy if exists "select_notifications" on public.notifications;
drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own"
on public.notifications for select to authenticated
using ((select private.my_role()) = 'admin' or user_id = (select private.my_user_id()));

drop policy if exists "update_notifications" on public.notifications;
drop policy if exists "notifications_update_own" on public.notifications;
create policy "notifications_update_own"
on public.notifications for update to authenticated
using ((select private.my_role()) = 'admin' or user_id = (select private.my_user_id()))
with check ((select private.my_role()) = 'admin' or user_id = (select private.my_user_id()));

-- الإدراج مؤقتاً مفتوح لأن الواجهة الحالية تنشئ إشعارات لمستخدمين آخرين.
drop policy if exists "insert_notifications" on public.notifications;
drop policy if exists "notifications_insert_open" on public.notifications;
create policy "notifications_insert_open"
on public.notifications for insert to authenticated
with check (true);

-- 4) complaints: صاحب الشكوى يقرأ، والأدمن يعدل
alter table public.complaints enable row level security;
drop policy if exists "select_complaints" on public.complaints;
drop policy if exists "complaints_select_isolated" on public.complaints;
create policy "complaints_select_isolated"
on public.complaints for select to authenticated
using ((select private.my_role()) = 'admin' or user_id = (select private.my_user_id()));

drop policy if exists "update_complaints" on public.complaints;
drop policy if exists "complaints_update_admin_only" on public.complaints;
create policy "complaints_update_admin_only"
on public.complaints for update to authenticated
using ((select private.my_role()) = 'admin')
with check ((select private.my_role()) = 'admin');

drop policy if exists "insert_complaints" on public.complaints;
drop policy if exists "complaints_insert_open" on public.complaints;
create policy "complaints_insert_open"
on public.complaints for insert to authenticated
with check (true);

-- 5) ratings: المستخدم يضيف/يعدل تقييمه فقط، والأدمن له الصلاحية
alter table public.ratings enable row level security;
drop policy if exists "insert_ratings" on public.ratings;
drop policy if exists "ratings_insert_own" on public.ratings;
create policy "ratings_insert_own"
on public.ratings for insert to authenticated
with check ((select private.my_role()) = 'admin' or user_id = (select private.my_user_id()));

drop policy if exists "update_ratings" on public.ratings;
drop policy if exists "ratings_update_own_or_admin" on public.ratings;
create policy "ratings_update_own_or_admin"
on public.ratings for update to authenticated
using ((select private.my_role()) = 'admin' or user_id = (select private.my_user_id()))
with check ((select private.my_role()) = 'admin' or user_id = (select private.my_user_id()));

-- 6) discount_codes: الكتابة للأدمن فقط
drop policy if exists "insert_discount_codes" on public.discount_codes;
drop policy if exists "discount_codes_insert_admin" on public.discount_codes;
create policy "discount_codes_insert_admin"
on public.discount_codes for insert to authenticated
with check ((select private.my_role()) = 'admin');

drop policy if exists "update_discount_codes" on public.discount_codes;
drop policy if exists "discount_codes_update_admin" on public.discount_codes;
create policy "discount_codes_update_admin"
on public.discount_codes for update to authenticated
using ((select private.my_role()) = 'admin')
with check ((select private.my_role()) = 'admin');

drop policy if exists "delete_discount_codes" on public.discount_codes;
drop policy if exists "discount_codes_delete_admin" on public.discount_codes;
create policy "discount_codes_delete_admin"
on public.discount_codes for delete to authenticated
using ((select private.my_role()) = 'admin');

-- 7) push_subscriptions: الجهاز الخاص بالمستخدم فقط
alter table public.push_subscriptions enable row level security;
drop policy if exists "select_own_push_subscriptions" on public.push_subscriptions;
drop policy if exists "push_select_own" on public.push_subscriptions;
create policy "push_select_own"
on public.push_subscriptions for select to authenticated
using ((select private.my_role()) = 'admin' or user_id = (select private.my_user_id()));

drop policy if exists "upsert_own_push_subscriptions" on public.push_subscriptions;
drop policy if exists "push_insert_own" on public.push_subscriptions;
create policy "push_insert_own"
on public.push_subscriptions for insert to authenticated
with check ((select private.my_role()) = 'admin' or user_id = (select private.my_user_id()));

drop policy if exists "update_own_push_subscriptions" on public.push_subscriptions;
drop policy if exists "push_update_own" on public.push_subscriptions;
create policy "push_update_own"
on public.push_subscriptions for update to authenticated
using ((select private.my_role()) = 'admin' or user_id = (select private.my_user_id()))
with check ((select private.my_role()) = 'admin' or user_id = (select private.my_user_id()));

-- 8) منع العبث بالحقول الحساسة عند تحديث الطلب/الفاتورة.
-- ملاحظة: يجب أن تكون BEFORE وليست AFTER، لأن AFTER لا يمنع التعديل الذي حدث بالفعل.
create or replace function public.prevent_tech_order_tamper()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select private.my_role()) = 'admin' then
    return new;
  end if;

  if old.user_id is distinct from new.user_id then
    raise exception 'غير مسموح بتغيير صاحب الطلب (user_id)';
  end if;

  if old.tech_id is not null and new.tech_id is distinct from old.tech_id then
    raise exception 'غير مسموح بإعادة تعيين الطلب لفني آخر';
  end if;

  if new.tech_id is not null
     and (select private.my_tech_id()) is not null
     and new.tech_id <> (select private.my_tech_id()) then
    raise exception 'لا يمكنك تعيين هذا الطلب لفني غير نفسك';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_tech_order_tamper on public.orders;
create trigger trg_prevent_tech_order_tamper
before update on public.orders
for each row execute function public.prevent_tech_order_tamper();

create or replace function public.prevent_tech_invoice_tamper()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select private.my_role()) = 'admin' then
    return new;
  end if;

  if old.customer_id is distinct from new.customer_id then
    raise exception 'غير مسموح بتغيير صاحب الفاتورة (customer_id)';
  end if;
  if old.order_id is distinct from new.order_id then
    raise exception 'غير مسموح بتغيير الطلب المرتبط بالفاتورة (order_id)';
  end if;
  if old.tech_id is distinct from new.tech_id then
    raise exception 'غير مسموح بتغيير الفني المرتبط بالفاتورة (tech_id)';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_tech_invoice_tamper on public.invoices;
create trigger trg_prevent_tech_invoice_tamper
before update on public.invoices
for each row execute function public.prevent_tech_invoice_tamper();

-- 9) الفني يستطيع تغيير barcode_image و is_available فقط في سجله.
create or replace function public.prevent_tech_self_update_overreach()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select private.my_role()) = 'admin' then
    return new;
  end if;

  if old.name is distinct from new.name
     or old.code is distinct from new.code
     or old.governorate is distinct from new.governorate
     or old.phone is distinct from new.phone
     or old.permissions is distinct from new.permissions
     or old.is_active is distinct from new.is_active
     or old.user_ref_id is distinct from new.user_ref_id
  then
    raise exception 'الفني غير مسموح له بتعديل هذا الحقل - فقط الباركود وحالة التوفر';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_tech_self_update_overreach on public.technicians;
create trigger trg_prevent_tech_self_update_overreach
before update on public.technicians
for each row execute function public.prevent_tech_self_update_overreach();

-- 10) View عامة محدودة للفنيين.
create or replace view public.technicians_public
with (security_invoker = true)
as
select id, name, governorate, is_active, is_available
from public.technicians;

grant select on public.technicians_public to anon, authenticated;

drop policy if exists "technicians_select_public" on public.technicians;
drop policy if exists "technicians_select_isolated" on public.technicians;
create policy "technicians_select_isolated"
on public.technicians for select to authenticated
using ((select private.my_role()) = 'admin' or id = (select private.my_tech_id()));

-- 11) الدالة الوحيدة المطلوبة للحصول على user_ref_id لفني محدد.
-- لا نمنحها لـ anon حتى لا تكون قاعدة البيانات قابلة للاستعلام قبل تسجيل الدخول.
create or replace function public.get_technician_user_ref(p_tech_id bigint)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_ref_id
  from public.technicians
  where id = p_tech_id;
$$;
revoke all on function public.get_technician_user_ref(bigint) from public;
grant execute on function public.get_technician_user_ref(bigint) to authenticated;

-- 12) إنشاء سجل الفني الحالي فقط إذا كان حساب Auth مربوطاً بدور technician.
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

  select * into v_row
  from public.technicians
  where user_ref_id = v_user_id
  limit 1;
  if found then return v_row; end if;

  insert into public.technicians
    (name, code, phone, permissions, is_active, user_ref_id)
  values
    (coalesce(p_name, 'فني'),
     'tech_' || v_user_id || '_' || extract(epoch from now())::bigint,
     coalesce(p_phone, ''),
     '{"viewOrders":true,"updateStatus":true,"viewCustomer":false,"allGovernorates":false}'::jsonb,
     true,
     v_user_id)
  returning * into v_row;

  return v_row;
end;
$$;
revoke all on function public.ensure_my_technician_row(text,text) from public;
grant execute on function public.ensure_my_technician_row(text,text) to authenticated;

-- لا توجد هنا أي أوامر DROP TABLE أو DROP DATA.
