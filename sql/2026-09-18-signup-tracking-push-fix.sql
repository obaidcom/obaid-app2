-- 2026-09-18: signup recovery + unified tracking + push notification trigger
-- Applied directly to Supabase project pullcihxwmcoxqmzldqi.

create or replace function public.create_my_user_profile(
  p_name text, p_email text, p_phone text
) returns public.users
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v public.users;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;
  select * into v from public.users
  where auth_uid=auth.uid() or lower(email)=lower(p_email)
  limit 1;
  if v.id is not null then
    update public.users
    set auth_uid=auth.uid(),
        name=coalesce(nullif(p_name,''),name),
        phone=coalesce(p_phone,phone)
    where id=v.id
    returning * into v;
    return v;
  end if;
  insert into public.users(name,email,phone,auth_uid,role)
  values(p_name,p_email,coalesce(p_phone,''),auth.uid(),'user')
  returning * into v;
  return v;
end $$;

revoke all on function public.create_my_user_profile(text,text,text) from public, anon;
grant execute on function public.create_my_user_profile(text,text,text) to authenticated;

create or replace function public.notify_customer_order_stage()
returns trigger language plpgsql security definer
set search_path=public,pg_temp
as $$
declare v_message text;
begin
  if new.user_id is null then return new; end if;
  if tg_op='INSERT' then
    v_message := '📥 تم استلام طلبك: '||coalesce(new.service,'خدمة صيانة');
  elsif new.on_the_way_at is distinct from old.on_the_way_at and new.on_the_way_at is not null then
    v_message := '🚗 الفني '||coalesce(new.tech_name,'')||' في الطريق إليك الآن';
  elsif new.status is distinct from old.status or new.tech_id is distinct from old.tech_id then
    if new.status='accepted' and new.tech_id is not null then
      v_message := '👍 تم قبول الطلب وتعيين الفني';
    elsif new.status='in-progress' then
      v_message := '🔧 جاري المعالجة';
    elsif new.status='completed' then
      v_message := '🎉 تم الانتهاء من الخدمة';
    else return new; end if;
  else return new; end if;
  insert into public.notifications(user_id,message,type,related_id,is_read)
  values(new.user_id,v_message,'order_update',new.id,false);
  return new;
end $$;

revoke all on function public.notify_customer_order_stage() from public,anon,authenticated;
grant execute on function public.notify_customer_order_stage() to postgres;

drop trigger if exists trg_notify_customer_order_stage on public.orders;
create trigger trg_notify_customer_order_stage
after insert or update of status, tech_id, on_the_way_at
on public.orders
for each row execute function public.notify_customer_order_stage();
