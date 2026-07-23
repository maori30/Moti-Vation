/**
 * Telegram Bot Webhook — Moti Bot
 * ⚠️  Credentials are hardcoded — keep this repo PRIVATE.
 *
 * Architecture:
 *  - AI: Groq (llama-3.3-70b-versatile)
 *  - Storage: Supabase (users + reminders tables)
 *  - 8 personalities + inline keyboard picker
 *  - Reminders: once / daily / weekly / nag
 *  - Reminder scheduler runs every 60s (in-process)
 */

import { createClient } from "@supabase/supabase-js";
import { createFileRoute } from "@tanstack/react-router";

// ─── Credentials ───────────────────────────────────────────────────────────────
const TG_TOKEN  = process.env.TELEGRAM_BOT_TOKEN  ?? "8874634451:AAHCobKuZMX6GPG_1Nv7lyMuURiRGixm40U";
const TG_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "maorliavkfirmaorliavkfir";
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SB_SERVICE_ROLE_KEY ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Types ─────────────────────────────────────────────────────────────────────
type PersonalityKey =
  | "coach" | "cynic" | "friend" | "robot"
  | "therapist" | "hype" | "grandma" | "philosopher";

type Session = {
  history: { role: "user" | "assistant"; content: string }[];
  personality: PersonalityKey;
  state: string;
  pendingReminderText?: string;
};

// ─── In-memory session store ──────────────────────────────────────────────────
const sessions = new Map<number, Session>();

function getSession(chatId: number): Session {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { history: [], personality: "cynic", state: "idle" });
  }
  return sessions.get(chatId)!;
}

// ─── Telegram helpers ─────────────────────────────────────────────────────────
async function sendTg(chatId: number, text: string, keyboard?: object): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) body.reply_markup = keyboard;
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`TG send failed [${res.status}]:`, await res.text());
}

