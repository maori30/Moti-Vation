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
  weather_condition?: string | null;
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
      const errTxt = await response.text(); await supabase.from("messages").insert({ chat_id: chatId, role: "system", content: "DEBUG check-reminders send msg failed: " + response.status + " " + errTxt }); return false;
      return false;
    }
    return true;
  } catch (error) {
    console.error("[check-reminders] Telegram text exception:", error);
    return false;
  }
}

async function editTelegramMessageText(chatId: number, messageId: number, text: string): Promise<boolean> {
  try {
    const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" };
    const response = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error(`[check-reminders] Telegram edit ${response.status}: ${(await response.text()).slice(0, 300)}`); return false;
      return false;
    }
    return true;
  } catch (error) {
    console.error("[check-reminders] Telegram edit exception:", error);
    return false;
  }
}

async function sendTelegramAnimation(chatId: number, animationUrl: string, caption: string, keyboard?: object): Promise<boolean> {
  try {
    const body: Record<string, unknown> = { chat_id: chatId, animation: animationUrl, caption, parse_mode: "HTML" };
    if (keyboard) body.reply_markup = keyboard;
    const response = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendAnimation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error(`[check-reminders] Telegram anim ${response.status}: ${(await response.text()).slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[check-reminders] Telegram anim exception:", error);
    return false;
  }
}

const GIPHY_API_KEY = Deno.env.get("GIPHY_API_KEY") ?? "";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";

async function fetchGifForTask(task: string, personality: string, botMessage: string): Promise<string | null> {
  if (!GIPHY_API_KEY) return null;
  try {
    let englishQuery = "motivation";
    if (GEMINI_API_KEY) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
      const prompt = `You are a bot with personality '${personality}'.
You just sent the user this message: "${botMessage}"
For the task: "${task}"
Generate a short (1-3 words) English search query for Giphy that perfectly matches the emotion, tone, and context of your message. 
For example, if you are cynical and sarcastic, maybe "rolling eyes" or "whatever". If you are a strict coach, maybe "yelling coach" or "do it now".
Return ONLY the english keywords, nothing else.`;
      const aiRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 10 }
        })
      });
      if (aiRes.ok) {
        const data = await aiRes.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) englishQuery = text;
      }
    }

    let query = encodeURIComponent(englishQuery);
    let url = `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${query}&limit=5`;
    let res = await fetch(url);
    let data = res.ok ? await res.json() : null;
    
    // Fallback if no results
    if (!data?.data?.length) {
      const fallbacks = ["just do it", "motivation", "you can do it", "get to work", "do it now"];
      const randomFallback = fallbacks[Math.floor(Math.random() * fallbacks.length)];
      query = encodeURIComponent(randomFallback);
      url = `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${query}&limit=10`;
      res = await fetch(url);
      data = res.ok ? await res.json() : null;
    }
    
    if (!data?.data?.length) return null;
    const randomGif = data.data[Math.floor(Math.random() * data.data.length)];
    return randomGif?.images?.original?.url || null;
  } catch (e) {
    console.error("[check-reminders] Giphy failed", e);
    return null;
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
  (base: string) => `אני לא אומר שאתה מתעלם, אבל ${base}`,
  (base: string) => `שוב אני: ${base}`,
  (base: string) => `עדיין מחכה: ${base}`,
  (base: string) => `תזכורת חוזרת (כי למה לא?): ${base}`,
  (base: string) => `היי, מנדנד קצת: ${base}`,
  (base: string) => `סליחה על החפירה, אבל: ${base}`,
  (base: string) => `עדכון סטטוס: עדיין לא עשית את זה. ${base}`,
  (base: string) => `אני עקשן. ${base}`,
  (base: string) => `שעון החול מתקתק... ${base}`,
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
    
    // Weekly Quick Notes Review: Sunday at 09:00 IL time
    const ilTime = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
    if (ilTime.getDay() === 0 && ilTime.getHours() === 9 && ilTime.getMinutes() === 0) {
      const { data: usersData } = await supabase.from("users").select("chat_id");
      if (usersData) {
        for (const user of usersData) {
          const { data: notes } = await supabase.from("quick_notes").select("id, text").eq("chat_id", user.chat_id).eq("active", true);
          if (notes && notes.length > 0) {
            const randomNote = notes[Math.floor(Math.random() * notes.length)];
            const message = `💡 **הפינה השבועית: מגירת הרעיונות**\n\nפעם כתבת לי את הרעיון הזה:\n"${randomNote.text}"\n\nרוצה שנקבע לזה תזכורת או נשאיר את זה במגירה? (אם בא לך לקדם את זה, פשוט תגיד לי "תזכיר לי על הרעיון הזה מחר ב-10")`;
            await sendTelegramMessage(user.chat_id, message);
          }
        }
      }
    }
    
    // Daily Jewish Holidays Check: Every day at 10:00 IL time
    if (ilTime.getHours() === 10 && ilTime.getMinutes() === 0) {
      try {
        const res = await fetch("https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&year=now");
        if (res.ok) {
          const data = await res.json();
          // Get tomorrow's date string in YYYY-MM-DD format (Israel Time)
          const tomorrowStr = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 86400000));
          
          const holidays = data.items?.filter((item: any) => item.date === tomorrowStr && item.category === "holiday");
          if (holidays && holidays.length > 0) {
            const holidayNames = holidays.map((h: any) => h.hebrew).join(" ו-");
            const message = `🍎 **תזכורת מועדי ישראל:**\nמחר יחול ${holidayNames}!\nשלא תגיד שלא אמרתי לך להתארגן.`;
            
            const { data: usersData } = await supabase.from("users").select("chat_id");
            if (usersData) {
              for (const user of usersData) {
                await sendTelegramMessage(user.chat_id, message);
              }
            }
          }
        }
      } catch (e) {
        console.error("[hebcal] failed:", e);
      }
    }
    
    // Weekly Procrastination Review: Thursday at 18:00 IL time
    if (ilTime.getDay() === 4 && ilTime.getHours() === 18 && ilTime.getMinutes() === 0) {
      const { data: usersData } = await supabase.from("users").select("chat_id");
      if (usersData) {
        for (const user of usersData) {
          const { data: stuck } = await supabase.from("reminders").select("id, text, snooze_count").eq("chat_id", user.chat_id).eq("active", true).gte("snooze_count", 3);
          if (stuck && stuck.length > 0) {
            const list = stuck.map(r => `• ${r.text} (${r.snooze_count} דחיות)`).join("\n");
            await sendTelegramMessage(user.chat_id, `⚠️ **פינת הדחיינות השבועית**\n\nשמתי לב שממש נתקעת על המשימות האלה:\n${list}\n\nרוצה שנפרק אותן לצעדים קטנים יותר או פשוט נמחק ונוותר עליהן? אין בושה בלשחרר!`);
          }
        }
      }
    }
    // Process Follow-ups
    const { data: followUps } = await supabase.from("follow_ups").select("id, chat_id, topic, question").eq("active", true).lte("due_at", now.toISOString());
    if (followUps && followUps.length > 0) {
      for (const fu of followUps) {
        await sendTelegramMessage(fu.chat_id, `היי! שאלה קטנה: לגבי ${fu.topic} - ${fu.question}`);
        await supabase.from("follow_ups").update({ active: false }).eq("id", fu.id);
      }
    }

    // Daily Random Banter: 16:00 IL time
    if (ilTime.getHours() === 16 && ilTime.getMinutes() === 0) {
      const { data: inactiveUsers } = await supabase.from("users").select("chat_id, personality").lt("last_message_at", new Date(now.getTime() - 48 * 3600000).toISOString());
      if (inactiveUsers && inactiveUsers.length > 0) {
        for (const user of inactiveUsers) {
          const p = user.personality || "cynic";
          let banterList = [
            "תגיד, לאן נעלמת? אני מדבר פה עם הקירות.",
            "שמע, הייתי חייב לשאול – גם אתה מרגיש שזה יום די מיותר היום? או שזה רק אני?",
            "סתם עברתי בשכונה הווירטואלית וחשבתי לבדוק אם אתה עדיין חי.",
          ];
          if (p === "grandma") {
            banterList = ["כפרה, לא שמעתי ממך יומיים. אכלת משהו היום?", "חיים של סבתא, הכל בסדר? אתה מסנן אותי כמו הנכדים האמיתיים שלי.", "נעלמת לי. אם לא תכתוב לי משהו אני באה עם סיר קציצות."];
          } else if (p === "coach" || p === "sergeant") {
            banterList = ["יומיים שקט. אני מקווה שזה בגלל שאתה עובד קשה ולא בגלל שויתרת.", "איפה נעלמת? צא מאזור הנוחות שלך ובוא לעדכן מה קורה.", "אפס דיווחים 48 שעות. חזור לשגרה מיד."];
          } else if (p === "therapist") {
            banterList = ["היי, שמתי לב שהתרחקת קצת. הכל בסדר במרחב האישי שלך?", "לפעמים שתיקה אומרת המון. איך אתה מרגיש היום?", "רק רציתי לשלוח אנרגיות טובות. קח את הזמן שלך."];
          } else if (p === "friend" || p === "hype") {
            banterList = ["אחיייי לאן נעלמת?? מתגעגע פה!", "יוו עברו יומיים, תן איזה סימן חיים כפרה!", "יאללה בוא נדבר מה קורה איתך, משעמם פה טילים!"];
          }
          const msg = banterList[Math.floor(Math.random() * banterList.length)];
          await sendTelegramMessage(user.chat_id, msg);
        }
      }
    }

    // Hourly Countdowns Update: At minute 0 of every hour
    if (now.getMinutes() === 0) {
      const { data: countdowns } = await supabase.from("countdowns").select("*").eq("active", true);
      if (countdowns) {
        for (const cd of countdowns) {
          const target = new Date(cd.target_date);
          const diffMs = target.getTime() - now.getTime();
          
          if (diffMs <= 0) {
            await editTelegramMessageText(cd.chat_id, cd.message_id, `🎉 **הגיע הזמן: ${cd.title}**!`);
            await supabase.from("countdowns").update({ active: false }).eq("id", cd.id);
          } else {
            const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diffMs / (1000 * 60 * 60)) % 24);
            let text = `⏳ **ספירה לאחור: ${cd.title}**\n`;
            if (days > 0) text += `נותרו: ${days} ימים ו-${hours} שעות.`;
            else text += `נותרו: ${hours} שעות בלבד!`;
            
            await editTelegramMessageText(cd.chat_id, cd.message_id, text);
          }
        }
      }
    }
    const { data: due, error } = await supabase
      .from("reminders")
      .select("id, chat_id, text, type, time, active, confirm_needed, nudge_sent_at, weather_condition")
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

async function generateNaturalReminder(apiKey: string, personality: string, text: string, isNudge: boolean): Promise<string> {
  if (!apiKey) return "";
  const systemPrompt = "You are an Israeli assistant with personality '" + personality + "'. 
Your task is to generate a natural, flowing Hebrew sentence to remind the user about their task: '" + text + "'.
Do NOT use colons (:) or robotic formats like 'תזכורת: לקחת כדור'. Integrate the task naturally.
" + (isNudge ? "This is a NUDGE because they didn't confirm the first time. Be a bit more insistent." : "This is the first reminder.") + "
Keep it short, max 1-2 sentences. Output ONLY the Hebrew text.";

  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=" + apiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: systemPrompt }] }]
      })
    });
    if (res.ok) {
      const data = await res.json();
      let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
      rawText = rawText.replace(/\*\*/g, ""); // strip markdown bold
      rawText = rawText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); // escape HTML for Telegram
      return rawText;
    }
    return "";
  } catch (e) {
    return "";
  }
}

async function checkWeatherCondition(condition: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.open-meteo.com/v1/forecast?latitude=32.08&longitude=34.78&daily=precipitation_sum,temperature_2m_max&timezone=Asia%2FJerusalem");
    if (!res.ok) return true; // Default to true if API fails
    const data = await res.json();
    const todayPrecip = data.daily?.precipitation_sum?.[0] || 0;
    const todayTemp = data.daily?.temperature_2m_max?.[0] || 25;
    
    if (condition.toLowerCase() === "rain") return todayPrecip > 0.5;
    if (condition.toLowerCase() === "clear") return todayPrecip <= 0.5;
    if (condition.toLowerCase() === "hot") return todayTemp > 28;
    if (condition.toLowerCase() === "cold") return todayTemp < 18;
    return true; // Unrecognized condition
  } catch (e) {
    console.error("[weather] check failed:", e);
    return true;
  }
}

    let sent = 0; let failed = 0;

    for (const reminder of reminders) {
      try {
        if (reminder.weather_condition) {
          const conditionMet = await checkWeatherCondition(reminder.weather_condition);
          if (!conditionMet) {
            // Weather condition not met, skip and advance/deactivate
            if (reminder.type === "once") {
              await supabase.from("reminders").update({ active: false }).eq("id", reminder.id);
            } else {
              const nextTime = new Date(new Date(reminder.time).getTime() + (reminder.type === "weekly" ? 7 : 1) * 86400000);
              await supabase.from("reminders").update({ time: nextTime.toISOString() }).eq("id", reminder.id);
            }
            continue;
          }
        }
        const personality = personalities.get(reminder.chat_id) ?? "cynic";
        const needsConfirmation = reminder.confirm_needed === true;
        const isNudge = needsConfirmation && Boolean(reminder.nudge_sent_at);
        let message = await generateNaturalReminder(Deno.env.get("GEMINI_API_KEY") || "", personality, reminder.text, isNudge);
        if (!message) {
          const base = buildReminderMessage(personality, reminder.text);
          message = isNudge ? buildNudgeMessage(base) : base;
        }

        const gifUrl = await fetchGifForTask(reminder.text, personality, message);
        const keyboard = keyboardForReminder(reminder.id, needsConfirmation);
        
        let success = false;
        if (gifUrl) {
          success = await sendTelegramAnimation(reminder.chat_id, gifUrl, message, keyboard);
          // Fallback to text if animation sending fails
          if (!success) success = await sendTelegramMessage(reminder.chat_id, message, keyboard);
        } else {
          success = await sendTelegramMessage(reminder.chat_id, message, keyboard);
        }

        if (!success) {
          await supabase.from("messages").insert({ chat_id: reminder.chat_id, role: "system", content: "DEBUG failure inside loop!" }); failed++; continue;
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
        console.error(`[check-reminders] reminder ${reminder.id} failed:`, error); await supabase.from("messages").insert({ chat_id: reminder.chat_id, role: "system", content: "DEBUG exception: " + String(error) }); failed++; 
      }
    }

    return new Response(JSON.stringify({ ok: true, sent, failed }), { status: 200 });
  } catch (error) {
    console.error("[check-reminders] fatal:", error);
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
});


