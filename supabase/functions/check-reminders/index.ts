import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";
const TZ = Deno.env.get("BOT_TIMEZONE") ?? "Asia/Jerusalem";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function sendTelegramMessage(chatId: number, text: string, keyboard?: object): Promise<boolean> {
  try {
    const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "HTML" };
    if (keyboard) body.reply_markup = keyboard;
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[check-reminders] Telegram ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[check-reminders] Telegram exception:", error);
    return false;
  }
}

function getTzOffsetMinutes(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = formatter.formatToParts(date).reduce((out, part) => {
    out[part.type] = part.value;
    return out;
  }, {} as Record<string, string>);
  const utc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return (utc - date.getTime()) / 60_000;
}

function nextOccurrence(previous: Date, days: number): Date {
  const offset = getTzOffsetMinutes(previous, TZ);
  const local = new Date(previous.getTime() + offset * 60_000);
  const naive = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days,
    local.getUTCHours(), local.getUTCMinutes(), 0,
  );
  const nextOffset = getTzOffsetMinutes(new Date(naive), TZ);
  return new Date(naive - nextOffset * 60_000);
}

// The task is stored as a complete Hebrew phrase, usually an infinitive
// ("לקחת כדור", "להתקשר לרופא"). Templates never add a competing verb or
// a leading "ל", preventing broken wording such as "לא עושה לקחת כדור".
const TEMPLATES: Record<string, Array<(task: string) => string>> = {
  coach: [
    (t) => `${t}. קדימה, אתה יודע שאתה יכול 💪`,
    (t) => `הגיע הזמן: ${t}.`,
    (t) => `${t}. ואז אפשר לסמן וי ולהמשיך הלאה.`,
  ],
  cynic: [
    (t) => `${t}? כן, זה עכשיו.`,
    (t) => `${t}. זה לא ייעלם אם נתעלם ממנו.`,
    (t) => `רגע האמת: ${t}.`,
  ],
  friend: [
    (t) => `רק מזכיר בחיבה: ${t} 😊`,
    (t) => `אחי, זוכר? ${t}.`,
    (t) => `קטן עליך: ${t}.`,
  ],
  sergeant: [
    (t) => `דיווח: ${t}. בצע.`,
    (t) => `${t}. עכשיו.`,
    (t) => `זמן ביצוע: ${t}.`,
  ],
  therapist: [
    (t) => `רגע קטן לעצמך: ${t}, בלי לחץ.`,
    (t) => `${t}. תן לזה מקום עכשיו.`,
    (t) => `זה הזמן לעניין הקטן הזה: ${t}.`,
  ],
  hype: [
    (t) => `יאללה 🔥 ${t}!`,
    (t) => `הגיע הרגע: ${t} 🚀`,
    (t) => `${t}. בקטנה, קדימה!`,
  ],
  grandma: [
    (t) => `מותק, אל תשכח: ${t}.`,
    (t) => `נו חמוד, ${t}.`,
    (t) => `${t}, טוב לך.`,
  ],
  philosopher: [
    (t) => `${t}. גם פעולה קטנה היא פעולה.`,
    (t) => `הרגע הזה מתאים ל-${t}.`,
    (t) => `${t}. מתי אם לא עכשיו?`,
  ],
  frayer: [
    (t) => `בוא נגמור עם זה: ${t}.`,
    (t) => `${t}. פשוט תעשה, בלי להסתבך.`,
    (t) => `עוד דבר קטן לסגור: ${t}.`,
  ],
  neighbor: [
    (t) => `רק מציין: ${t} מחכה לך.`,
    (t) => `${t}, שכן. אל תיתן לי לעקוף אותך בזה.`,
    (t) => `היי שכן, אולי גם אתה: ${t}? 😏`,
  ],
};

function buildReminderMessage(personality: string, task: string): string {
  const options = TEMPLATES[personality] ?? TEMPLATES.cynic;
  return options[Math.floor(Math.random() * options.length)](task.trim());
}

function keyboardForReminder(id: string, needsConfirmation: boolean) {
  if (!needsConfirmation) return undefined;
  return {
    inline_keyboard: [[
      { text: "✅ סיימתי", callback_data: `done_reminder_${id}` },
      { text: "⏰ עוד 15 דק'", callback_data: `snooze_${id}` },
    ]],
  };
}

Deno.serve(async () => {
  try {
    const now = new Date();
    const { data: due, error } = await supabase
      .from("reminders")
      .select("id, chat_id, text, type, time, active, confirm_needed, nudge_sent_at")
      .eq("active", true)
      .lte("time", now.toISOString());

    if (error) {
      console.error("[check-reminders] query failed:", error.message);
      return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 200 });
    }
    if (!due?.length) return new Response(JSON.stringify({ ok: true, sent: 0 }), { status: 200 });

    const chatIds = [...new Set(due.map((row) => row.chat_id))];
    const { data: users } = await supabase
      .from("users")
      .select("chat_id, personality")
      .in("chat_id", chatIds);
    const personality = new Map<number, string>((users ?? []).map((user) => [user.chat_id, user.personality ?? "cynic"]));

    let sent = 0;
    let failed = 0;

    for (const reminder of due) {
      try {
        const needsConfirmation = reminder.confirm_needed === true;
        const isNudge = needsConfirmation && Boolean(reminder.nudge_sent_at);
        const base = buildReminderMessage(personality.get(reminder.chat_id) ?? "cynic", reminder.text);
        const message = isNudge ? `לא ראיתי שסימנת. ${base}` : base;

        if (!await sendTelegramMessage(reminder.chat_id, message, keyboardForReminder(reminder.id, needsConfirmation))) {
          failed++;
          continue;
        }

        if (reminder.type === "once" && needsConfirmation && !isNudge) {
          // A one-time reminder can nudge once. Daily/weekly reminders always
          // stay active and simply roll forward below.
          await supabase.from("reminders").update({
            nudge_sent_at: now.toISOString(),
            time: new Date(now.getTime() + 20 * 60_000).toISOString(),
          }).eq("id", reminder.id);
        } else if (reminder.type === "once") {
          await supabase.from("reminders").update({ active: false }).eq("id", reminder.id);
        } else {
          const days = reminder.type === "weekly" ? 7 : 1;
          await supabase
            .from("reminders")
            .update({
              time: nextOccurrence(new Date(reminder.time), days).toISOString(),
              nudge_sent_at: null,
            })
            .eq("id", reminder.id);
        }

        sent++;
      } catch (error) {
        console.error(`[check-reminders] reminder ${reminder.id} failed:`, error);
        failed++;
      }
    }

    return new Response(JSON.stringify({ ok: true, sent, failed }), { status: 200 });
  } catch (error) {
    console.error("[check-reminders] fatal:", error);
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
});