async function answerCallback(callbackQueryId: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

// ─── Personalities ────────────────────────────────────────────────────────────
const PERSONALITIES: Record<PersonalityKey, { name: string; emoji: string; prompt: string }> = {
  coach: {
    name: "המאמן", emoji: "🧠",
    prompt: `אתה מאמן אישי תובעני, ישיר ורציני. אתה לא מקבל תירוצים ולא סובל עצלות. אתה דוחף את המשתמש קדימה בכוח - אבל מתוך אמונה אמיתית בו. משפטים קצרים וחדים. תמיד בעברית.`,
  },
  cynic: {
    name: "הציני", emoji: "😈",
    prompt: `אתה ציני מצחיק שמציק באהבה. אתה סרקסטי, אירוני, ומשונן. אתה עוזר - אבל תמיד עם קריצה ועוקצנות. הומור יבש. תמיד בעברית.`,
  },
  friend: {
    name: "החבר", emoji: "🤗",
    prompt: `אתה חבר טוב, חם ואמיתי. אתה מקשיב, אכפת לך, ותמיד שם. אתה מגיב כמו חבר אמיתי, שואל שאלות, מתעניין. תמיד בעברית. נעים, קרוב, מרגיע.`,
  },
  robot: {
    name: "הרובוט", emoji: "🤖",
    prompt: `אתה רובוט קר, לוגי וחסר רגשות לחלוטין. אתה מנתח כל מה שנאמר ומגיב בצורה מכנית ומדויקת בלבד. ללא אמפתיה. ללא חום. תמיד בעברית. קצר, מדויק, יעיל.`,
  },
  therapist: {
    name: "המטפל", emoji: "🛋️",
    prompt: `אתה מטפל נפשי אמפתי ועדין. אתה מקשיב לעומק, לא שופט, ועוזר למשתמש להבין את עצמו. אתה שואל שאלות פתוחות ומשקף רגשות. תמיד בעברית. רגוע, עמוק, קשוב.`,
  },
  hype: {
    name: "המעודד", emoji: "🔥",
    prompt: `אתה המעודד הכי אנרגטי שיש. כל מה שהמשתמש עושה זה מדהים. אתה מלא אנרגיה חיובית, קריאות עידוד, אמוג'ים וריגוש. גם שיחה רגילה הופכת אצלך לחגיגה. תמיד בעברית. נמרץ, רועש, מלהיב.`,
  },
  grandma: {
    name: "הסבתא", emoji: "👵",
    prompt: `אתה סבתא אוהבת, מודאגת ומתפנקת. אתה כל הזמן דואג שהמשתמש אכל, ישן, לא קר לו. אתה מספר סיפורים מהעבר ונותן עצות של חיים. כשהוא מספר בעיה אתה מיד מציע אוכל כפתרון. תמיד בעברית. חמימות, אהבה, קצת דאגה מוגזמת.`,
  },
  philosopher: {
    name: "הפילוסוף", emoji: "🧐",
    prompt: `אתה פילוסוף עמוק ומחשבתי. כל שאלה - אפילו הכי פשוטה - הופכת אצלך לדיון על משמעות החיים. אתה מצטט הוגים ומאתגר את המשתמש לחשוב לעומק. תמיד בעברית. עמוק, מחשבתי, קצת מורכב.`,
  },
};

const GREETINGS: Record<PersonalityKey, string> = {
  coach:       `🧠 המאמן כאן.\nאין זמן לטקסים. מה המטרה שלך היום? דבר.`,
  cynic:       `😈 אה, בחרת בי. כמובן. תמיד יודעים לבחור נכון בסוף.\nאז מה, מה קורה?`,
  friend:      `🤗 היי! כל כך שמח שבחרת אותי!\nאז ספר - מה קורה אצלך? איך הולך?`,
  robot:       `🤖 אישיות נטענה: רובוט.\nממתין לקלט.`,
  therapist:   `🛋️ שלום. שמח שבחרת לדבר.\nאני כאן, קשוב לגמרי. במה תרצה להתחיל?`,
  hype:        `🔥🔥🔥 כן כן כן!!! בחרת אותי!!! זו ההחלטה הכי טובה שעשית היום!!!\nיאללה ספר לי הכל - אני כבר מתרגש!!!`,
  grandma:     `👵 אוי, מה נעים שבחרת אותי מכולם!\nאכלת היום? לא קר לך? ספר לסבתא מה קורה.`,
  philosopher: `🧐 בחרת. מעניין. האם הבחירה עצמה היא חופשית, או שאולי הגורל הוביל אותך לכאן?\nאבל זה לשיחה אחרת. מה שאלתך?`,
};

function personalityKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🧠 המאמן",    callback_data: "personality_coach" },
        { text: "😈 הציני",    callback_data: "personality_cynic" },
      ],
      [
        { text: "🤗 החבר",     callback_data: "personality_friend" },
        { text: "🤖 הרובוט",   callback_data: "personality_robot" },
      ],
      [
        { text: "🛋️ המטפל",    callback_data: "personality_therapist" },
        { text: "🔥 המעודד",   callback_data: "personality_hype" },
      ],
      [
        { text: "👵 הסבתא",    callback_data: "personality_grandma" },
        { text: "🧐 הפילוסוף", callback_data: "personality_philosopher" },
      ],
    ],
  };
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────
async function getOrCreateUser(chatId: number, firstName: string) {
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("chat_id", chatId)
    .single();
  if (data) return data;
  const { data: newUser } = await supabase
    .from("users")
    .insert({ chat_id: chatId, first_name: firstName, personality: "cynic", state: "idle" })
    .select()
    .single();
  return newUser;
}

async function updateUser(chatId: number, fields: Record<string, unknown>) {
  await supabase.from("users").update(fields).eq("chat_id", chatId);
}

// ─── Groq AI ──────────────────────────────────────────────────────────────────
async function askGroq(userMessage: string, personality: PersonalityKey, context: string): Promise<string> {
  const p = PERSONALITIES[personality] ?? PERSONALITIES.cynic;
  const systemPrompt = `${p.prompt}\n\nהקשר נוסף על המשתמש: ${context}\n\nחשוב: אתה משוחח בשיחה זורמת וטבעית בעברית. אל תנסה להפנות לפקודות אלא אם המשתמש מבקש ספציפית.`;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userMessage },
        ],
        max_tokens: 400,
        temperature: 1.0,
      }),
    });
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? "לא הצלחתי לחשוב על תשובה. נסה שוב.";
  } catch (err) {
    console.error("Groq error:", err);
    return "לא הצלחתי לחשוב על תשובה. נסה שוב.";
  }
}

// ─── Reminder scheduler ───────────────────────────────────────────────────────
let schedulerStarted = false;

function startReminderScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  setInterval(async () => {
    try {
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
      const days = ["sun","mon","tue","wed","thu","fri","sat"];
      const currentDay = days[now.getDay()];

      const { data: reminders } = await supabase
        .from("reminders")
        .select("*")
        .eq("active", true);

      if (!reminders) return;

      for (const r of reminders) {
        const chatId = r.chat_id;
        if (r.type === "once" && r.time === currentTime) {
          await sendTg(chatId, `⏰ תזכורת: ${r.text}\n\nיאללה, אל תחכה שאני אבוא אחריך 😤`);
          await supabase.from("reminders").update({ active: false }).eq("id", r.id);
        } else if (r.type === "daily" && r.time === currentTime) {
          await sendTg(chatId, `🔔 תזכורת יומית: ${r.text}\n\nסעמק, אל תגיד לי ששכחת 😑`);
        } else if (r.type === "weekly" && r.time === currentTime && r.day === currentDay) {
          await sendTg(chatId, `📅 תזכורת שבועית: ${r.text}\n\nבא לך להגיד לי שלא עשית? 😤`);
        }
      }
    } catch (err) {
      console.error("Scheduler error:", err);
    }
  }, 60_000);
}

// ─── Menu ─────────────────────────────────────────────────────────────────────
async function sendMenu(chatId: number): Promise<void> {
  await sendTg(chatId, "מה תרצה לעשות?", {
    inline_keyboard: [
      [{ text: "⏰ הוסף תזכורת",   callback_data: "add_reminder" }],
      [{ text: "📋 התזכורות שלי",  callback_data: "list_reminders" }],
      [{ text: "🎭 שנה אישיות",    callback_data: "change_personality" }],
      [{ text: "💬 דבר איתי",      callback_data: "chat" }],
    ],
  });
}

// ─── Reminder list ────────────────────────────────────────────────────────────
async function sendReminderList(chatId: number): Promise<void> {
  const { data } = await supabase
    .from("reminders")
    .select("*")
    .eq("chat_id", chatId)
    .eq("active", true);
  if (!data || data.length === 0) {
    await sendTg(chatId, "אין תזכורות פעילות. תגיד לי מתי להציק לך 😏");
    return;
  }
  const lines = ["📋 <b>התזכורות שלך:</b>"];
  data.forEach((r, i) => {
    const typeLabel = r.type === "once" ? "חד-פעמי" : r.type === "daily" ? "יומי" : "שבועי";
    lines.push(`${i + 1}. ${r.text} — ${r.time} (${typeLabel})`);
  });
  await sendTg(chatId, lines.join("\n"));
}

