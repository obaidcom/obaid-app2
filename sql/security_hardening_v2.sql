-- ============================================================
-- إصلاح أمني شامل (2) - نفّذه في: Supabase Dashboard > SQL Editor
-- بعد تنفيذ sql/real_auth_migration_and_rls.sql (يعتمد على my_user_id/my_role/my_tech_id)
-- ============================================================
-- هذا الملف لا يحذف أي جدول ولا أي بيانات. فقط يضيف أعمدة/سياسات/دوال جديدة
-- أو يستبدل سياسات RLS قديمة كانت مفتوحة أكثر من اللازم (using(true)).
-- ============================================================


-- ============================================================
-- 1) باركود الفاتورة: نسخة ثابتة تُحفظ وقت إنشاء الفاتورة، فلا تتغير
--    الفاتورة القديمة حتى لو غيّر الفني/الإدارة الباركود لاحقاً
-- ============================================================
alter table invoices add column if not exists payment_barcode_image text;


-- ============================================================
-- 2) إغلاق جدول admins القديم بالكامل
-- ============================================================
-- هذا الجدول كان يخزّن بريد + كلمة مرور نصية (plain text) للأدمن، ويُستخدم في
-- استعلام مباشر من المتصفح (select ... eq('password', password)) بلا أي تشفير
-- ولا Supabase Auth ولا RLS - أي شخص يعرف عنوان مشروع Supabase ومفتاح anon
-- (وكلاهما موجود أصلاً داخل index.html كما هو متوقع لأي تطبيق Supabase) كان
-- يستطيع نظرياً قراءة هذا الجدول بالكامل لأنه لم يكن محمياً بـ RLS إطلاقاً.
--
-- تم إيقاف استخدام هذا الجدول بالكامل من الواجهة (index.html) - أصبح مصدر
-- صلاحية الأدمن الوحيد هو users.role = 'admin' فوق Supabase Auth الحقيقي.
-- لا نحذف الجدول (قد يحتوي سجلات قديمة تريد مراجعتها يدوياً)، لكن نمنع أي
-- قراءة أو كتابة له من العميل نهائياً إلا لأدمن حقيقي موثّق (للمراجعة فقط):
alter table admins enable row level security;

drop policy if exists "admins_select_admin_only" on admins;
create policy "admins_select_admin_only" on admins for select
using (my_role() = 'admin');
-- لا توجد أي سياسة insert/update/delete هنا عمداً = ممنوعة تماماً من العميل.
-- (بعد التأكد من عدم وجود أي استخدام متبقٍ لهذا الجدول، يمكن لاحقاً حذفه
-- يدوياً من لوحة Supabase مباشرة - وليس عبر SQL تلقائي حرصاً على عدم حذف
-- بيانات دون تأكيد صريح منك).


-- ============================================================
-- 3) notifications - كانت مفتوحة بالكامل (select/update باستخدام true):
--    أي مستخدم كان يستطيع قراءة إشعارات كل المستخدمين الآخرين وتعديل حالتها
-- ============================================================
drop policy if exists "select_notifications" on notifications;
create policy "notifications_select_own" on notifications for select
using (my_role() = 'admin' or user_id = my_user_id());

drop policy if exists "update_notifications" on notifications;
create policy "notifications_update_own" on notifications for update
using (my_role() = 'admin' or user_id = my_user_id());

-- الإدراج يبقى مفتوحاً عمداً: النظام الحالي يُدرج إشعاراً لمستخدم آخر مباشرة
-- من متصفح العميل (مثل تنبيه فني بطلب جديد) بدون دالة RPC وسيطة. هذا مقبول
-- لأن الإشعار نفسه ليس بيانات حساسة يقرؤها إلا صاحبها (محمي أعلاه بالسياسة
-- select)، لكن يُفضَّل مستقبلاً نقل الإدراج إلى Edge Function/RPC موثوقة
-- بدل إبقاء insert مفتوحاً تماماً.
drop policy if exists "insert_notifications" on notifications;
create policy "notifications_insert_open" on notifications for insert with check (true);


