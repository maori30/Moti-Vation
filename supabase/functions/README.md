# Moti bot — Supabase Edge Functions

| Function | Trigger | What it does |
|---|---|---|
| `telegram` | Telegram webhook (verified with `secret_token`) | Handles every message and button press |
| `check-reminders` | pg_cron, every minute (`x-cron-secret`) | Sends due reminders, weekly reviews, holidays, countdown updates |
| `daily-summary` | pg_cron, 06:00 UTC | Morning summary and streak updates |
| `proactive-checkin` | pg_cron, hourly | Follow-up questions and gentle check-ins (quiet hours 22:00–08:00) |

## Layout

```
_shared/db.ts       supabase-js compatible query builder over a direct Postgres connection (SUPABASE_DB_URL)
_shared/util.ts     Telegram HTML escaping, cron auth, Israel-time helpers, run-once job markers
telegram/index.ts   message flow (onboarding, commands, AI router, conversation)
telegram/intent.ts  AI intent router: free text -> structured action (reminders, habits, notes, settings)
telegram/schedule.ts  pure date/time parsing for reminders (regex fallback)
telegram/gemini.ts  Gemini calls, model failover, voice transcription
telegram/tg.ts      Telegram Bot API helpers
telegram/personas.ts  personalities and canned replies
telegram/brain.ts, profile.ts, awareness.ts  memory, profile and awareness layers
tests/              Deno unit tests (no network, no database)
```

### How a message is understood
1. Voice notes are transcribed first.
2. If the text could be an action (time words, numbers, action verbs...), `intent.ts` asks Gemini for a
   structured intent. The model returns *local* date/time parts; `resolveWhen()` converts them to
   Israel time, and reminder/habit IDs are checked against the user's real rows.
3. Plain small talk skips the router and goes straight to the conversational reply.
4. If the router fails (Gemini down), the legacy regex pipeline (`schedule.ts`) takes over.

## Database access
The functions do not use the REST API key: the project's secret key was rejected by the gateway
(`PGRST303 JWT issued at future`). `_shared/db.ts` talks to Postgres directly and keeps the familiar
`supabase.from("table").select()...` API.

## Tests

```bash
cd supabase/functions
DENO_NO_PACKAGE_JSON=1 deno check --no-lock --node-modules-dir=none */index.ts
DENO_NO_PACKAGE_JSON=1 deno test --no-lock --node-modules-dir=none --allow-env tests/
```

CI runs both on every pull request and before every deploy
(`.github/workflows/deploy-supabase-functions.yml`).
