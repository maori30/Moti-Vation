-- Bot hardening (2026-11-12)
-- 1. Lock every bot table: only the Edge Functions (direct Postgres / service role) may touch them.
--    Previously follow_ups/habits/habit_logs had "USING (true)" policies and anon/authenticated
--    had full grants, so anyone holding the public key could read or delete user data.
-- 2. bot_config: private key/value store for the webhook + cron secrets and run-once job markers.
-- 3. processed_updates: Telegram update_id de-duplication (Telegram retries on timeouts).
-- 4. pg_cron jobs now authenticate to the functions with a shared secret header.

-- 1) Remove open policies and public grants -----------------------------------------
DROP POLICY IF EXISTS "Open access to follow_ups" ON public.follow_ups;
DROP POLICY IF EXISTS "Open access to habits" ON public.habits;
DROP POLICY IF EXISTS "Open access to habit_logs" ON public.habit_logs;
DROP POLICY IF EXISTS "Open access to users" ON public.users;
DROP POLICY IF EXISTS "Open access to reminders" ON public.reminders;
DROP POLICY IF EXISTS "Open access to countdowns" ON public.countdowns;
DROP POLICY IF EXISTS "Open access to quick_notes" ON public.quick_notes;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','reminders','messages','bot_errors','reminder_completions','user_memories',
    'proactive_followups','follow_ups','user_profile','behavior_events','goals','user_events',
    'inside_jokes','bot_phrases','countdowns','quick_notes','habits','habit_logs'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
      EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    END IF;
  END LOOP;
END $$;

-- 2) Private config ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bot_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.bot_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bot_config FROM anon, authenticated;
GRANT ALL ON public.bot_config TO service_role;

INSERT INTO public.bot_config (key, value)
VALUES ('cron_secret', encode(extensions.gen_random_bytes(32), 'hex')),
       ('webhook_secret', encode(extensions.gen_random_bytes(32), 'hex'))
ON CONFLICT (key) DO NOTHING;

-- 3) Update de-duplication ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.processed_updates (
  update_id BIGINT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.processed_updates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.processed_updates FROM anon, authenticated;
GRANT ALL ON public.processed_updates TO service_role;

-- Helpful indexes for the per-minute reminder scan and per-chat lookups
CREATE INDEX IF NOT EXISTS reminders_active_time_idx ON public.reminders (active, time);
CREATE INDEX IF NOT EXISTS messages_chat_created_idx ON public.messages (chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS follow_ups_pending_idx ON public.follow_ups (due_at) WHERE sent_at IS NULL AND cancelled = false;

-- 4) Authenticated pg_cron jobs (replaces the unauthenticated jobs and the GitHub Actions crons)
DO $$
DECLARE j record;
BEGIN
  FOR j IN SELECT jobid FROM cron.job
           WHERE command ILIKE '%/functions/v1/check-reminders%'
              OR command ILIKE '%/functions/v1/proactive-checkin%'
              OR command ILIKE '%/functions/v1/daily-summary%'
              OR command ILIKE '%/functions/v1/telegram%'
              OR command ILIKE '%processed_updates%'
  LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule('bot-check-reminders', '* * * * *', $cron$
  SELECT net.http_post(
    url := 'https://hulthqpmolqtwvdwyoej.supabase.co/functions/v1/check-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM public.bot_config WHERE key = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$cron$);

SELECT cron.schedule('bot-proactive-checkin', '0 * * * *', $cron$
  SELECT net.http_post(
    url := 'https://hulthqpmolqtwvdwyoej.supabase.co/functions/v1/proactive-checkin',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM public.bot_config WHERE key = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$cron$);

-- 06:00 UTC = 08:00 (winter) / 09:00 (summer) in Israel
SELECT cron.schedule('bot-daily-summary', '0 6 * * *', $cron$
  SELECT net.http_post(
    url := 'https://hulthqpmolqtwvdwyoej.supabase.co/functions/v1/daily-summary',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (SELECT value FROM public.bot_config WHERE key = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$cron$);

-- Keep the Telegram function warm (replaces the GitHub "Smart Keep-Alive" workflow)
SELECT cron.schedule('bot-telegram-keepwarm', '*/2 * * * *', $cron$
  SELECT net.http_get(
    url := 'https://hulthqpmolqtwvdwyoej.supabase.co/functions/v1/telegram',
    timeout_milliseconds := 10000
  );
$cron$);

-- Housekeeping: old de-dup markers, pg_net responses
SELECT cron.schedule('bot-housekeeping', '17 3 * * *', $cron$
  DELETE FROM public.processed_updates WHERE created_at < now() - interval '3 days';
  DELETE FROM public.bot_config WHERE key LIKE 'job:%' AND created_at < now() - interval '14 days';
$cron$);