-- ============================================================
-- 4) complaints - نفس المشكلة: أي مستخدم كان يستطيع قراءة/تعديل شكاوى الآخرين
--    (بما فيها تغيير حالة شكواه هو نفسه إلى "تم الحل" يدوياً!)
-- ============================================================
drop policy if exists "select_complaints" on complaints;
create policy "complaints_select_isolated" on complaints for select
using (my_role() = 'admin' or user_id = my_user_id());

drop policy if exists "update_complaints" on complaints;
create policy "complaints_update_admin_only" on complaints for update
using (my_role() = 'admin');

drop policy if exists "insert_complaints" on complaints;
create policy "complaints_insert_open" on complaints for insert with check (true);


-- ============================================================
-- 5) ratings - القراءة العامة مقصودة (عرض التقييمات للجميع في صفحة الخدمات)،
--    لكن الإدراج/التعديل يجب أن يقتصر على صاحب التقييم أو الأدمن
-- ============================================================
drop policy if exists "insert_ratings" on ratings;
create policy "ratings_insert_own" on ratings for insert
with check (my_role() = 'admin' or user_id = my_user_id());

drop policy if exists "update_ratings" on ratings;
create policy "ratings_update_own_or_admin" on ratings for update
using (my_role() = 'admin' or user_id = my_user_id());


-- ============================================================
-- 6) discount_codes - كانت insert/update/delete مفتوحة بالكامل: أي مستخدم
--    كان يستطيع نظرياً إنشاء كود خصم 100% لنفسه من متصفحه مباشرة!
-- ============================================================
drop policy if exists "insert_discount_codes" on discount_codes;
create policy "discount_codes_insert_admin" on discount_codes for insert
with check (my_role() = 'admin');

drop policy if exists "update_discount_codes" on discount_codes;
create policy "discount_codes_update_admin" on discount_codes for update
using (my_role() = 'admin');

drop policy if exists "delete_discount_codes" on discount_codes;
create policy "discount_codes_delete_admin" on discount_codes for delete
using (my_role() = 'admin');
-- select يبقى عاماً عمداً (يلزم قبل تسجيل الدخول للتحقق من الكود عند الحجز)


-- ============================================================
-- 7) push_subscriptions - كانت مفتوحة بالكامل: أي شخص يستطيع قراءة device
--    tokens لكل المستخدمين (تسريب خصوصية) أو الكتابة فوق اشتراك مستخدم آخر
--    (تعطيل إشعاراته أو تحويلها لجهاز آخر)
-- ============================================================
drop policy if exists "select_own_push_subscriptions" on push_subscriptions;
create policy "push_select_own" on push_subscriptions for select
using (my_role() = 'admin' or user_id = my_user_id());

drop policy if exists "upsert_own_push_subscriptions" on push_subscriptions;
create policy "push_insert_own" on push_subscriptions for insert
with check (my_role() = 'admin' or user_id = my_user_id());

drop policy if exists "update_own_push_subscriptions" on push_subscriptions;
create policy "push_update_own" on push_subscriptions for update
using (my_role() = 'admin' or user_id = my_user_id());
-- ملاحظة: هذا يتطلب أن يكون المستخدم مسجّلاً دخوله عبر Supabase Auth الحقيقي
-- (auth_uid مربوط) وقت تسجيل جهازه - وهذا متوافق مع بند 22 من طلبك.


-- ============================================================
-- 8) orders/invoices: منع الفني من تعديل الحقول الحساسة حتى لو كانت سياسة
--    RLS للـ UPDATE تسمح له بالوصول للصف (RLS وحدها لا تمنع تعديل عمود بعينه
--    بسهولة، فنستخدم Trigger لفحص القيم قبل/بعد التعديل)
-- ============================================================
create or replace function prevent_tech_order_tamper()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if my_role() = 'admin' then
    return new;
  end if;

  if old.user_id is distinct from new.user_id then
    raise exception 'غير مسموح بتغيير صاحب الطلب (user_id)';
  end if;

  if old.tech_id is not null and new.tech_id is distinct from old.tech_id then
    raise exception 'غير مسموح بإعادة تعيين الطلب لفني آخر';
  end if;

  if new.tech_id is not null and my_tech_id() is not null and new.tech_id <> my_tech_id() then
    raise exception 'لا يمكنك تعيين هذا الطلب لفني غير نفسك';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_tech_order_tamper on orders;
