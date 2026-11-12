import { createDb } from "../_shared/db.ts";
import {
  advanceRecurring, escapeHtml, gifAllowed, isCronAuthorized, israelParts, markGifSent, runOnce, telegramCall, toTelegramHtml,
} from "../_shared/util.ts";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GIPHY_API_KEY = Deno.env.get("GIPHY_API_KEY") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
const supabase = createDb();

type Reminder = {
  id: string;
  chat_id: number;
  text: string;
  type: "once" | "daily" | "weekly" | "yearly";
  time: string;
  active: boolean;
  confirm_needed: boolean | null;
  nudge_sent_at: string | null;
  weather_condition?: string | null;
};

// `html` must already be safe Telegram HTML (use toTelegramHtml / escapeHtml on any user/AI text).
async function sendHtml(chatId: number, html: string, keyboard?: object): Promise<boolean> {
  const body: Record<string, unknown> = { chat_id: chatId, text: html, parse_mode: "HTML" };
  if (keyboard) body.reply_markup = keyboard;
  return Boolean(await telegramCall(TG_TOKEN, "sendMessage", body));
}

async function editHtml(chatId: number, messageId: number, html: string): Promise<boolean> {
  return Boolean(await telegramCall(TG_TOKEN, "editMessageText", { chat_id: chatId, message_id: messageId, text: html, parse_mode: "HTML" }));
}

async function sendAnimation(chatId: number, animationUrl: string, captionHtml: string, keyboard?: object): Promise<boolean> {
  const body: Record<string, unknown> = { chat_id: chatId, animation: animationUrl, caption: captionHtml, parse_mode: "HTML" };
  if (keyboard) body.reply_markup = keyboard;
  return Boolean(await telegramCall(TG_TOKEN, "sendAnimation", body, "caption"));
}

async function gemini(prompt: string, maxOutputTokens: number): Promise<string> {
  if (!GEMINI_API_KEY) return "";
  for (const model of GEMINI_MODELS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens, thinkingConfig: { thinkingLevel: "minimal" } } }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) {
        if (res.status === 404) continue; // model not available for this key, try the next one
        console.error(`[check-reminders] gemini ${model} ${res.status}`);
        continue;
      }
      const data = await res.json();
      const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("").trim();
      if (text) return text;
    } catch (error) {
      console.error(`[check-reminders] gemini ${model} exception:`, error);
    }
  }
  return "";
}

