-- ============================================================
-- إعداد قاعدة البيانات لدعم الإشعارات الحقيقية (Push Notifications)
-- نفّذ هذا الملف كاملاً في: Supabase Dashboard > SQL Editor
-- ============================================================

-- 1) إنشاء الجدول إذا لم يكن موجوداً، أو إضافة الأعمدة الناقصة إذا كان موجوداً
create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  device_token text not null,
  platform text default 'android',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table push_subscriptions add column if not exists device_token text;
alter table push_subscriptions add column if not exists platform text default 'android';
alter table push_subscriptions add column if not exists updated_at timestamptz default now();

-- منع تكرار نفس الجهاز أكثر من مرة (لازم لعمل upsert من التطبيق)
create unique index if not exists push_subscriptions_device_token_key
  on push_subscriptions (device_token);

create index if not exists push_subscriptions_user_id_idx
  on push_subscriptions (user_id);

-- 2) سياسات الأمان (RLS)
alter table push_subscriptions enable row level security;

drop policy if exists "select_own_push_subscriptions" on push_subscriptions;
create policy "select_own_push_subscriptions"
  on push_subscriptions for select
  using (true);

drop policy if exists "upsert_own_push_subscriptions" on push_subscriptions;
create policy "upsert_own_push_subscriptions"
  on push_subscriptions for insert
  with check (true);

drop policy if exists "update_own_push_subscriptions" on push_subscriptions;
create policy "update_own_push_subscriptions"
  on push_subscriptions for update
  using (true);

-- ============================================================
-- الربط التلقائي بين "إدراج إشعار جديد" و"إرسال Push حقيقي"
-- عندك طريقتان — اختر واحدة فقط:
-- ============================================================

-- ▶ الطريقة أ (موصى بها - أبسط وأكثر أماناً، بدون كتابة مفاتيح سرية هنا):
--   من واجهة Supabase مباشرة:
--   Database > Webhooks > Create a new webhook
--     Table: notifications | Events: Insert
--     Type: Supabase Edge Function | Function: send-push

-- ▶ الطريقة ب (تلقائية بالكامل عبر SQL، بديل إذا صعب عليك فتح لوحة التحكم):
--   استبدل <PROJECT_REF> و <SERVICE_ROLE_KEY> بالقيم الحقيقية من مشروعك
--   (Settings > API في Supabase)، ثم نفّذ هذا الجزء:
/*
create extension if not exists pg_net;

create or replace function trigger_send_push_notification()
returns trigger as $$
begin
  perform net.http_post(
    url := 'https://<PROJECT_REF>.functions.supabase.co/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body := jsonb_build_object('record', to_jsonb(NEW))
  );
  return NEW;
end;
$$ language plpgsql security definer;

drop trigger if exists on_notification_insert_send_push on notifications;
create trigger on_notification_insert_send_push
  after insert on notifications
  for each row execute function trigger_send_push_notification();
*/
-- ⚠️ تنبيه أمني: هذه الطريقة تخزّن SERVICE_ROLE_KEY داخل قاعدة البيانات نفسها.
-- الطريقة (أ) أعلاه لا تحتاج لصق أي مفتاح سري في SQL إطلاقاً، فهي الأفضل افتراضياً.
-- ============================================================

