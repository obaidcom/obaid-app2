-- Notification action links for general broadcasts.
-- Applied to Supabase project pullcihxwmcoxqmzldqi.
alter table public.notifications add column if not exists action_url text;
alter table public.notifications add column if not exists title text;
create index if not exists idx_notifications_action_url
  on public.notifications(action_url)
  where action_url is not null;