async function fetchGifForTask(task: string, personality: string, botMessage: string): Promise<string | null> {
  if (!GIPHY_API_KEY) return null;
  try {
    const prompt = `You are a bot with personality '${personality}'.
You just sent the user this message: "${botMessage}"
For the task: "${task}"
Generate a short (1-3 words) English search query for Giphy that matches the emotion and tone of your message.
Return ONLY the english keywords, nothing else.`;
    const englishQuery = (await gemini(prompt, 10)).replace(/[^a-zA-Z\s]/g, "").trim() || "motivation";

    const search = async (q: string, limit: number) => {
      const res = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(q)}&limit=${limit}&rating=pg-13`);
      return res.ok ? (await res.json())?.data ?? [] : [];
    };
    let results = await search(englishQuery, 5);
    if (!results.length) {
      const fallbacks = ["just do it", "motivation", "you can do it", "get to work", "do it now"];
      results = await search(fallbacks[Math.floor(Math.random() * fallbacks.length)], 10);
    }
    if (!results.length) return null;
    return results[Math.floor(Math.random() * results.length)]?.images?.original?.url || null;
  } catch (e) {
    console.error("[check-reminders] Giphy failed", e);
    return null;
  }
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
    (t) => `שעון מעורר: ${t}. קדימה.`,
    (t) => `היי! משימה על הפרק: ${t}. אל תתן לזה לחכות.`,
    (t) => `זמן לעשייה: ${t}. אתה יכול על זה.`,
    (t) => `תזכורת של אלופים: ${t}. תסיים עם זה ותרגיש מעולה.`,
    (t) => `מיקוד עכשיו: ${t}. לא לוותר!`,
  ],
  cynic: [
    (t) => `תזכורת: ${t}. כן, גם היום.`,
    (t) => `נו, ${t}? זה לא ייעלם מעצמו.`,
    (t) => `${t} — לפני שזה יברח לך שוב מהראש.`,
    (t) => `אני לא אומר שאתה דוחה, אבל ${t} זה עכשיו.`,
    (t) => `הלו, יש פה משימה שמחכה לך: "${t}". אולי תסיים עם זה הפעם?`,
    (t) => `בוא לא נשחק משחקים. הגיע הזמן ל-"${t}".`,
    (t) => `ניחוש פראי: עדיין לא סגרת את "${t}". אני פה להזכיר לך.`,
    (t) => `שוב אני, עם המשימה: "${t}". פשוט תסיים עם זה וזהו.`,
  ],
  friend: [
    (t) => `רק מזכיר: ${t} 😊`,
    (t) => `${t}, אחי. שתי דקות ואתה חופשי.`,
    (t) => `תזכורת קטנה: ${t}.`,
    (t) => `היי! לא לשכוח: ${t}. קטן עליך.`,
    (t) => `שם פה תזכורת כדי שלא תשכח: ${t}.`,
    (t) => `מה קורה? זה הזמן ל${t} ✌️`,
    (t) => `מקפיץ לך תזכורת ל${t}. נדבר אחרי שתסיים.`,
  ],
  sergeant: [
    (t) => `משימה: ${t}. בצע.`,
    (t) => `זמן ל${t}. עכשיו.`,
    (t) => `${t}. בלי תירוצים.`,
    (t) => `אני לא שומע שאתה מבצע ${t}! זוז!`,
    (t) => `למי אתה מחכה? ${t} עכשיו!`,
    (t) => `לא שואל אותך: ${t}. קדימה לעבודה.`,
    (t) => `פקודה אחרונה להיום (אולי): ${t}.`,
  ],
  therapist: [
    (t) => `תזכורת עדינה: ${t}, בלי לחץ.`,
    (t) => `כשמתאים לך עכשיו — ${t}.`,
    (t) => `רגע קטן לעצמך: ${t}.`,
    (t) => `אני פה להזכיר לך ברוגע: ${t}. קח נשימה לפני.`,
    (t) => `אם יש לך פניות עכשיו, זה זמן טוב ל${t}.`,
    (t) => `חשוב לשים לב ל${t}, למען השקט הנפשי שלך.`,
    (t) => `הנה תזכורת שמחכה לך: ${t}. בקצב שלך.`,
  ],
  hype: [
    (t) => `יאללה, ${t} 🔥`,
    (t) => `${t} — קטן עליך! 🚀`,
    (t) => `זה הרגע: ${t}! 💥`,
    (t) => `בום! הגיע הזמן ל${t} 🙌`,
    (t) => `אין מצב שאתה לא תופר את זה: ${t}!`,
    (t) => `מצב מטורף לעשייה! לך תפרק את ${t} ⚡️`,
    (t) => `תזכורת של מנצחים: ${t}!!!`,
  ],
  grandma: [
    (t) => `מותק, אל תשכח: ${t}.`,
    (t) => `חמוד, ${t}, טוב לך.`,
    (t) => `נו מותק, ${t}?`,
    (t) => `סבתא מזכירה: ${t}. ואל תשכח לאכול משהו!`,
    (t) => `לחיים שלי, הגיע הזמן ל${t}. תשמור על עצמך.`,
    (t) => `אני דואגת לך, תעשה כבר ${t}.`,
    (t) => `נשמה, תזכורת קטנה ל${t}.`,
  ],
  philosopher: [
    (t) => `גם דברים קטנים בונים יום: ${t}.`,
    (t) => `מתי אם לא עכשיו: ${t}?`,
    (t) => `פעולה קטנה: ${t}.`,
    (t) => `הדרך מתחילה בצעד אחד: ${t}.`,
    (t) => `כל מעשה משנה את המציאות. הגיע הזמן ל${t}.`,
    (t) => `אפשר לדחות, אך הזמן חולף. ${t}.`,
    (t) => `שאל את עצמך: האם הגיע הזמן ל${t}? (התשובה היא כן)`,
  ],
  frayer: [
    (t) => `תכל'ס: ${t}. שתי שניות וסגרת פינה.`,
    (t) => `רק ${t} ונגמר הסיפור.`,
    (t) => `סגור פינה: ${t}.`,
    (t) => `אל תסבך עניינים. פשוט תעשה ${t}.`,
    (t) => `תזכורת תכל'ס: ${t}. יאללה לסיים.`,
    (t) => `אמרת, עשית. ${t}.`,
    (t) => `יאללה לתפור את זה: ${t}.`,
  ],
  neighbor: [
    (t) => `היי שכן, רק מזכיר: ${t} 😏`,
    (t) => `שכן, ${t}, לפני שאני צריך להזכיר שוב.`,
    (t) => `שומע? תזכורת זריזה: ${t}.`,
    (t) => `דופק בדלת להזכיר לך: ${t}.`,
    (t) => `אני לא מציק בדרך כלל, אבל הגיע הזמן ל${t}.`,
    (t) => `יש לך שנייה? ${t} מחכה.`,
    (t) => `רק קפצתי לוודא שלא שכחת מ${t}.`,
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
  (base: string) => `שוב אני: ${base}`,
  (base: string) => `עדיין מחכה: ${base}`,
  (base: string) => `היי, מנדנד קצת: ${base}`,
  (base: string) => `סליחה על החפירה, אבל: ${base}`,
  (base: string) => `אני עקשן. ${base}`,
  (base: string) => `שעון החול מתקתק... ${base}`,
];

function buildNudgeMessage(base: string): string {
  return NUDGE_PREFIXES[Math.floor(Math.random() * NUDGE_PREFIXES.length)](base);
}

// Done / snooze buttons on every reminder; the follow-up nudge only happens when confirm_needed.
function keyboardForReminder(id: string) {
  return {
    inline_keyboard: [[
      { text: "✅ סיימתי", callback_data: `done_reminder_${id}` },
      { text: "⏰ עוד 15 דק'", callback_data: `snooze_${id}` },
    ]],
  };
}

async function generateNaturalReminder(personality: string, text: string, isNudge: boolean, gender?: string, name?: string): Promise<string> {
  const genderInstruction = gender === "female"
    ? "The user is FEMALE. You MUST address her in Hebrew strictly in FEMININE form (e.g. את, תעשי, תזכרי, הלכת)."
    : "The user is MALE. You MUST address him in Hebrew strictly in MASCULINE form (e.g. אתה, תעשה, תזכור, הלכת).";
  const nameInstruction = name ? `The user's name is '${name}'. You may include their name naturally.` : "";
  const prompt = `You are an Israeli assistant with personality '${personality}'.
Your task is to generate a natural, flowing Hebrew sentence to remind the user about their task: '${text}'.
${genderInstruction}
${nameInstruction}
Do NOT use colons (:) or robotic formats like 'תזכורת: לקחת כדור'. Integrate the task naturally.
${isNudge ? "This is a NUDGE because they didn't confirm the first time. Be a bit more insistent." : "This is the first reminder."}
Keep it short, max 1-2 sentences. Output ONLY the Hebrew text.`;
  return (await gemini(prompt, 200)).replace(/\*\*/g, "");
}

let weatherCache: { at: number; precip: number; temp: number } | null = null;

async function checkWeatherCondition(condition: string): Promise<boolean> {
  try {
    if (!weatherCache || Date.now() - weatherCache.at > 30 * 60_000) {
      const res = await fetch("https://api.open-meteo.com/v1/forecast?latitude=32.08&longitude=34.78&daily=precipitation_sum,temperature_2m_max&timezone=Asia%2FJerusalem");
      if (!res.ok) return true; // fail open: better to remind than to silently skip
      const data = await res.json();
      weatherCache = { at: Date.now(), precip: data.daily?.precipitation_sum?.[0] ?? 0, temp: data.daily?.temperature_2m_max?.[0] ?? 25 };
    }
    const c = condition.toLowerCase();
    if (c === "rain") return weatherCache.precip > 0.5;
    if (c === "clear") return weatherCache.precip <= 0.5;
    if (c === "hot") return weatherCache.temp > 28;
    if (c === "cold") return weatherCache.temp < 18;
    return true;
  } catch (e) {
    console.error("[weather] check failed:", e);
    return true;
  }
}

async function allChatIds(): Promise<number[]> {
  const { data } = await supabase.from("users").select("chat_id");
  return (data ?? []).map((u: { chat_id: number }) => u.chat_id);
}

// Periodic broadcasts. Each runs once per period thanks to runOnce(), so a delayed or
// skipped cron minute no longer means the job is missed (old code required minute === 0).
async function runPeriodicJobs(now: Date) {
  const il = israelParts(now);

  // Weekly quick-notes review: Sunday from 09:00
  if (il.weekday === 0 && il.hour >= 9 && il.hour < 21 && await runOnce(supabase, `weekly_notes:${il.date}`)) {
    for (const chatId of await allChatIds()) {
      const { data: notes } = await supabase.from("quick_notes").select("id, text").eq("chat_id", chatId).eq("active", true);
      if (notes?.length) {
        const note = notes[Math.floor(Math.random() * notes.length)];
        await sendHtml(chatId, `💡 <b>הפינה השבועית: מגירת הרעיונות</b>\n\nפעם כתבת לי את הרעיון הזה:\n"${escapeHtml(note.text)}"\n\nרוצה שנקבע לזה תזכורת או נשאיר את זה במגירה? (אם בא לך לקדם את זה, פשוט תגיד לי "תזכיר לי על הרעיון הזה מחר ב-10")`);
      }
    }
  }

  // Jewish holidays: daily from 10:00
  if (il.hour >= 10 && il.hour < 21 && await runOnce(supabase, `holidays:${il.date}`)) {
    try {
      const res = await fetch(`https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&i=on&year=${il.year}`);
      if (res.ok) {
        const data = await res.json();
        const tomorrow = israelParts(new Date(now.getTime() + 86_400_000)).date;
        const holidays = (data.items ?? []).filter((item: any) => item.date === tomorrow && item.category === "holiday");
        if (holidays.length) {
          const names = escapeHtml(holidays.map((h: any) => h.hebrew).join(" ו-"));
          for (const chatId of await allChatIds()) {
            await sendHtml(chatId, `🍎 <b>תזכורת מועדי ישראל:</b>\nמחר יחול ${names}!\nשלא תגיד שלא אמרתי לך להתארגן.`);
          }
        }
      }
    } catch (e) {
      console.error("[hebcal] failed:", e);
    }
  }

  // Weekly procrastination review: Thursday from 18:00
  if (il.weekday === 4 && il.hour >= 18 && il.hour < 22 && await runOnce(supabase, `procrastination:${il.date}`)) {
    for (const chatId of await allChatIds()) {
      const { data: stuck } = await supabase.from("reminders").select("id, text, snooze_count").eq("chat_id", chatId).eq("active", true).gte("snooze_count", 3);
      if (stuck?.length) {
        const list = stuck.map((r: any) => `• ${escapeHtml(r.text)} (${r.snooze_count} דחיות)`).join("\n");
        await sendHtml(chatId, `⚠️ <b>פינת הדחיינות השבועית</b>\n\nשמתי לב שממש נתקעת על המשימות האלה:\n${list}\n\nרוצה שנפרק אותן לצעדים קטנים יותר או פשוט נמחק ונוותר עליהן? אין בושה בלשחרר!`);
      }
    }
  }

  // Random banter for users silent > 48h: from 16:00, at most once a week per user
  // (proactive-checkin also nudges silent users; last_proactive_at keeps them from piling up).
  if (il.hour >= 16 && il.hour < 20 && await runOnce(supabase, `banter:${il.date}`)) {
    const silentSince = new Date(now.getTime() - 48 * 3_600_000).toISOString();
    const { data: inactive } = await supabase.from("users").select("chat_id, personality, last_proactive_at").lt("last_message_at", silentSince);
    for (const user of inactive ?? []) {
      if (user.last_proactive_at && now.getTime() - new Date(user.last_proactive_at).getTime() < 7 * 86_400_000) continue;
      const p = user.personality || "cynic";
      let banter = [
        "תגיד, לאן נעלמת? אני מדבר פה עם הקירות.",
        "סתם עברתי בשכונה הווירטואלית וחשבתי לבדוק אם אתה עדיין חי.",
      ];
      if (p === "grandma") banter = ["כפרה, לא שמעתי ממך כמה ימים. אכלת משהו היום?", "נעלמת לי. אם לא תכתוב לי משהו אני באה עם סיר קציצות."];
      else if (p === "coach" || p === "sergeant") banter = ["כמה ימים שקט. אני מקווה שזה בגלל שאתה עובד קשה ולא בגלל שויתרת.", "אפס דיווחים. חזור לשגרה מיד."];
      else if (p === "therapist") banter = ["היי, שמתי לב שהתרחקת קצת. הכל בסדר?", "רק רציתי לשלוח אנרגיות טובות. קח את הזמן שלך."];
      else if (p === "friend" || p === "hype") banter = ["אחיייי לאן נעלמת?? מתגעגע פה!", "יאללה בוא נדבר מה קורה איתך!"];
      if (await sendHtml(user.chat_id, escapeHtml(banter[Math.floor(Math.random() * banter.length)]))) {
        await supabase.from("users").update({ last_proactive_at: now.toISOString() }).eq("chat_id", user.chat_id);
      }
    }
  }

  // Countdown pins: refresh once per hour
  if (await runOnce(supabase, `countdowns:${il.date}T${il.hour}`)) {
    const { data: countdowns } = await supabase.from("countdowns").select("*").eq("active", true);
    for (const cd of countdowns ?? []) {
      const diffMs = new Date(cd.target_date).getTime() - now.getTime();
      const title = escapeHtml(cd.title);
      if (diffMs <= 0) {
        await editHtml(cd.chat_id, cd.message_id, `🎉 <b>הגיע הזמן: ${title}</b>!`);
        await supabase.from("countdowns").update({ active: false }).eq("id", cd.id);
      } else {
        const days = Math.floor(diffMs / 86_400_000);
        const hours = Math.floor((diffMs / 3_600_000) % 24);
        await editHtml(cd.chat_id, cd.message_id, `⏳ <b>ספירה לאחור: ${title}</b>\n${days > 0 ? `נותרו: ${days} ימים ו-${hours} שעות.` : `נותרו: ${hours} שעות בלבד!`}`);
      }
    }
  }
}

async function processReminder(reminder: Reminder, users: Map<number, any>, now: Date): Promise<"sent" | "skipped" | "failed"> {
  // Claim the reminder by pushing its time forward a few minutes. If another run already
  // claimed it (time changed), the conditional update matches nothing and we skip it.
  // If sending fails, the lease simply expires and the next run retries.
  const lease = new Date(now.getTime() + 3 * 60_000).toISOString();
  const { data: claimed } = await supabase.from("reminders").update({ time: lease }).eq("id", reminder.id).eq("time", reminder.time).eq("active", true).select("id");
  if (!claimed?.length) return "skipped";

  const recurring = reminder.type !== "once";
  const nextTime = recurring ? advanceRecurring(new Date(reminder.time), reminder.type) : null;

  if (reminder.weather_condition && !(await checkWeatherCondition(reminder.weather_condition))) {
    if (recurring) await supabase.from("reminders").update({ time: nextTime!.toISOString(), nudge_sent_at: null }).eq("id", reminder.id);
    else await supabase.from("reminders").update({ active: false }).eq("id", reminder.id);
    return "skipped";
  }

  const user = users.get(reminder.chat_id) ?? {};
  const personality = user.personality ?? "cynic";
  const needsConfirmation = reminder.confirm_needed === true;
  const isNudge = needsConfirmation && Boolean(reminder.nudge_sent_at);

  let message = await generateNaturalReminder(personality, reminder.text, isNudge, user.gender ?? "male", user.first_name ?? "");
  if (!message) {
    const base = buildReminderMessage(personality, reminder.text);
    message = isNudge ? buildNudgeMessage(base) : base;
  }
  const html = toTelegramHtml(message);
  const keyboard = keyboardForReminder(reminder.id);

  // Same rate limit as chat replies: a GIF at most every few hours, and only sometimes.
  const gifUrl = await gifAllowed(supabase, reminder.chat_id, 0.3) ? await fetchGifForTask(reminder.text, personality, message) : null;
  let success = gifUrl ? await sendAnimation(reminder.chat_id, gifUrl, html, keyboard) : false;
  if (success) await markGifSent(supabase, reminder.chat_id);
  if (!success) success = await sendHtml(reminder.chat_id, html, keyboard);
  if (!success) {
    // Restore the original time so the next run retries right away.
    await supabase.from("reminders").update({ time: reminder.time }).eq("id", reminder.id).eq("time", lease);
    return "failed";
  }

  if (needsConfirmation && !isNudge && reminder.type === "once") {
    // Ask again in 20 minutes unless the user presses ✅.
    await supabase.from("reminders").update({ nudge_sent_at: now.toISOString(), time: new Date(now.getTime() + 20 * 60_000).toISOString() }).eq("id", reminder.id);
  } else if (!recurring) {
    await supabase.from("reminders").update({ active: false }).eq("id", reminder.id);
  } else {
    await supabase.from("reminders").update({ time: nextTime!.toISOString(), nudge_sent_at: null, last_sent_at: now.toISOString() }).eq("id", reminder.id);
  }
  return "sent";
}

Deno.serve(async (req: Request) => {
  if (!(await isCronAuthorized(req, supabase))) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
  }
  try {
    const now = new Date();
    try {
      await runPeriodicJobs(now);
    } catch (error) {
      console.error("[check-reminders] periodic jobs failed:", error);
    }

    const { data: due, error } = await supabase
      .from("reminders")
      .select("id, chat_id, text, type, time, active, confirm_needed, nudge_sent_at, weather_condition")
      .eq("active", true)
      .lte("time", now.toISOString())
      .order("time")
      .limit(50);
    if (error) {
      console.error("[check-reminders] query failed:", error.message);
      return new Response(JSON.stringify({ ok: false }), { status: 200 });
    }
    if (!due?.length) return new Response(JSON.stringify({ ok: true, sent: 0 }), { status: 200 });

    const reminders = due as Reminder[];
    const chatIds = [...new Set(reminders.map((r) => r.chat_id))];
    const { data: users } = await supabase.from("users").select("chat_id, personality, gender, first_name").in("chat_id", chatIds);
    const userMap = new Map<number, any>((users ?? []).map((u: any) => [u.chat_id, u]));

    let sent = 0, failed = 0, skipped = 0;
    for (const reminder of reminders) {
      try {
        const result = await processReminder(reminder, userMap, now);
        if (result === "sent") sent++; else if (result === "failed") failed++; else skipped++;
      } catch (error) {
        console.error(`[check-reminders] reminder ${reminder.id} exception:`, error);
        failed++;
      }
    }
    return new Response(JSON.stringify({ ok: true, sent, failed, skipped }), { status: 200 });
  } catch (error) {
    console.error("[check-reminders] fatal:", error);
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
});
