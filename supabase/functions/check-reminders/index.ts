import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";
const TZ = Deno.env.get("BOT_TIMEZONE") ?? "Asia/Jerusalem";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function sendTelegramMessage(chatId: number, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[check-reminders] telegram send failed for chat ${chatId}: HTTP ${res.status} ${errText.slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[check-reminders] telegram send threw for chat ${chatId}:`, err);
    return false;
  }
}

// FIX #7 (REMOVED HERE, MOVED TO index.ts "done_reminder_" HANDLER):
// logCompletion() used to run automatically every time a reminder was SENT,
// for both "once" and recurring types. That means completion stats
// (reminder_completions + goals_achieved) tracked "the bot pinged the user",
// not "the user actually did the task". For a daily reminder this silently
// inflated goals_achieved by +1 EVERY SINGLE DAY forever, even if the user
// never touched it — which is exactly why morning-summary counts looked
// wrong. Real completion should only be logged when the user explicitly
// confirms via the "✅ סיימתי" button in index.ts. This file no longer logs
// completions at all — it only sends reminders and reschedules them.

// FIX #8: previously the recurring reschedule was computed as
//   now + 24h (or +7d), in raw milliseconds.
// Two problems with that:
//  (a) DRIFT — if a cron run is a few minutes late (very common), each
//      day's "next time" keeps drifting later, since it's based on `now`
//      instead of the reminder's own scheduled `time`. Over weeks a 06:30
//      reminder can silently creep to 07:00, 07:30, etc.
//  (b) DST — adding a fixed 86_400_000 ms does NOT equal "24 real hours in
//      Israel local time" across a DST transition (Israel's clocks shift by
//      1 hour in spring/autumn). A daily 06:30 reminder would jump to 05:30
//      or 07:30 local time right after the DST switch.
// The fix: reschedule from the reminder's OWN previous `time`, and rebuild
// the next occurrence from Israel wall-clock hour/minute (not from a fixed
// ms offset), so the local time-of-day always stays exactly what the user
// asked for.
function getTzOffsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {} as Record<string, string>);
  const asUTC = Date.UTC(
    parseInt(parts.year, 10), parseInt(parts.month, 10) - 1, parseInt(parts.day, 10),
    parseInt(parts.hour, 10), parseInt(parts.minute, 10), parseInt(parts.second, 10)
  );
  return (asUTC - date.getTime()) / 60000;
}

function nextOccurrence(prevTime: Date, daysToAdd: number): Date {
  const offsetMin = getTzOffsetMinutes(prevTime, TZ);
  const localMs = prevTime.getTime() + offsetMin * 60000;
  const local = new Date(localMs);
  const nextLocalNaive = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + daysToAdd,
    local.getUTCHours(), local.getUTCMinutes(), 0
  );
  const newOffsetMin = getTzOffsetMinutes(new Date(nextLocalNaive), TZ);
  return new Date(nextLocalNaive - newOffsetMin * 60000);
}

Deno.serve(async (_req: Request) => {
  try {
    const nowIso = new Date().toISOString();

    // FIX #9: now also selecting "time" itself — needed as the base for
    // nextOccurrence() instead of "now" (see FIX #8).
    const { data: dueReminders, error } = await supabase
      .from("reminders")
      .select("id, chat_id, text, type, time")
      .eq("active", true)
      .lte("time", nowIso);

    if (error) {
      console.error("[check-reminders] query failed:", error.message);
      return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 200 });
    }

    if (!dueReminders || dueReminders.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: 0 }), { status: 200 });
    }

    let sent = 0;
    let failed = 0;

    for (const r of dueReminders) {
      try {
        const delivered = await sendTelegramMessage(r.chat_id, `⏰ תזכורת: ${r.text}`);

        if (!delivered) {
          failed++;
          continue;
        }

        if (r.type === "once") {
          await supabase.from("reminders").update({ active: false }).eq("id", r.id);
        } else {
          const daysToAdd = r.type === "weekly" ? 7 : 1;
          const nextTime = nextOccurrence(new Date(r.time), daysToAdd).toISOString();
          await supabase.from("reminders").update({ time: nextTime }).eq("id", r.id);
        }

        sent++;
      } catch (sendErr) {
        console.error(`[check-reminders] failed to process reminder ${r.id}:`, sendErr);
        failed++;
      }
    }

    return new Response(JSON.stringify({ ok: true, sent, failed }), { status: 200 });
  } catch (err) {
    console.error("[check-reminders] fatal:", err);
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
});
