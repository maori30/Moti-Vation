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
// for both "once" and recurring types. Real completion is now only logged
// when the user explicitly confirms via the "✅ סיימתי" button in index.ts.
// This file only sends reminders and reschedules them.

// FIX #8: recurring reschedule is computed from the reminder's OWN previous
// `time` and rebuilt from Israel wall-clock hour/minute (not a fixed ms
// offset), so drift and DST jumps don't shift the local time-of-day.

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

// FIX #10: reminder messages used to be a robotic hardcoded template
// ("⏰ תזכורת: <task>") regardless of the user's chosen personality.
// Now each personality has its own set of natural, colon-free phrasings,
// and one is picked at random per send so it doesn't feel repetitive.
const REMINDER_TEMPLATES: Record<string, ((task: string) => string)[]> = {
  coach: [
    (t) => `הגיע הזמן — ${t}. קדימה, אתה יודע שאתה יכול 💪`,
    (t) => `לא שוכחים דברים כאלה — ${t}, עכשיו!`,
    (t) => `זה הרגע. ${t}. תעשה את זה ותדווח לי אחר כך.`,
  ],
  cynic: [
    (t) => `אז, ${t}? כן, זה עכשיו. זוז.`,
    (t) => `הבטחת לעצמך ${t}. עכשיו זה הזמן להוכיח שלא שיקרת.`,
    (t) => `${t}. לא, זה לא ייעלם אם תתעלם ממני.`,
  ],
  friend: [
    (t) => `היי, רק מזכיר בחיבה — ${t} 😊`,
    (t) => `אחי, זוכר ש${t}? עכשיו הזמן המושלם.`,
    (t) => `קטן עליך — ${t}, ותחזור לספר לי 🤗`,
  ],
  sergeant: [
    (t) => `דיווח: ${t}. בצע מיידית.`,
    (t) => `זמן פג. ${t} עכשיו.`,
    (t) => `${t}. אין תירוצים, יש ביצוע.`,
  ],
  therapist: [
    (t) => `רגע קטן לעצמך — ${t}, בלי לחץ, פשוט עכשיו.`,
    (t) => `זה הזמן ל${t}. איך מרגיש לעצור לרגע ולעשות את זה?`,
    (t) => `${t}. תן לזה מקום, בלי להילחץ.`,
  ],
  hype: [
    (t) => `יאללה!! 🔥 הגיע הרגע ל${t}!!`,
    (t) => `בוקר טוב אלוף! זמן ל${t} — קדימה תראה להם!! 🚀`,
    (t) => `וואו וואו וואו, ${t} מחכה לך — יאללה תעשה את זה! 🔥`,
  ],
  grandma: [
    (t) => `מותק, אל תשכח ${t}, טוב לך.`,
    (t) => `נו, ${t}? סבתא אומרת שעכשיו הזמן.`,
    (t) => `תעשה לי טובה ו${t}, זה בשבילך.`,
  ],
  philosopher: [
    (t) => `הרגע הזה נועד בדיוק בשביל ${t} — מה אתה מחכה?`,
    (t) => `${t}. הזמן חולף בין כה וכה, אז שיהיה עם משמעות.`,
    (t) => `אולי זה הרגע לשאול: מתי אם לא עכשיו ל${t}?`,
  ],
  frayer: [
    (t) => `תכל'ס, ${t} זה תשואה קטנה שרק מחכה שתיקח אותה.`,
    (t) => `עסקה פשוטה: ${t} עכשיו, בלי ויכוחים.`,
    (t) => `אתה משאיר כסף על השולחן אם לא עושה ${t} עכשיו.`,
  ],
  neighbor: [
    (t) => `היי שכן, אני כבר עשיתי הכל היום — אולי גם אתה תספיק ${t}? 😏`,
    (t) => `רק מציין — ${t} מחכה לך. אני? כבר הספקתי.`,
    (t) => `${t}, שכן. אל תיתן לי לעקוף אותך גם בזה.`,
  ],
};

const DEFAULT_TEMPLATES = REMINDER_TEMPLATES.cynic;

function buildReminderMessage(personality: string, task: string): string {
  const templates = REMINDER_TEMPLATES[personality] ?? DEFAULT_TEMPLATES;
  const pick = templates[Math.floor(Math.random() * templates.length)];
  return pick(task);
}

Deno.serve(async (_req: Request) => {
  try {
    const nowIso = new Date().toISOString();

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

    // FIX #11: batch-fetch personalities for all chat_ids involved, so each
    // reminder can be phrased in the user's chosen style instead of a
    // one-size-fits-all robotic line.
    const chatIds = [...new Set(dueReminders.map((r) => r.chat_id))];
    const { data: usersData } = await supabase
      .from("users")
      .select("chat_id, personality")
      .in("chat_id", chatIds);

    const personalityByChat = new Map<number, string>();
    for (const u of usersData ?? []) {
      personalityByChat.set(u.chat_id, u.personality ?? "cynic");
    }

    let sent = 0;
    let failed = 0;

    for (const r of dueReminders) {
      try {
        const personality = personalityByChat.get(r.chat_id) ?? "cynic";
        const message = buildReminderMessage(personality, r.text);
        const delivered = await sendTelegramMessage(r.chat_id, message);

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