create trigger trg_prevent_tech_order_tamper
after update on orders
for each row execute function prevent_tech_order_tamper();


create or replace function prevent_tech_invoice_tamper()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if my_role() = 'admin' then
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

drop trigger if exists trg_prevent_tech_invoice_tamper on invoices;
create trigger trg_prevent_tech_invoice_tamper
after update on invoices
for each row execute function prevent_tech_invoice_tamper();


-- ============================================================
-- 9) technicians: تقييد الفني بحيث لا يستطيع تعديل شيء في سجله الخاص سوى
--    باركوده الشخصي وحالة توفره (is_available) - وليس اسمه أو صلاحياته أو
--    حالة تفعيله أو محافظته أو ربطه بحساب مستخدم آخر
-- ============================================================
create or replace function prevent_tech_self_update_overreach()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if my_role() = 'admin' then
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

drop trigger if exists trg_prevent_tech_self_update_overreach on technicians;
create trigger trg_prevent_tech_self_update_overreach
after update on technicians
for each row execute function prevent_tech_self_update_overreach();


-- ============================================================
-- 10) technicians: إغلاق القراءة المباشرة للجدول (كانت مفتوحة بالكامل عبر
--    using(true) وتُظهر barcode_image وpermissions وuser_ref_id لأي زائر
--    حتى بدون تسجيل دخول) - واستبدالها بـ View عام لا يحوي إلا الحقول التي
--    تحتاجها الشاشات العامة فعلاً (اختيار فني عند الحجز، عرض نشاط الفنيين)
-- ============================================================
create or replace view technicians_public as
  select id, name, governorate, is_active, is_available
  from technicians;

alter view technicians_public set (security_invoker = true);
grant select on technicians_public to anon, authenticated;

drop policy if exists "technicians_select_public" on technicians;
create policy "technicians_select_isolated" on technicians for select
using (my_role() = 'admin' or id = my_tech_id());


-- ============================================================
-- 11) دالة آمنة وضيّقة جداً لحالة واحدة متبقية: النظام يحتاج معرفة "حساب
--    المستخدم المرتبط بفني معيّن" لإرسال إشعار له عند تعيينه لطلب جديد أو
--    تأكيد طلبه - وهذا يحدث من متصفح العميل مباشرة (وليس الفني أو الأدمن)
-- ============================================================
create or replace function get_technician_user_ref(p_tech_id bigint)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_ref_id from technicians where id = p_tech_id;
$$;

grant execute on function get_technician_user_ref(bigint) to anon, authenticated;


-- ============================================================
-- 12) إنشاء سجل الفني الحالي بشكل آمن عند الحاجة
-- ============================================================
create or replace function ensure_my_technician_row(p_name text, p_phone text)
returns technicians
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id bigint;
  v_role text;
  v_row technicians;
begin
  select id, role into v_user_id, v_role from users where auth_uid = auth.uid();
  if v_user_id is null or v_role <> 'technician' then
    raise exception 'غير مسموح: هذا الحساب ليس فنياً';
  end if;

  select * into v_row from technicians where user_ref_id = v_user_id limit 1;
  if found then
    return v_row;
  end if;

  insert into technicians (name, code, phone, permissions, is_active, user_ref_id)
  values (
    coalesce(p_name, 'فني'),
    'tech_' || v_user_id || '_' || extract(epoch from now())::bigint,
    coalesce(p_phone, ''),
    '{"viewOrders":true,"updateStatus":true,"viewCustomer":false,"allGovernorates":false}'::jsonb,
    true,
    v_user_id
  )
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function ensure_my_technician_row(text, text) to authenticated;

-- ============================================================
-- ملاحظات هامة / محاذير باقية
-- ============================================================
-- • يجب أن تستخدم الواجهة technicians_public عند عرض قائمة الفنيين العامة.
-- • يجب أن تستدعي الواجهة ensure_my_technician_row للفني الجديد بدلاً من INSERT مباشر.
