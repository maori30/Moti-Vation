-- Migration fixed: replaced old schema with current bot schema (IF NOT EXISTS)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Users table
CREATE TABLE IF NOT EXISTS public.users (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT UNIQUE NOT NULL,
  first_name TEXT,
  personality TEXT DEFAULT 'cynic',
  state TEXT DEFAULT 'idle',
  pending_reminder_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Reminders table
CREATE TABLE IF NOT EXISTS public.reminders (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  text TEXT NOT NULL,
  time TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('once', 'daily', 'weekly')),
  day TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_reminders_active ON public.reminders(active);
CREATE INDEX IF NOT EXISTS idx_reminders_chat_id ON public.reminders(chat_id);
CREATE INDEX IF NOT EXISTS idx_users_chat_id ON public.users(chat_id);

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO anon, authenticated;
GRANT ALL ON public.users TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reminders TO anon, authenticated;
GRANT ALL ON public.reminders TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.users_id_seq TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.reminders_id_seq TO anon, authenticated, service_role;

-- RLS
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Open access to users"
  ON public.users FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "Open access to reminders"
  ON public.reminders FOR ALL USING (true) WITH CHECK (true);
