-- ============================================================
-- Moti brain upgrade: real memory, follow-ups, mood, smart reminders
-- Run this in the Supabase project that hosts the Telegram bot tables
-- (the one with public.users / public.messages / public.reminders(chat_id)).
-- Safe to run more than once.
-- ============================================================

-- 1) Long-term memory layer -----------------------------------
CREATE TABLE IF NOT EXISTS public.user_memories (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',        -- fact | preference | habit | relationship | joke | project | request
  mem_key TEXT NOT NULL,                    -- stable slug, e.g. "work_hours"
  value TEXT NOT NULL,                      -- "עובד בדרך כלל עד 18:00"
  confidence REAL NOT NULL DEFAULT 0.7,
  source TEXT,
  hits INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_memories_chat_key_idx ON public.user_memories (chat_id, mem_key);
CREATE INDEX IF NOT EXISTS user_memories_chat_idx ON public.user_memories (chat_id);
GRANT ALL ON public.user_memories TO service_role;
ALTER TABLE public.user_memories ENABLE ROW LEVEL SECURITY;

-- 2) Proactive follow-ups -------------------------------------
CREATE TABLE IF NOT EXISTS public.follow_ups (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  topic TEXT NOT NULL,
  question TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  cancelled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS follow_ups_due_idx ON public.follow_ups (due_at);
GRANT ALL ON public.follow_ups TO service_role;
ALTER TABLE public.follow_ups ENABLE ROW LEVEL SECURITY;

-- 3) Personality mood state + tone preferences ----------------
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS mood TEXT DEFAULT 'calm';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS mood_updated_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS humor_level REAL DEFAULT 0.5;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS temp_personality TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS temp_personality_until TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tone_override TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS repeat_streak INTEGER DEFAULT 0;

-- 4) Smarter reminders ----------------------------------------
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS confirm_needed BOOLEAN DEFAULT false;
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS nudge_sent_at TIMESTAMPTZ;
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS lead_minutes INTEGER;
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS anchor TEXT;