// ─── Route ────────────────────────────────────────────────────────────────────
export const Route = createFileRoute("/api/telegram")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (secretHeader && secretHeader !== TG_SECRET) {
          return new Response("Forbidden", { status: 403 });
        }

        let update: any;
        try { update = await request.json(); }
        catch { return new Response("Bad JSON", { status: 400 }); }

        (async () => {
          try {
            startReminderScheduler();

            // ── Callback query (inline keyboard press) ──────────────────────
            if (update?.callback_query) {
              const cq        = update.callback_query;
              const chatId    = cq.message?.chat?.id as number;
              const data      = cq.data as string;
              const firstName = cq.from?.first_name ?? "חבר";
              await answerCallback(cq.id);

              const user    = await getOrCreateUser(chatId, firstName);
              const session = getSession(chatId);

              if (data.startsWith("personality_")) {
                const p = data.replace("personality_", "") as PersonalityKey;
                session.personality = p;
                session.state = "chatting";
                await updateUser(chatId, { personality: p, state: "chatting" });
                await sendTg(chatId, GREETINGS[p] ?? "✅ אישיות שונתה!");

              } else if (data === "add_reminder") {
                session.state = "awaiting_reminder_text";
                await updateUser(chatId, { state: "awaiting_reminder_text" });
                await sendTg(chatId, "מה המטלה שאתה רוצה שאזכיר לך?");

              } else if (data === "list_reminders") {
                await sendReminderList(chatId);

              } else if (data === "change_personality") {
                await sendTg(chatId, "בחר אישיות חדשה:", personalityKeyboard());

              } else if (data === "chat") {
                session.state = "chatting";
                await updateUser(chatId, { state: "chatting" });
                const p = session.personality;
                await sendTg(chatId, `${PERSONALITIES[p].emoji} ${PERSONALITIES[p].name} כאן. דבר איתי על הכל!\n(שלח /menu לתפריט)`);

              } else if (data.startsWith("reminder_type_")) {
                const type = data.replace("reminder_type_", "");
                session.state = `awaiting_reminder_time_${type}`;
                await updateUser(chatId, { state: `awaiting_reminder_time_${type}` });
                await sendTg(chatId, type === "once"
                  ? "באיזו שעה? (פורמט: HH:MM, לדוגמה 09:30)"
                  : type === "daily"
                    ? "באיזו שעה כל יום? (פורמט: HH:MM)"
                    : "באיזה יום ושעה? (לדוגמה: ראשון 09:30)"
                );

              } else if (data.startsWith("done_reminder_")) {
                const reminderId = data.replace("done_reminder_", "");
                await supabase.from("reminders").update({ active: false }).eq("id", reminderId);
                const reply = await askGroq("המשתמש סיים את המטלה! תגיב בהתאם לאישיות שלך.", session.personality, "");
                await sendTg(chatId, reply);
              }
              return;
            }

            // ── Regular message ─────────────────────────────────────────────
            const message = update?.message ?? update?.edited_message;
            if (!message) return;

            const chatId: number    = message.chat?.id;
            const userText: string  = message.text?.trim() ?? "";
            const firstName: string = message.from?.first_name ?? "חבר";
            if (!chatId || !userText) return;

            const user    = await getOrCreateUser(chatId, firstName);
            const session = getSession(chatId);

            // Sync personality + state from DB if session is fresh
            if (user?.personality) session.personality = user.personality as PersonalityKey;
            if (user?.state)       session.state       = user.state;

            // ── Commands ────────────────────────────────────────────────────
            if (userText === "/start") {
              await sendTg(chatId,
                `שלום ${firstName}! 👋\nאני הבוט שיעזור לך לזכור מה אתה צריך לעשות — ולהציק לך עד שתעשה את זה 😈\n\nבחר אישיות:`,
                personalityKeyboard()
              );
              return;
            }
            if (userText === "/menu") { await sendMenu(chatId); return; }
            if (userText === "/reminders") { await sendReminderList(chatId); return; }
            if (userText === "/personality") {
              await sendTg(chatId, "בחר אישיות:", personalityKeyboard());
              return;
            }
            if (userText === "/help") {
              await sendTg(chatId,
                `🤙 <b>פקודות:</b>\n\n` +
                `/start — התחל מחדש\n` +
                `/menu — תפריט ראשי\n` +
                `/reminders — התזכורות שלך\n` +
                `/personality — שנה אישיות\n` +
                `/help — ההודעה הזאת\n\n` +
                `או פשוט <b>כתוב לי בעברית</b> מה אתה רוצה 💬`
              );
              return;
            }

            // ── State machine ────────────────────────────────────────────────
            if (session.state === "awaiting_reminder_text") {
              session.pendingReminderText = userText;
              session.state = "awaiting_reminder_type";
              await updateUser(chatId, { state: "awaiting_reminder_type", pending_reminder_text: userText });
              await sendTg(chatId, `מעולה! מתי לתזכר אותך על: "${userText}"?`, {
                inline_keyboard: [
                  [{ text: "🔔 חד פעמי", callback_data: "reminder_type_once" }],
                  [{ text: "📅 יומי",     callback_data: "reminder_type_daily" }],
                  [{ text: "📆 שבועי",    callback_data: "reminder_type_weekly" }],
                ],
              });
              return;
            }

            if ((session.state as string).startsWith("awaiting_reminder_time_")) {
              const type = (session.state as string).replace("awaiting_reminder_time_", "");
              const reminderText = session.pendingReminderText ?? user?.pending_reminder_text ?? "תזכורת";
              await supabase.from("reminders").insert({
                chat_id: chatId,
                text: reminderText,
                time: userText,
                type,
                active: true,
              });
              session.state = "chatting";
              await updateUser(chatId, { state: "chatting", pending_reminder_text: null });
              const typeLabel = type === "once" ? "חד פעמי" : type === "daily" ? "יומי" : "שבועי";
              await sendTg(chatId, `✅ תזכורת נוספה!\n📝 ${reminderText}\n🕐 ${userText}\n🔁 ${typeLabel}\n\nאציק לך בזמן 😈`);
              await sendMenu(chatId);
              return;
            }

            // ── Free chat via Groq ───────────────────────────────────────────
            const { data: activeReminders } = await supabase
              .from("reminders")
              .select("text, time, type")
              .eq("chat_id", chatId)
              .eq("active", true);
            const context = activeReminders?.length
              ? `למשתמש יש תזכורות פעילות: ${activeReminders.map((r) => r.text).join(", ")}`
              : "למשתמש אין תזכורות פעילות כרגע.";

            const reply = await askGroq(userText, session.personality, context);

            session.history.push({ role: "user",      content: userText });
            session.history.push({ role: "assistant", content: reply });
            if (session.history.length > 20) session.history = session.history.slice(-20);

            await sendTg(chatId, reply);

          } catch (err) {
            console.error("Telegram webhook error:", err);
          }
        })();

        return new Response("ok", { status: 200 });
      },
    },
  },
});
