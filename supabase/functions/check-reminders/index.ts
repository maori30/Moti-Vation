import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";
const TZ = Deno.env.get("BOT_TIMEZONE") ?? "Asia/Jerusalem";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

type Reminder = {
  id: string;
  chat_id: number;
  text: string;
  type: "once" | "daily" | "weekly";
  time: string;
  active: boolean;
  confirm_needed: boolean | null;
  nudge_sent_at: string | null;
};

async function sendTelegramMessage(chatId: number, text: string, keyboard?: object): Promise<boolean> {
  try {
    const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "HTML" };
    if (keyboard) body.reply_markup = keyboard;
    const response = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error(`[check-reminders] Telegram ${response.status}: ${(await response.text()).slice(0, 300)}`);
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

function cleanTaskText(task: string): string {
  return task
    .trim()
    .replace(/^(תזכיר לי|תזכורת על|תזכורת ל|תזכורת|אל תשכח)\s*/u, "")
    .replace(/[.。!]+$/u, "")
    .trim();
}

const TEMPLATES: Record<string, Array<(task: string) => string>> = {
  coach: [
    (t) => `תזכורת: ${t}. צעד קטן וסגרת את זה 💪`,
    (t) => `יאללה, ${t} — ואז ממשיכים.`,
    (t) => `הזמן עכשיו: ${t}. קדימה.`,
  ],
  cynic: [
    (t) => `תזכורת: ${t}. כן, גם היום.`,
    (t) => `נו, ${t}? זה לא ייעלם מעצמו.`,
    (t) => `${t} — לפני שזה יברח לך שוב מהראש.`,
    (t) => `אני לא אומר שאתה דוחה, אבל ${t} זה עכשיו.`,
  ],
  friend: [
    (t) => `רק מזכיר: ${t} 😊`,
    (t) => `${t}, אחי. שתי דקות ואתה חופשי.`,
    (t) => `תזכורת קטנה: ${t}.`,
  ],
  sergeant: [
    (t) => `משימה: ${t}. בצע.`,
    (t) => `זמן ל${t}. עכשיו.`,
    (t) => `${t}. בלי תירוצים.`,
  ],
  therapist: [
    (t) => `תזכורת עדינה: ${t}, בלי לחץ.`,
    (t) => `כשמתאים לך עכשיו — ${t}.`,
    (t) => `רגע קטן לעצמך: ${t}.`,
  ],
  hype: [
    (t) => `יאללה, ${t} 🔥`,
    (t) => `${t} — קטן עליך! 🚀`,
    (t) => `זה הרגע: ${t}! 💥`,
  ],
  grandma: [
    (t) => `מותק, אל תשכח: ${t}.`,
    (t) => `חמוד, ${t}, טוב לך.`,
    (t) => `נו מותק, ${t}?`,
  ],
  philosopher: [
    (t) => `גם דברים קטנים בונים יום: ${t}.`,
    (t) => `מתי אם לא עכשיו: ${t}?`,
    (t) => `פעולה קטנה: ${t}.`,
  ],
  frayer: [
    (t) => `תכל'ס: ${t}. שתי שניות וסגרת פינה.`,
    (t) => `רק ${t} ונגמר הסיפור.`,
    (t) => `סגור פינה: ${t}.`,
  ],
  neighbor: [
    (t) => `היי שכן, רק מזכיר: ${t} 😏`,
    (t) => `שכן, ${t}, לפני שאני צריך להזכיר שוב.`,
  ],
};

const DEFAULT_TEMPLATES = TEMPLATES.cynic;

function buildReminderMessage(personality: string, rawTask: string): string {
  const task = cleanTaskText(rawTask);
  const options = TEMPLATES[personality] ?? DEFAULT_TEMPLATES;
  return options[Math.floor(Math.random() * options.length)](task);
}

const NUDGE_PREFIXES = [
  (base: string) => `פספסת את זה? ${base}`,
  (base: string) => `אני לא אומר שאתה מתעלם, אבל ${base}`,
  (base: string) => `שוב אני: ${base}`,
  (base: string) => `עדיין מחכה: ${base}`,
];

function buildNudgeMessage(base: string): string {
  return NUDGE_PREFIXES[Math.floor(Math.random() * NUDGE_PREFIXES.length)](base);
}

function keyboardForReminder(id: string, needsConfirmation: boolean) {
  if (!needsConfirmation) return undefined;
  return {
    inline_keyboard: [
      [
        { text: "✅ סיימתי", callback_data: `done_reminder_${id}` },
        { text: "⏰ עוד 15 דק'", callback_data: `snooze_${id}` },
      ],
    ],
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

    const reminders = due as Reminder[];
    const chatIds = [...new Set(reminders.map((row) => row.chat_id))];
    const { data: users } = await supabase
      .from("users")
      .select("chat_id, personality")
      .in("chat_id", chatIds);
    const personalities = new Map<number, string>((users ?? []).map((user) => [user.chat_id, user.personality ?? "cynic"]));

    let sent = 0;
    let failed = 0;

    for (const reminder of reminders) {
      try {
        const personality = personalities.get(reminder.chat_id) ?? "cynic";
        const needsConfirmation = reminder.confirm_needed === true;
        const isNudge = needsConfirmation && Boolean(reminder.nudge_sent_at);
        const base = buildReminderMessage(personality, reminder.text);
        const message = isNudge ? buildNudgeMessage(base) : base;

        if (!await sendTelegramMessage(reminder.chat_id, message, keyboardForReminder(reminder.id, needsConfirmation))) {
          failed++;
          continue;
        }

        if (reminder.type === "once" && needsConfirmation && !isNudge) {
          await supabase.from("reminders").update({
            nudge_sent_at: now.toISOString(),
            time: new Date(now.getTime() + 20 * 60_000).toISOString(),
          }).eq("id", reminder.id);
        } else if (reminder.type === "once") {
          await supabase.from("reminders").update({ active: false }).eq("id", reminder.id);
        } else {
          const days = reminder.type === "weekly" ? 7 : 1;
          await supabase.from("reminders").update({
            time: nextOccurrence(new Date(reminder.time), days).toISOString(),
            nudge_sent_at: null,
          }).eq("id", reminder.id);
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
