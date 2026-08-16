-- ============================================================
-- Moti awareness upgrade: events, priorities, forgetting engine,
-- confidence, inside jokes, anti-repetition, life loop.
-- Run once in the Supabase project that hosts the bot tables.
-- Safe to run more than once.
-- ============================================================

-- 1) Events the bot noticed by itself (birthday, meeting, exam, trip...)
CREATE TABLE IF NOT EXISTS public.user_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'event',      -- birthday|meeting|exam|trip|job|goal|waiting_for|event
  when_at TIMESTAMPTZ,                     -- resolved time if known
  when_text TEXT,                          -- free text as the user said it
  importance INTEGER NOT NULL DEFAULT 2,   -- 4=critical 3=important 2=normal 1=trivial
  confidence REAL NOT NULL DEFAULT 0.7,
  status TEXT NOT NULL DEFAULT 'open',     -- open|done|passed|cancelled
  offered_at TIMESTAMPTZ,                  -- when we offered to save/remind
  asked_after_at TIMESTAMPTZ,              -- when we asked "how did it go?"
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_events_chat_title_idx ON public.user_events (chat_id, lower(title));
CREATE INDEX IF NOT EXISTS user_events_when_idx ON public.user_events (when_at);
GRANT ALL ON public.user_events TO service_role;
ALTER TABLE public.user_events ENABLE ROW LEVEL SECURITY;

-- 2) Priorities + forgetting metadata on memories
ALTER TABLE public.user_memories ADD COLUMN IF NOT EXISTS importance INTEGER DEFAULT 2;
ALTER TABLE public.user_memories ADD COLUMN IF NOT EXISTS last_referenced_at TIMESTAMPTZ;
ALTER TABLE public.user_memories ADD COLUMN IF NOT EXISTS decayed_at TIMESTAMPTZ;

-- 3) Inside jokes
CREATE TABLE IF NOT EXISTS public.inside_jokes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id BIGINT NOT NULL,
  phrase TEXT NOT NULL,
  meaning TEXT,
  hits INTEGER NOT NULL DEFAULT 1,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS inside_jokes_chat_phrase_idx ON public.inside_jokes (chat_id, lower(phrase));
GRANT ALL ON public.inside_jokes TO service_role;
ALTER TABLE public.inside_jokes ENABLE ROW LEVEL SECURITY;

-- 4) Anti-repetition: fingerprints of recent bot phrasings
CREATE TABLE IF NOT EXISTS public.bot_phrases (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  text TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_phrases_chat_idx ON public.bot_phrases (chat_id, created_at DESC);
GRANT ALL ON public.bot_phrases TO service_role;
ALTER TABLE public.bot_phrases ENABLE ROW LEVEL SECURITY;

-- 5) Deep-conversation state + life loop bookkeeping
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deep_mode_until TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deep_topic TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_life_loop_at TIMESTAMPTZ;
