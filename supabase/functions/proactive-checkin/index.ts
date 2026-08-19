import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { lifeLoopDecide, markLifeLoopSent } from "./lifeloop.ts";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";
const TZ = Deno.env.get("BOT_TIMEZONE") ?? "Asia/Jerusalem";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MIN_HOURS_SINCE_USER_FOR_GENERIC_NUDGE = 48;
const MIN_HOURS_BETWEEN_PROACTIVE_MESSAGES = 20;

async function sendTelegramMessage(chatId: number, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[proactive] Telegram failed for ${chatId}: ${res.status} ${errorText.slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[proactive] Telegram exception for ${chatId}:`, error);
    return false;
  }
}

function israelHour(): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
  );
}

function isQuietHoursNow(): boolean {
  const hour = israelHour();
  return hour < 8 || hour >= 22;
}

function hoursSince(value: string | null | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - time) / 3_600_000);
}

const TOPICS: Array<{ keywords: RegExp; prompts: string[] }> = [
  {
    keywords: /ביטוח|תעודת ביטוח|קופת חולים/,
    prompts: [
      "מה קרה עם הביטוח שדיברת עליו? הסתדר או שעוד יושב שם?",
      "נזכרתי בביטוח. טיפלת בזה בסוף?",
    ],
  },
  {
    keywords: /רופא שיניים|שיניים|תור לרופא|רופא/,
    prompts: [
      "מה קורה עם התור לרופא? קבעת כבר?",
      "נזכרתי שדיברת על הרופא. הסתדר משהו?",
    ],
  },
  {
    keywords: /תשלום|לשלם|חשבון|חוב|כרטיס אשראי/,
    prompts: [
      "מה קרה עם החשבון שדיברת עליו?",
      "הצלחת לטפל בתשלום בסוף?",
    ],
  },
  {
    keywords: /ספר|ללמוד|בחינה|מבחן|קורס/,
    prompts: [
      "איך הולך עם הלימודים?",
      "מה נסגר עם מה שרצית ללמוד?",
    ],
  },
  {
    keywords: /ספורט|כושר|לרוץ|חדר כושר|דיאטה/,
    prompts: [
      "איך הולך עם הכושר לאחרונה?",
      "יצא לך לזוז קצת השבוע?",
    ],
  },
];

const GENERIC_PROMPTS = [
  "היי, מה נשמע?",
  "מה איתך בזמן האחרון?",
  "זמן לא קטן שלא שמעתי ממך. הכול בסדר?",
];

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

async function sendDueFollowUps(): Promise<{ sent: number; chatsHandled: Set<number> }> {
  const chatsHandled = new Set<number>();
  let sent = 0;

  const { data, error } = await supabase
    .from("follow_ups")
    .select("id, chat_id, question")
    .is("sent_at", null)
    .eq("cancelled", false)
    .lte("due_at", new Date().toISOString())
    .limit(20);

  if (error) {
    console.error("[proactive] due follow-ups query failed:", error.message);
    return { sent, chatsHandled };
  }

  for (const followUp of data ?? []) {
    if (await sendTelegramMessage(followUp.chat_id, followUp.question)) {
      await supabase
        .from("follow_ups")
        .update({ sent_at: new Date().toISOString(), sent: true })
        .eq("id", followUp.id);
      await supabase
        .from("users")
        .update({ last_proactive_at: new Date().toISOString() })
        .eq("chat_id", followUp.chat_id);
      chatsHandled.add(followUp.chat_id);
      sent++;
    }
  }

  return { sent, chatsHandled };
}

async function findMemoryPrompt(chatId: number): Promise<string | null> {
  const { data } = await supabase
    .from("user_memories")
    .select("value, kind, created_at")
    .eq("chat_id", chatId)
    .in("kind", ["project", "request"])
    .order("created_at", { ascending: true })
    .limit(5);

  const old = (data ?? []).filter(
    (memory) => Date.now() - new Date(memory.created_at).getTime() > 4 * 24 * 3_600_000,
  );
  if (!old.length) return null;

  const memory = pick(old);
  return pick([
    `לפני כמה זמן אמרת: "${memory.value}". מה קרה עם זה בסוף?`,
    `נזכרתי ב"${memory.value}". עדיין רלוונטי?`,
  ]);
}

async function findTopicPrompt(chatId: number): Promise<string | null> {
  const { data: messages } = await supabase
    .from("messages")
    .select("content")
    .eq("chat_id", chatId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(30);

  if (!messages?.length) return null;

  const { data: activeReminders } = await supabase
    .from("reminders")
    .select("text")
    .eq("chat_id", chatId)
    .eq("active", true);
  const activeText = (activeReminders ?? []).map((reminder) => reminder.text).join(" ");

  for (const message of messages) {
    for (const topic of TOPICS) {
      if (topic.keywords.test(message.content) && !topic.keywords.test(activeText)) {
        return pick(topic.prompts);
      }
    }
  }

  return null;
}

Deno.serve(async () => {
  try {
    if (isQuietHoursNow()) {
      return new Response(JSON.stringify({ ok: true, skipped: "quiet_hours" }), { status: 200 });
    }

    const due = await sendDueFollowUps();
    const { data: users, error } = await supabase
      .from("users")
      .select("chat_id, last_message_at, last_proactive_at");

    if (error) {
      console.error("[proactive] users query failed:", error.message);
      return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 200 });
    }

    let sent = due.sent;
    for (const user of users ?? []) {
      if (due.chatsHandled.has(user.chat_id)) continue;

      const inactiveFor = hoursSince(user.last_message_at);
      const proactiveGap = hoursSince(user.last_proactive_at);
      if (proactiveGap < MIN_HOURS_BETWEEN_PROACTIVE_MESSAGES) continue;

      const reason = await lifeLoopDecide(supabase, user.chat_id, {
        hoursSinceLastUser: inactiveFor,
        hoursSinceLastProactive: proactiveGap,
      });

      if (reason) {
        if (await sendTelegramMessage(user.chat_id, reason.message)) {
          await markLifeLoopSent(supabase, user.chat_id, reason);
          await supabase
            .from("users")
            .update({ last_proactive_at: new Date().toISOString() })
            .eq("chat_id", user.chat_id);
          sent++;
        }
        continue;
      }

      // No generic nagging for a user who was active recently.
      if (inactiveFor < MIN_HOURS_SINCE_USER_FOR_GENERIC_NUDGE) continue;

      const memoryPrompt = await findMemoryPrompt(user.chat_id);
      const topicPrompt = memoryPrompt ? null : await findTopicPrompt(user.chat_id);
      const prompt = memoryPrompt ?? topicPrompt ?? pick(GENERIC_PROMPTS);

      if (await sendTelegramMessage(user.chat_id, prompt)) {
        await supabase
          .from("users")
          .update({ last_proactive_at: new Date().toISOString() })
          .eq("chat_id", user.chat_id);
        sent++;
      }
    }

    return new Response(JSON.stringify({ ok: true, sent, followUpsSent: due.sent }), { status: 200 });
  } catch (error) {
    console.error("[proactive] fatal:", error);
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
});
