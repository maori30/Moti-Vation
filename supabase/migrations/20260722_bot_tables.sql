-- Users table
CREATE TABLE IF NOT EXISTS bot_users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  chat_id BIGINT UNIQUE NOT NULL,
  first_name TEXT,
  personality TEXT DEFAULT 'cynic',
  state TEXT DEFAULT 'idle',
  pending_reminder_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Reminders table
CREATE TABLE IF NOT EXISTS reminders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  chat_id BIGINT NOT NULL REFERENCES bot_users(chat_id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  type TEXT NOT NULL, -- 'once', 'daily', 'weekly'
  time TEXT NOT NULL, -- HH:MM format
  scheduled_at TIMESTAMPTZ,
  active BOOLEAN DEFAULT TRUE,
  last_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for scheduler
CREATE INDEX IF NOT EXISTS idx_reminders_active ON reminders(active, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_reminders_chat ON reminders(chat_id);
