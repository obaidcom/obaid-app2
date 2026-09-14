-- ============================================================
-- عبيد | Real Supabase Auth + RLS security migration
-- ============================================================
-- IMPORTANT:
-- 1) Supabase Dashboard > Authentication > Providers > Email
--    إذا كان التطبيق لا يملك شاشة لتأكيد البريد، اجعل Confirm email = OFF.
-- 2) خذ نسخة احتياطية قبل التنفيذ على قاعدة الإنتاج.
-- 3) هذا الملف لا يغيّر واجهة التطبيق؛ وظيفته ربط الهوية الحقيقية
--    من Supabase Auth مع users/technicians وتأمين الطلبات والفواتير.
--
-- ملاحظة مهمة:
-- تسجيل الدخول القديم للفني باستخدام كود مشترك لا يمكن اعتباره هوية آمنة.
-- يجب أن يكون حساب الفني الحقيقي مرتبطاً بـ users.auth_uid حتى تعمل سياسات RLS.
-- ============================================================

begin;

-- ============================================================
-- 1) ربط users مع Supabase Auth
-- ============================================================
alter table public.users
  add column if not exists auth_uid uuid unique;

create index if not exists users_auth_uid_idx
  on public.users (auth_uid);

create index if not exists technicians_user_ref_id_idx
  on public.technicians (user_ref_id);

create index if not exists orders_user_id_idx
  on public.orders (user_id);

create index if not exists orders_tech_id_idx
  on public.orders (tech_id);

create index if not exists orders_pending_assignment_idx
  on public.orders (status, accepted_by_tech)
  where accepted_by_tech is null;

create index if not exists invoices_customer_id_idx
  on public.invoices (customer_id);

create index if not exists invoices_tech_id_idx
  on public.invoices (tech_id);

-- ============================================================
-- 2) دوال الهوية الآمنة
-- ============================================================
create schema if not exists private;

create or replace function private.my_user_id()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select u.id
  from public.users as u
  where u.auth_uid = (select auth.uid())
  limit 1;
$$;

create or replace function private.my_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(u.role, 'user')
  from public.users as u
  where u.auth_uid = (select auth.uid())
  limit 1;
$$;

create or replace function private.my_tech_id()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select t.id
  from public.technicians as t
  join public.users as u on u.id = t.user_ref_id
  where u.auth_uid = (select auth.uid())
    and coalesce(u.role, 'user') = 'technician'
  limit 1;
$$;

revoke all on function private.my_user_id() from public;
revoke all on function private.my_role() from public;
revoke all on function private.my_tech_id() from public;

grant execute on function private.my_user_id() to authenticated;
grant execute on function private.my_role() to authenticated;
grant execute on function private.my_tech_id() to authenticated;

grant usage on schema private to authenticated;

-- ============================================================
-- 3) USERS
-- ============================================================
alter table public.users enable row level security;

 drop policy if exists "users_select_isolated" on public.users;
 drop policy if exists "users_insert_public" on public.users;
 drop policy if exists "users_update_own" on public.users;
 drop policy if exists "users_delete_admin" on public.users;

create policy "users_select_isolated"
on public.users
for select
to authenticated
using (
  (select private.my_role()) = 'admin'
  or auth_uid = (select auth.uid())
  or id in (
    select o.user_id
    from public.orders as o
    where o.tech_id = (select private.my_tech_id())
  )
);

-- يسمح للمستخدم الجديد بإنشاء صفه فقط بعد وجود Auth session.
-- لا يسمح للعميل بإنشاء admin/technician من خلال INSERT.
create policy "users_insert_self"
on public.users
for insert
to authenticated
with check (
  auth_uid = (select auth.uid())
  and coalesce(role, 'user') = 'user'
);

create policy "users_update_own"
on public.users
for update
to authenticated
using (
  (select private.my_role()) = 'admin'
  or auth_uid = (select auth.uid())
)
with check (
  (select private.my_role()) = 'admin'
  or (
    auth_uid = (select auth.uid())
    and coalesce(role, 'user') = 'user'
  )
);

create policy "users_delete_admin"
on public.users
for delete
to authenticated
using ((select private.my_role()) = 'admin');

-- ============================================================
-- 4) ORDERS
-- ============================================================
alter table public.orders enable row level security;

drop policy if exists "orders_select_isolated" on public.orders;
drop policy if exists "orders_insert_own" on public.orders;
drop policy if exists "orders_update_isolated" on public.orders;
drop policy if exists "orders_delete_admin" on public.orders;

create policy "orders_select_isolated"
on public.orders
for select
to authenticated
using (
  (select private.my_role()) = 'admin'
  or user_id = (select private.my_user_id())
  or tech_id = (select private.my_tech_id())
  or (
    status = 'pending'
    and accepted_by_tech is null
    and (select private.my_tech_id()) is not null
  )
);

create policy "orders_insert_own"
on public.orders
for insert
to authenticated
with check (
  (select private.my_role()) = 'admin'
  or user_id = (select private.my_user_id())
);

