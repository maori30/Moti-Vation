-- ============================================================
-- Moti: dynamic profile, behaviour learning, goals
-- Run in the Supabase project that hosts the Telegram bot tables.
-- Safe to run more than once.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.user_profile (
  chat_id BIGINT PRIMARY KEY,
  address_style TEXT,
  humor_level REAL NOT NULL DEFAULT 0.5,
  topics TEXT[] NOT NULL DEFAULT '{}',
  habits TEXT[] NOT NULL DEFAULT '{}',
  active_hours INTEGER[] NOT NULL DEFAULT '{}',
  procrastinates TEXT[] NOT NULL DEFAULT '{}',
  reminder_wins JSONB NOT NULL DEFAULT '{}'::jsonb,
  reply_len_avg INTEGER NOT NULL DEFAULT 0,
  prefers_short BOOLEAN NOT NULL DEFAULT false,
  blend JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.user_profile TO service_role;
ALTER TABLE public.user_profile ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.behavior_events (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS behavior_events_chat_idx ON public.behavior_events (chat_id, created_at DESC);
GRANT ALL ON public.behavior_events TO service_role;
ALTER TABLE public.behavior_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  deadline TEXT,
  progress TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS goals_chat_idx ON public.goals (chat_id, status);
GRANT ALL ON public.goals TO service_role;
ALTER TABLE public.goals ENABLE ROW LEVEL SECURITY;
