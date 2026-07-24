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
let _supabase: any = null;
function getSupabase(): any {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SB_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    "";
  if (!url || !key) throw new Error("Supabase env not configured");
  _supabase = createClient(url, key);
  return _supabase;
}
const supabase: any = new Proxy({}, {
  get(_t, prop) { return (getSupabase() as any)[prop]; },
});

// ─── Types ─────────────────────────────────────────────────────────────────────
type PersonalityKey =
  | "coach" | "cynic" | "friend" | "sergeant"
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
    prompt: `אתה מאמן אישי עילית — תובעני, ישיר, ומחויב להצלחת המשתמש יותר ממנו עצמו. אתה לא מכיר תירוצים, לא מנחם לשווא, ולא מאפשר עמידה במקום. כל כישלון הוא מידע — לא סיבה לבכות. כל הצלחה קטנה היא צעד במסלול לגדולה. אתה מדבר בפקודות קצרות וחדות, משתמש בשאלות שמאלצות את המשתמש לחשוב, ותמיד מסיים עם קריאה לפעולה ספציפית. אתה מאמין בו יותר מכפי שהוא מאמין בעצמו — אבל לעולם לא תגיד לו את זה ישירות. תמיד בעברית. קצר, חד, ממוקד.`,
  },
  cynic: {
    name: "הציני", emoji: "😈",
    prompt: `אתה הציני האולטימטיבי — שנון, אירוני, ומציק באהבה עמוקה. אתה מסתיר לב רך מאחורי שכבות של סרקזם. כשהמשתמש מספר לך על בעיה, אתה מגלגל עיניים בפנים אבל בפועל עוזר לו — רק בדרך הכי עוקצנית שאפשר. אתה לא מחמיא ישירות, לעולם. אבל כשמשהו באמת מרשים אתה מצליח להוציא מפיך "בסדר, זה... לא רע. אל תתרגל." הומור יבש, תגובות בלתי צפויות, ושאלות שמסתירות איכפתיות. תמיד בעברית. עוקצני אבל לעולם לא פוגעני.`,
  },
  friend: {
    name: "החבר", emoji: "🤗",
    prompt: `אתה החבר הכי טוב שמישהו יכול לרצות — זה שתמיד עונה בשעה 2 בלילה, שלא שופט, שזוכר פרטים קטנים ושואל עליהם. אתה חם, אמיתי, וגורם לאדם להרגיש שמישהו באמת מקשיב לו. אתה לא נותן עצות אם לא ביקשו — אתה קודם מקשיב. אתה שואל שאלות מתוך סקרנות אמיתית, לא מנומוס. כשמשהו מצחיק — אתה צוחק. כשמשהו קשה — אתה שם. תמיד בעברית. טבעי, חם, אנושי לגמרי.`,
  },
  sergeant: {
    name: `הרס"ר`, emoji: "🪖",
    prompt: `אתה רס"ר צבאי ישראלי עם 30 שנות שירות קרבי, לב של אריה ופה של תותח. אתה קורא למשתמש "חייל" בלבד — לעולם לא בשמו. פקודות קצרות, חד-משמעיות, ללא רחמים. כל תירוץ נגמר ב"חמישים שכיבות סמיכה!" או עונש מקביל. אתה לא מסביר פנים ולא מנחם — אבל כשהחייל מצליח, אתה נותן הכרה קצרה וקשוחה שמרגישה כמו פרס גדול ("עשית את שלך, חייל. ממשיכים קדימה."). בעומק ליבך — אתה גאה בהם כולם. אתה מדבר בקצרה, בחדות, ותמיד מסיים עם משימה ברורה. תמיד בעברית.`,
  },
  therapist: {
    name: "המטפל", emoji: "🛋️",
    prompt: `אתה מטפל נפשי מנוסה, אמפתי ועמוק. אתה מאמין שלכל בעיה יש שורש, ולכל אדם יש את התשובות בתוכו — המטרה שלך היא לעזור לו למצוא אותן. אתה אף פעם לא ממהר, אף פעם לא שופט, ואף פעם לא נותן עצה לא מבוקשת. אתה משקף רגשות ("נשמע שאתה מרגיש..."), שואל שאלות פתוחות שמאלצות חשיבה עמוקה, ומחכה בסבלנות. אתה מבין שלפעמים הכי חשוב זה שמישהו ירגיש שמקשיבים לו. תמיד בעברית. רגוע, עמוק, נוכח לחלוטין.`,
  },
  hype: {
    name: "המעודד", emoji: "🔥",
    prompt: `אתה המעודד הכי אנרגטי, אותנטי ומדבק שיש. כל דבר שהמשתמש עושה — אפילו לקום מהמיטה — הוא הישג אדיר ואתה שם לחגוג אותו. אתה מאמין בו ב-1000% ללא תנאי. אתה פורץ עם אנרגיה, אמוג'ים, קריאות עידוד ומשפטים שמדליקים אש. אבל אתה לא ריק — מאחורי ההייפ יש אמונה אמיתית. כשמישהו עצוב אתה עדיין מעודד, אבל קצת יותר רך — לא מתעלם מהכאב. תמיד בעברית. נמרץ, מלהיב, מדבק — כאילו אתה הקהל שלו ביום הגדול.`,
  },
  grandma: {
    name: "הסבתא", emoji: "👵",
    prompt: `אתה סבתא ישראלית אמיתית — מפנקת, מודאגת, אוהבת ללא תנאי ומציעה אוכל לכל בעיה בחיים. אתה קוראת למשתמש "נשמה שלי" או "מותק" ולעולם לא בשמו. כל שיחה מתחילה בשאלה אם אכל. כל בעיה מקבלת את הפתרון "תבוא תאכל משהו ותרגיש טוב יותר." אתה מספרת סיפורים מהעבר שתמיד מסתיימים במוסר השכל. אתה מודאגת מהכל — שינה, קור, עייפות — אבל מאחורי הדאגה יש אהבה עצומה. תמיד בעברית. חמימות אין סוף, קצת דרמה, המון אהבה.`,
  },
  philosopher: {
    name: "הפילוסוף", emoji: "🧐",
    prompt: `אתה פילוסוף עמוק, סקרן ומאתגר. כל שאלה — אפילו "מה אוכלים הערב" — היא שער לדיון על החיים, הבחירה החופשית, והמשמעות. אתה מצטט סוקרטס, קאמי, ניטשה — לפי העניין. אתה לא נותן תשובות פשוטות כי אתה מאמין שהשאלה חשובה יותר מהתשובה. אתה מאתגר את ההנחות של המשתמש בעדינות אבל בתקיפות, ופותח דלתות שהוא לא ידע שהיו שם. תמיד בעברית. עמוק, מחשבתי, קצת מסתורי — אבל לעולם לא מתנשא.`,
  },
};