-- لا نعطي الفني UPDATE مفتوحاً على الطلب.
-- قبول الطلب وتعيين الفني يتم عبر RPC آمنة بالأسفل.
create policy "orders_update_admin_or_owner"
on public.orders
for update
to authenticated
using (
  (select private.my_role()) = 'admin'
  or user_id = (select private.my_user_id())
)
with check (
  (select private.my_role()) = 'admin'
  or user_id = (select private.my_user_id())
);

create policy "orders_delete_admin"
on public.orders
for delete
to authenticated
using ((select private.my_role()) = 'admin');

-- ============================================================
-- 5) قبول الطلب من الفني بشكل ذري وآمن
-- ============================================================
create or replace function private.accept_order(p_order_id bigint)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tech_id bigint;
  v_order public.orders;
begin
  if (select auth.uid()) is null then
    raise exception 'يجب تسجيل الدخول أولاً';
  end if;

  v_tech_id := (select private.my_tech_id());

  if v_tech_id is null then
    raise exception 'الحساب الحالي ليس حساب فني صالحاً';
  end if;

  update public.orders
     set accepted_by_tech = v_tech_id,
         tech_id = v_tech_id,
         status = case
                    when status = 'pending' then 'تم قبول الطلب'
                    else status
                  end,
         tech_accepted_at = now()
   where id = p_order_id
     and status = 'pending'
     and accepted_by_tech is null
     and tech_id is null
  returning * into v_order;

  if not found then
    raise exception 'الطلب غير متاح أو تم قبوله من فني آخر';
  end if;

  return v_order;
end;
$$;

revoke all on function private.accept_order(bigint) from public;
grant execute on function private.accept_order(bigint) to authenticated;

-- ============================================================
-- 6) TECHNICIANS
-- ============================================================
alter table public.technicians enable row level security;

drop policy if exists "technicians_select_public" on public.technicians;
drop policy if exists "technicians_update_isolated" on public.technicians;
drop policy if exists "technicians_insert_admin" on public.technicians;
drop policy if exists "technicians_delete_admin" on public.technicians;

-- القراءة العامة هنا متوافقة مع التطبيق الحالي، لكن يفضّل لاحقاً
-- إنشاء public technician profile view لا يحتوي الحقول الحساسة.
create policy "technicians_select_authenticated"
on public.technicians
for select
to authenticated
using (true);

-- الفني يستطيع تعديل بياناته التشغيلية فقط عبر UPDATE إذا كانت صلاحيات
-- الأعمدة في Postgres تسمح بذلك؛ لا نعطيه صلاحية عامة على سجل الفني.
-- التحديث الإداري يبقى متاحاً للإدمن.
create policy "technicians_update_admin_only"
on public.technicians
for update
to authenticated
using ((select private.my_role()) = 'admin')
with check ((select private.my_role()) = 'admin');

create policy "technicians_insert_admin"
on public.technicians
for insert
to authenticated
with check ((select private.my_role()) = 'admin');

create policy "technicians_delete_admin"
on public.technicians
for delete
to authenticated
using ((select private.my_role()) = 'admin');

-- ============================================================
-- 7) INVOICES
-- ============================================================
alter table public.invoices enable row level security;

drop policy if exists "invoices_select_isolated" on public.invoices;
drop policy if exists "invoices_insert_isolated" on public.invoices;
drop policy if exists "invoices_update_isolated" on public.invoices;
drop policy if exists "invoices_delete_admin" on public.invoices;

create policy "invoices_select_isolated"
on public.invoices
for select
to authenticated
using (
  (select private.my_role()) = 'admin'
  or customer_id = (select private.my_user_id())
  or tech_id = (select private.my_tech_id())
);

create policy "invoices_insert_admin_or_own_tech"
on public.invoices
for insert
to authenticated
with check (
  (select private.my_role()) = 'admin'
  or tech_id = (select private.my_tech_id())
);

-- الفني لا يملك UPDATE مفتوحاً على الفاتورة؛ يمنع تغيير المبلغ/الباركود
-- أو ربط الفاتورة بفني/عميل آخر من خلال Data API.
create policy "invoices_update_admin_only"
on public.invoices
for update
to authenticated
using ((select private.my_role()) = 'admin')
with check ((select private.my_role()) = 'admin');

create policy "invoices_delete_admin"
on public.invoices
for delete
to authenticated
using ((select private.my_role()) = 'admin');

-- ============================================================
-- 8) ملاحظة مهمة جداً حول صلاحيات PostgreSQL
-- ============================================================
-- RLS لا يلغي GRANT. يجب أن تكون صلاحيات authenticated متوافقة مع هذه
-- السياسات، وألا يتم منح anon صلاحيات كتابة على الجداول الحساسة.
-- لا تستخدم service_role داخل index.html أو أي كود يعمل على الهاتف.
-- ============================================================

commit;
