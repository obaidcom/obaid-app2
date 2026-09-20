-- عبيد للصيانة | Technician push isolation
-- Applied to Supabase project pullcihxwmcoxqmzldqi.
-- New-order push notifications are sent only to orders.tech_id.

begin;

create or replace function public.notify_new_order_to_technicians()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status <> 'pending' then
    return new;
  end if;

  if new.tech_id is not null then
    insert into public.tech_notifications
      (tech_id, order_id, message, type, is_read)
    select t.id, new.id,
           '📥 طلب صيانة جديد: ' || coalesce(new.service,'خدمة صيانة'),
           'new_order', false
    from public.technicians t
    where t.id = new.tech_id
      and t.is_active = true;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_notify_new_order_to_technicians on public.orders;
create trigger trg_notify_new_order_to_technicians
after insert on public.orders
for each row execute function public.notify_new_order_to_technicians();

drop trigger if exists trg_fanout_tech_notification_to_user on public.tech_notifications;
drop trigger if exists trg_fanout_tech_notification on public.tech_notifications;
create trigger trg_fanout_tech_notification
after insert on public.tech_notifications
for each row execute function public.fanout_tech_notification_to_user();

commit;
