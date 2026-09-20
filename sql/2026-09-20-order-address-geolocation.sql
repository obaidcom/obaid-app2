-- عبيد للصيانة: حقول عنوان وموقع الطلب
alter table public.orders add column if not exists address text;
alter table public.orders add column if not exists latitude double precision;
alter table public.orders add column if not exists longitude double precision;
