-- ============================================================
-- الميزات الجديدة: صورة الطلب، توفر الفني، أكواد الخصم
-- نفّذه في: Supabase Dashboard > SQL Editor
-- ============================================================

-- 1) صورة العطل عند تقديم الطلب
alter table orders add column if not exists photo text;

-- 2) توفر الفني (متاح / غير متاح لاستقبال طلبات جديدة)
alter table technicians add column if not exists is_available boolean default true;

-- 3) أكواد الخصم
create table if not exists discount_codes (
  id bigint generated always as identity primary key,
  code text unique not null,
  percent numeric not null check (percent > 0 and percent <= 100),
  is_active boolean default true,
  expires_at date,
  created_at timestamptz default now()
);

alter table discount_codes enable row level security;

drop policy if exists "select_discount_codes" on discount_codes;
create policy "select_discount_codes" on discount_codes for select using (true);

drop policy if exists "insert_discount_codes" on discount_codes;
create policy "insert_discount_codes" on discount_codes for insert with check (true);

drop policy if exists "update_discount_codes" on discount_codes;
create policy "update_discount_codes" on discount_codes for update using (true);

drop policy if exists "delete_discount_codes" on discount_codes;
create policy "delete_discount_codes" on discount_codes for delete using (true);