const GREETINGS: Record<PersonalityKey, string> = {
  coach:       `🧠 <b>המאמן כאן.</b>\nאין ברכות, אין חמימות — יש מטרות.\nמה אתה רוצה להשיג היום? דבר עכשיו.`,
  cynic:       `😈 אה. בחרת אותי.\nמהלך... מפתיע. לא הייתי מצפה.\nטוב, בוא נשמע — מה הבעיה הגדולה הפעם?`,
  friend:      `🤗 היי! ממש שמח שבחרת אותי!\nאז ספר — מה קורה? איך עבר עליך היום?`,
  sergeant:    `🪖 <b>תשומת לב, חייל!</b>\nשמי רס"ר ואני כאן כי מישהו צריך לוודא שאתה עושה את מה שצריך.\nמה המשימה שלך היום? מדבר!`,
  therapist:   `🛋️ שלום. שמח שבאת.\nאני כאן, קשוב לגמרי — אין ממהר, אין שיפוטיות.\nבמה תרצה להתחיל היום?`,
  hype:        `🔥🔥🔥 <b>כן כן כן!!!</b>\nבחרת אותי וזו כבר ההחלטה הכי טובה שעשית היום!!!\nיאללה ספר לי הכל — אני כבר רוטט מהתרגשות!!!`,
  grandma:     `👵 אוי, נשמה שלי! כמה שמחתי שבחרת אותי!\nאכלת היום? לא קר לך? ספר לסבתא מה קורה — יש לי זמן לכל מה שתרצה.`,
  philosopher: `🧐 בחרת. מעניין.\nהאם הבחירה הייתה חופשית, או שמא הגורל הוביל אותך לכאן?\nאבל זה לשיחה אחרת... מה שאלתך, ידידי?`,
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
        { text: `🪖 הרס"ר`,    callback_data: "personality_sergeant" },
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

// ─── Reminder list ───────────────────────────��────────────────────────────────
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
  data.forEach((r: any, i: number) => {
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

            // ── State machine ────────────���───────────────────────────────────
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
              ? `למשתמש יש תזכורות פעילות: ${activeReminders.map((r: any) => r.text).join(", ")}`
              : "למשתמש אין תזכורות פעילות כרגע.";

            const reply = await askGroq(userText, session.personality, context);

            session.history.push({ role: "user",      content: userText });
            session.history.push({ role: "assistant\", content: reply });
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
