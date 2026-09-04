import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  anchorMemoryKeyFor,
  anchorQuestion,
  coreferenceInstruction,
  detectSwitchRequest,
  fetchMemories,
  followUpNudge,
  forgetMemories,
  humorPolicy,
  memoryContext,
  moodInstruction,
  moodLabel,
  naturalize,
  parseSmartHints,
  pickMood,
  runExtraction,
  scheduleFollowUps,
  toneOverrideInstruction,
  upsertMemories,
  type Memory,
  type Mood,
} from "./brain.ts";
import {
  blendInstruction,
  currentBlend,
  decisionEngine,
  detectGoalStatement,
  evolveBlend,
  fetchGoals,
  fetchProfile,
  goalContext,
  isLaugh,
  isShortReply,
  learnFromBehavior,
  linkedReasoning,
  logBehavior,
  pacing as computePacing,
  profileContext,
  runProfileExtraction,
  saveProfile,
  selfCorrectionLayer,
  upsertGoals,
  type Profile,
} from "./profile.ts";
import {
  antiRepetitionInstruction,
  bumpInsideJokes,
  confidenceContext,
  detectDeepMode,
  deepModeInstruction,
  eventContext,
  fetchEvents,
  fetchInsideJokes,
  fetchRecentPhrases,
  humanityCheck,
  implicitIntentLayer,
  insideJokeContext,
  isRepetitive,
  rankMemories,
  rememberPhrase,
  rewriteForHumanity,
  rollSurprise,
  runAwarenessExtraction,
  runForgettingEngine,
  surpriseInstruction,
  upsertEvents,
} from "./awareness.ts";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const TZ = Deno.env.get("BOT_TIMEZONE") ?? "Asia/Jerusalem";

const HISTORY_LIMIT = 10;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

type HistoryMessage = { role: string; content: string; created_at?: string };
type ParsedReminder = { dueAt: Date; task: string; type: "once" | "daily" | "weekly" };
type ActiveReminder = { id: string; text: string; type: string; time: string };

const PERSONALITIES: Record<string, { name: string; emoji: string; prompt: string }> = {
  coach: {
    name: "המאמן",
    emoji: "🧠",
    prompt:
      "אתה מאמן אישי ישראלי חד, מהיר ותכל'סי. בלי נאומים ארוכים, דוחף לנעול שעה ומשימה בצורה ברורה וחמה.",
  },
  cynic: {
    name: "הציני",
    emoji: "😈",
    prompt:
      "אתה שנון, ציני חד, מלא אסוציאציות (שירים, תרבות, סלנג ישראלי, בדיחות על דחיינות). לא פראייר של תירוצים ('הכל פתוח עוד לא מאוחר -> גידי גוב בגרסה החולה'). עונה בעקיצה חדה אבל נשאר חבר שאכפת לו באמת. תמיד מנווט לסגור שעה או משימה קונקרטית.",
  },
  friend: {
    name: "החבר",
    emoji: "🤗",
    prompt:
      "אתה חבר טוב מקבוצת וואטסאפ. מקשיב באמת, משתמש בשפה יומיומית, מצחיק וזורם, ויודע מתי ללחוץ בחיוך.",
  },
  sergeant: {
    name: "הרס\"ר",
    emoji: "🪖",
    prompt:
      "אתה רס\"ר יבש, קצר וממוקד. פעולה לפני תירוצים, בלי השפלות ובלי מריחות.",
  },
  therapist: {
    name: "המטפל",
    emoji: "🛋️",
    prompt:
      "אתה קשוב ועדין. שואל שאלה אחת שמדייקת רגש ולא מעמיס שאלות.",
  },
  hype: {
    name: "המעודד",
    emoji: "🔥",
    prompt:
      "אתה אנרגטי וחוגג ניצחונות קטנים בלי להעיק. אימוג'י אחד ומספיק.",
  },
  grandma: {
    name: "הסבתא",
    emoji: "👵",
    prompt:
      "את סבתא חמה שדואגת לבריאות, אוכל ומנוחה. אף פעם לא צוחקת על בעיה רפואית.",
  },
  philosopher: {
    name: "הפילוסוף",
    emoji: "🧐",
    prompt:
      "אתה קצר ומעורר מחשבה. שואל שאלה אחת טובה ולא מרצה הרצאות.",
  },
  frayer: {
    name: "הפראייר",
    emoji: "😏",
    prompt:
      "אתה ישראלי תכל'סי. מדבר פשוט, בלי שפה עסקית ובלי חפירות.",
  },
  neighbor: {
    name: "השכן",
    emoji: "🏠",
    prompt:
      "אתה שכן חביב עם תחרותיות משועשעת וחיוך קבוע.",
  },
};

const GREETINGS: Record<string, string> = {
  coach: "🧠 כאן. מה עובר עליך היום?",
  cynic: "😈 אה, שוב אתה. מה קורה?",
  friend: "🤗 שמח שכתבת. מה קורה אצלך?",
  sergeant: "🪖 דווח. מה הסטטוס?",
  therapist: "🛋️ שלום. במה תרצה להתחיל?",
  hype: "🔥 הגעת! מה קורה?",
  grandma: "👵 אוי, מה נשמע? אכלת?",
  philosopher: "🧐 מה הביא אותך לכאן דווקא עכשיו?",
  frayer: "😏 תכל'ס, מה על השולחן?",
  neighbor: "🏠 היי שכן, מה נשמע?",
};

const DONEREPLIES: Record<string, string[]> = {
  coach: ["יפה, סימנת. עוד ניצחון קטן על הרשימה 💪", "זהו, ירד מהראש. קדימה לדבר הבא."],
  cynic: ["יופי, המצפון שלי שקט. בלעת כבר או שאתה עדיין במופע סטנדאפ? 😏", "טוב, אז בסוף כן. מי היה מאמין."],
  friend: ["יש! כל הכבוד 🤗", "סימנת, אלוף. אחת פחות בראש."],
  sergeant: ["בוצע. תודה על הדיווח.", "אישור התקבל. הבא בתור."],
  therapist: ["יפה שסימנת. איך זה הרגיש?", "כל הכבוד שסגרת את זה."],
  hype: ["כן!! עשית את זה 🔥", "יאללה, עוד ניצחון!"],
  grandma: ["יופי מותק, כל הכבוד.", "נו סוף סוף, יפה שלך."],
  philosopher: ["פעולה קטנה, אבל היא נספרת.", "סימנת. זה כל מה שנדרש."],
  frayer: ["תכל'ס, סגרת. יאללה.", "פינה סגורה, ממשיכים."],
  neighbor: ["כל הכבוד שכן, הקדמת אותי הפעם 😏", "סימנת! נקודה לזכותך."],
};

const SNOOZEREPLIES: Record<string, string[]> = {
  coach: ["בסדר, עוד 15 דק' ואז יאללה.", "קיבלתי, נדבר עוד רגע."],
  cynic: ["כן כן, עוד 15 דקות. דחיינות רשמית.", "אוקיי, נותן לך רבע שעה ואני חוזר לטרטר."],
  friend: ["סבבה, מזכיר לך עוד רבע שעה 🤗", "אין בעיה, עוד 15 דק' ונדבר."],
  sergeant: ["אישור. 15 דקות ואז שוב.", "נדחה ב-15. לא יותר."],
  therapist: ["בטח, קח את הזמן. אזכיר עוד רבע שעה.", "בסדר, נחזור לזה."],
  hype: ["יאללה, עוד 15 דק' וחוזרים לענייננו 🔥", "סבבה, נדבר עוד רגע!"],
  grandma: ["בסדר מותק, עוד קצת ונזכיר לך.", "טוב טוב, עוד רבע שעה."],
  philosopher: ["הזמן ימשיך לזרום, ניפגש בו עוד 15 דק'.", "נעצור וניפגש שוב בקרוב."],
  frayer: ["סבבה, עוד רבע שעה וממשיכים.", "אין קטע, 15 דק' ונדבר."],
  neighbor: ["טוב שכן, עוד רבע שעה ואני שוב כאן 😏", "בסדר, נראה אותך עוד 15 דק'."],
};

const REMINDERCREATEDREPLIES: Record<string, Array<(task: string, label: string) => string>> = {
  coach: [
    (t, l) => `סגרנו. ${l} אני מזכיר לך ${t}.`,
    (t, l) => `רשום. ${l}, ${t}. קדימה 💪`,
  ],
  cynic: [
    (t, l) => `קבעתי לך ${l}, ${t}. תהיה בריא 😏`,
    (t, l) => `רשמתי. ${l} נבדוק אם עמדת במילה שלך לגבי ${t}.`,
  ],
  friend: [
    (t, l) => `סבבה, ${l} אני מזכיר לך ${t} 🤗`,
    (t, l) => `רשמתי אחי. ${l} תשמע ממני על ${t}.`,
  ],
  sergeant: [
    (t, l) => `נרשם. ${l}, משימה: ${t}.`,
    (t, l) => `אישור. ${l} אני מזכיר לך ${t}.`,
  ],
  therapist: [
    (t, l) => `רשמתי לי את זה. ${l} אזכיר לך ${t}, בלי לחץ.`,
    (t, l) => `בסדר, שמרתי. ${l} נחזור ל${t}.`,
  ],
  hype: [
    (t, l) => `יאללה, רשמתי! ${l} מזכיר לך ${t} 🔥`,
    (t, l) => `זהו, נרשם! ${l} נעשה את ${t}.`,
  ],
  grandma: [
    (t, l) => `רשמתי מותק. ${l} אני אזכיר לך ${t}.`,
    (t, l) => `טוב טוב, שמרתי. ${l}, נו, ${t}.`,
  ],
  philosopher: [
    (t, l) => `נרשם. ${l} נחזור ל${t}.`,
    (t, l) => `שמרתי את זה. ${l}, ${t}.`,
  ],
  frayer: [
    (t, l) => `סגור. ${l} אני מזכיר לך ${t}.`,
    (t, l) => `רשמתי. ${l} זה אצלך — ${t}.`,
  ],
  neighbor: [
    (t, l) => `רשמתי שכן. ${l} אני על ${t} 😏`,
    (t, l) => `סגור. ${l} אני מזכיר לך על ${t}.`,
  ],
};

function pickPersonalized(map: Record<string, string[]>, personality: string): string {
  const options = map[personality] ?? map.friend;
  return options[Math.floor(Math.random() * options.length)];
}

function pickReminderCreated(personality: string, task: string, label: string): string {
  const options = REMINDERCREATEDREPLIES[personality] ?? REMINDERCREATEDREPLIES.friend;
  return options[Math.floor(Math.random() * options.length)](task, label);
}

function resolveActivePersonality(user: Record<string, unknown>): string {
  const temporary = user.temp_personality && user.temp_personality_until && new Date(user.temp_personality_until as string).getTime() > Date.now();
  return ((temporary ? user.temp_personality : user.personality) as string) || "cynic";
}

const DONEWORDS = ["סיימתי", "עשיתי", "לקחתי", "גמרתי", "טיפלתי", "שלחתי", "התקשרתי", "קניתי", "השלמתי"];
const STRONGREMINDERTRIGGER = /תזכיר\s*לי|אל תשכח(?:\s*לי)?|תדע\s*להזכיר/;
const REMINDERTRIGGER = /תזכיר\s*לי|תזכורת|אל תשכח(?:\s*לי)?|תדע\s*להזכיר|תזכיר|כל\s*(?:יום|בוקר|ערב|לילה)/;
const TIMEORANCHORSIGNAL = /(עוד\s*\d+\s*(דקות|דקה|שעות|שעה|ימים|יום)|מחר|מחרתיים|ביום\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|בשעה\s*\d|ב\s*-?\s*\d{1,2}[:.]\d{2}|כל\s*(?:יום|בוקר|ערב|לילה)|לפני שאני|כשאני מגיע|כשאני חוזר|כשאני יוצא|לפני השינה|כשאני קם)/i;
const WEEKDAYS: Record<string, number> = { ראשון: 0, שני: 1, שלישי: 2, רביעי: 3, חמישי: 4, שישי: 5, שבת: 6 };

function detectReminderIntent(text: string): boolean {
  const lower = text.toLowerCase();
  return STRONGREMINDERTRIGGER.test(lower) || (REMINDERTRIGGER.test(lower) && TIMEORANCHORSIGNAL.test(lower));
}

function detectDone(text: string): boolean {
  const lower = text.toLowerCase();
  return DONEWORDS.some((word) => lower.includes(word));
}

function background(promise: Promise<unknown>, label: string): void {
  promise.catch((error) => console.error(`[background:${label}] failed:`, error));
}

async function sendChatAction(chatId: number, action = "typing") {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch (error) {
    console.error("[telegram] sendChatAction failed:", error);
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 12_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function buildOpenAiMessages(systemPrompt: string, history: HistoryMessage[], text: string) {
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
  ];
  for (const msg of history) {
    messages.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
    });
  }
  messages.push({ role: "user", content: text });
  return messages;
}

async function callGeminiOpenAiCompat(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  timeoutMs = 9_000,
): Promise<{ ok: true; content: string } | { ok: false }> {
  try {
    const url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.88,
          max_tokens: 350,
        }),
      },
      timeoutMs,
    );
    if (res.ok) {
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content?.trim();
      if (content) return { ok: true, content };
    }
    const err = await res.text();
    console.warn(`[gemini-openai:${model}] HTTP ${res.status}: ${err.slice(0, 200)}`);
    return { ok: false };
  } catch (err) {
    console.warn(`[gemini-openai:${model}] error:`, err);
    return { ok: false };
  }
}

async function callGeminiNative(
  apiKey: string,
  model: string,
  prompt: string,
  history: HistoryMessage[],
  text: string,
  timeoutMs = 9_000,
): Promise<{ ok: true; content: string } | { ok: false }> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const contents = [
      ...history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      { role: "user", parts: [{ text }] },
    ];
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt }] },
          contents,
          generationConfig: { temperature: 0.88, maxOutputTokens: 350 },
        }),
      },
      timeoutMs,
    );
    if (res.ok) {
      const data = await res.json();
      const content = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("").trim();
      if (content) return { ok: true, content };
    }
    return { ok: false };
  } catch (err) {
    console.warn(`[gemini-native:${model}] error:`, err);
    return { ok: false };
  }
}

async function generateAiReply(
  prompt: string,
  history: HistoryMessage[],
  text: string,
): Promise<string | null> {
  const apiKey = GEMINI_API_KEY;
  if (!apiKey) return null;

  const messages = buildOpenAiMessages(prompt, history, text);

  // Sequence of advanced models: Pro -> Flash 2.0 -> Flash 1.5
  let res = await callGeminiOpenAiCompat(apiKey, "gemini-1.5-pro", messages, 8_000);
  if (res.ok) return res.content;

  res = await callGeminiOpenAiCompat(apiKey, "gemini-2.0-flash", messages, 8_000);
  if (res.ok) return res.content;

  res = await callGeminiOpenAiCompat(apiKey, "gemini-1.5-flash", messages, 8_000);
  if (res.ok) return res.content;

  const nativeRes = await callGeminiNative(apiKey, "gemini-1.5-flash", prompt, history, text, 8_000);
  if (nativeRes.ok) return nativeRes.content;

  return null;
}

async function sendMessage(chatId: number, text: string, keyboard?: object) {
  const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) body.reply_markup = keyboard;
  const response = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) console.error(`[telegram] send failed ${response.status}: ${(await response.text()).slice(0, 300)}`);
}

async function updateUser(chatId: number, changes: Record<string, unknown>) {
  const { error } = await supabase.from("users").update(changes).eq("chat_id", chatId);
  if (error) console.error("[users] update failed:", error.message);
}

async function touchUser(chatId: number, firstName: string) {
  const { data, error } = await supabase
    .from("users")
    .upsert(
      { chat_id: chatId, first_name: firstName, last_message_at: new Date().toISOString() },
      { onConflict: "chat_id" },
    )
    .select()
    .single();
  if (!error && data) return data;
  const { data: existing, error: selectError } = await supabase.from("users").select("*").eq("chat_id", chatId).maybeSingle();
  if (existing) return existing;
  if (selectError) throw selectError;
  throw error ?? new Error("touchUser: no row");
}

async function getHistory(chatId: number): Promise<HistoryMessage[]> {
  const { data } = await supabase.from("messages").select("role, content, created_at").eq("chat_id", chatId).order("created_at", { ascending: false }).limit(HISTORY_LIMIT);
  return (data ?? []).reverse();
}

async function saveMessage(chatId: number, role: string, content: string) {
  await supabase.from("messages").insert({ chat_id: chatId, role, content });
}

function israelDateParts(base: Date) {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  return formatter.formatToParts(base).reduce((out, part) => { out[part.type] = part.value; return out; }, {} as Record<string, string>);
}

function timezoneOffset(date: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const parts = formatter.formatToParts(date).reduce((out, part) => { out[part.type] = part.value; return out; }, {} as Record<string, string>);
  return (Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - date.getTime()) / 60_000;
}

function israelTime(hour: number, minute: number, base = new Date(), addDays = 0): Date {
  const date = israelDateParts(base);
  const naive = Date.UTC(+date.year, +date.month - 1, +date.day + addDays, hour, minute, 0);
  return new Date(naive - timezoneOffset(new Date(naive)) * 60_000);
}

function reminderScheduleLabel(dueAt: Date, type: ParsedReminder["type"]): string {
  const time = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(dueAt);
  if (type === "daily") return `כל יום ב־${time}`;
  if (type === "weekly") return `כל שבוע ב־${time}`;
  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const dueDay = dayKey.format(dueAt);
  if (dueDay === dayKey.format(new Date())) return `היום ב־${time}`;
  if (dueDay === dayKey.format(new Date(Date.now() + 86_400_000))) return `מחר ב־${time}`;
  const date = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, day: "numeric", month: "numeric" }).format(dueAt);
  return `ב־${date} ב־${time}`;
}

function reminderLabel(r: ActiveReminder): string {
  const time = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(r.time));
  return r.type === "daily" ? `כל יום ב־${time}` : r.type === "weekly" ? `כל שבוע ב־${time}` : `ב־${time}`;
}

async function showReminders(chatId: number) {
  const { data } = await supabase.from("reminders").select("id, text, type, time").eq("chat_id", chatId).eq("active", true).order("time");
  const reminders = (data ?? []) as ActiveReminder[];
  if (!reminders.length) {
    await sendMessage(chatId, "אין לך כרגע תזכורות פעילות.");
    return;
  }
  const lines = reminders.map((r, i) => `${i + 1}. ${r.text} — ${reminderLabel(r)}`);
  const buttons = reminders.map((r) => [{ text: `🗑️ מחק: ${r.text.slice(0, 24)}`, callback_data: `ask_delete_reminder_${r.id}` }]);
  await sendMessage(chatId, `התזכורות שלך:\n${lines.join("\n")}`, { inline_keyboard: buttons });
}

async function askDeleteReminder(chatId: number, reminder: ActiveReminder) {
  await sendMessage(chatId, `למחוק את התזכורת:\n${reminder.text} — ${reminderLabel(reminder)}?`, {
    inline_keyboard: [
      [{ text: "🗑️ כן, למחוק", callback_data: `confirm_delete_reminder_${reminder.id}` }, { text: "לבטל", callback_data: "cancel_delete_reminder" }],
    ],
  });
}

async function findReminderForDeletion(chatId: number, text: string): Promise<ActiveReminder | null> {
  const { data } = await supabase.from("reminders").select("id, text, type, time").eq("chat_id", chatId).eq("active", true);
  const reminders = (data ?? []) as ActiveReminder[];
  if (!reminders.length) return null;
  const query = text.replace(/מחק|תמחק|לבטל|תבטל|הסר|תסיר|את התזכורת|תזכורת|אותה|אותו/gu, "").trim().toLowerCase();
  if (!query || /^(אותה|אותו)?$/u.test(query)) return reminders.length === 1 ? reminders[0] : null;
  return reminders.find((r) => query.split(/\s+/).some((w) => w.length > 2 && r.text.toLowerCase().includes(w))) ?? null;
}

function parseReminder(text: string): ParsedReminder | null {
  const input = text.trim();
  const now = new Date();
  let type: ParsedReminder["type"] = "once";
  let dueAt: Date | null = null;
  let span = "";

  const daily = input.match(/כל\s*(?:יום|בוקר|ערב|לילה)\s*(?:ב\s*-?\s*|בשעה\s*)?(\\d{1,2})(?::(\\d{2})|\\s*וחצי|\\s*ורבע)?/);
  if (daily) {
    const hour = +daily[1];
    const minute = daily[2] ? +daily[2] : /וחצי/.test(daily[0]) ? 30 : /ורבע/.test(daily[0]) ? 15 : 0;
    dueAt = israelTime(hour, minute, now);
    if (dueAt <= now) dueAt = israelTime(hour, minute, now, 1);
    type = "daily";
    span = daily[0];
  }

  if (!dueAt) {
    const relative = input.match(/(?:עוד|בעוד)\s*(\d+)\s*(דקות|דקה|שעות|שעה|ימים|יום)/);
    if (relative) {
      const amount = +relative[1];
      const unit = relative[2];
      const multiplier = /דק/.test(unit) ? 60_000 : /שע/.test(unit) ? 3_600_000 : 86_400_000;
      dueAt = new Date(now.getTime() + amount * multiplier);
      span = relative[0];
    }
  }

  if (!dueAt) {
    const day = input.match(/מחרתיים|מחר|היום/);
    if (day) {
      const add = day[0] === "מחר" ? 1 : day[0] === "מחרתיים" ? 2 : 0;
      const time = input.match(/(?:ב\s*-?\s*|בשעה\s*)(\d{1,2})(?::(\d{2}))?/);
      dueAt = israelTime(time ? +time[1] : 9, time?.[2] ? +time[2] : 0, now, add);
      span = day[0] + (time ? time[0] : "");
    }
  }

  if (!dueAt) {
    const weekday = input.match(/ביום\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/);
    if (weekday) {
      const target = WEEKDAYS[weekday[1]];
      let add = (target - now.getDay() + 7) % 7;
      if (!add) add = 7;
      const time = input.match(/(?:ב\s*-?\s*|בשעה\s*)(\d{1,2})(?::(\d{2}))?/);
      dueAt = israelTime(time ? +time[1] : 9, time?.[2] ? +time[2] : 0, now, add);
      span = weekday[0] + (time ? time[0] : "");
    }
  }

  if (!dueAt) {
    const time = input.match(/(?:ב\s*-?\s*|בשעה\s*)(\d{1,2})(?::(\d{2}))?/);
    if (time) {
      dueAt = israelTime(+time[1], time[2] ? +time[2] : 0, now);
      if (dueAt <= now) dueAt = israelTime(+time[1], time[2] ? +time[2] : 0, now, 1);
      span = time[0];
    }
  }

  if (!dueAt || !span) return null;
  const task = input.replace(REMINDERTRIGGER, "").replace(span, "").replace(/^[\s,־-]+|[\s,־-]+$/g, "").trim() || "תזכורת";
  return { dueAt, task, type };
}

function personalityKeyboard() {
  return { inline_keyboard: [
    [{ text: "🧠 המאמן", callback_data: "personality_coach" }, { text: "😈 הציני", callback_data: "personality_cynic" }],
    [{ text: "🤗 החבר", callback_data: "personality_friend" }, { text: "🪖 הרס\"ר", callback_data: "personality_sergeant" }],
    [{ text: "🛋️ המטפל", callback_data: "personality_therapist" }, { text: "🔥 המעודד", callback_data: "personality_hype" }],
    [{ text: "👵 הסבתא", callback_data: "personality_grandma" }, { text: "🧐 הפילוסוף", callback_data: "personality_philosopher" }],
    [{ text: "😏 הפראייר", callback_data: "personality_frayer" }, { text: "🏠 השכן", callback_data: "personality_neighbor" }],
  ] };
}

async function answerCallback(id: string) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: id }) });
}

// Master conversational AI prompt: deep comprehension, culture, quick wit & natural flow
async function askGemini(text: string, personalityKey: string, history: HistoryMessage[], context: string, layers: string[]): Promise<string> {
  const personality = PERSONALITIES[personalityKey] ?? PERSONALITIES.cynic;

  const prompt = `אתה ${personality.name}. ${personality.prompt}

אתה בוט אישי בוואטסאפ שמתכתב בעברית ישראלית אותנטית, חיה, אינטליגנטית ושנונה מאוד.
חוקי השיחה:
- אתה מבין אסוציאציות, ציטוטים משירים (כמו גידי גוב, מוניקה סקס וכו'), סלנג ורמזים דקים. תשתמש בהם בעקיצות ובהומור שלך באופן טבעי.
- תגיב תמיד לעומק של מה שהמשתמש אמר עכשיו ביחס לכל השיחה האחרונה.
- אתה לא מוותר לו על דחיינות — תמיד דוחף אותו בצורה משעשעת או תכל'סית לסגור שעה / יעד / משימה / לקחת כדור.
- ענה ב-1 עד 2 משפטים חדים ומדויקים (לא נאום).
- אל תשתמש לעולם בניסוחים רובוטיים כמו "אני כאן בשבילך", "אשמח לסייע", "כפי שציינת".

${context ? `הקשר: ${context}` : ""}
${layers.filter(Boolean).join("\n")}`;

  const generated = await generateAiReply(prompt, history, text);
  if (!generated) {
    const options = [
      "אני איתך. מה קורה?",
      "פה לגמרי, מה על הפרק?",
      "שומע אותך מצוין. מה אמרת?",
    ];
    return options[Math.floor(Math.random() * options.length)];
  }

  return naturalize(generated);
}

async function runBackgroundPipelines(chatId: number, text: string, reply: string, history: HistoryMessage[], memories: Memory[], profile: Profile) {
  try {
    const caller = async (payload: any) => {
      const messages = [{ role: "user", content: JSON.stringify(payload) }];
      const res = await callGeminiOpenAiCompat(GEMINI_API_KEY, "gemini-1.5-flash", messages, 8_000);
      if (res.ok) return { ok: true, data: { candidates: [{ content: { parts: [{ text: res.content }] } }] } };
      return { ok: false };
    };

    const extraction = await runExtraction(caller, { userText: text, replyText: reply, history, known: memories });
    await upsertMemories(supabase, chatId, extraction.memories);
    await forgetMemories(supabase, chatId, extraction.forget);
    await scheduleFollowUps(supabase, chatId, extraction.followUps);

    const awareness = await runAwarenessExtraction(caller, { userText: text, replyText: reply, history });
    await upsertEvents(supabase, chatId, awareness.events);
    await bumpInsideJokes(supabase, chatId, awareness.jokes);

    const profileExtraction = await runProfileExtraction(caller, { userText: text, replyText: reply, history, profile });
    if (Object.keys(profileExtraction.patch).length) await saveProfile(supabase, chatId, profileExtraction.patch);
    await upsertGoals(supabase, chatId, profileExtraction.goals);
  } catch (error) {
    console.error("[background] pipeline failed:", error);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("OK", { status: 200 });

  const reqStart = performance.now();
  try {
    const update = await req.json();

    if (update.callback_query) {
      const callback = update.callback_query;
      const chatId = callback.message.chat.id as number;
      const data = String(callback.data ?? "");
      const user = await touchUser(chatId, callback.from?.first_name ?? "חבר");
      const activePersonality = resolveActivePersonality(user);
      await answerCallback(callback.id);

      if (data.startsWith("personality_")) {
        const personality = data.replace("personality_", "");
        background(updateUser(chatId, { personality, temp_personality: null, temp_personality_until: null, state: "chatting" }), "personality_switch");
        await sendMessage(chatId, GREETINGS[personality] ?? "סגור. דבר איתי.");
      } else if (data === "menu_reminder") {
        background(updateUser(chatId, { state: "awaiting_reminder_text" }), "menu_reminder_state");
        await sendMessage(chatId, "מה להזכיר לך?");
      } else if (data === "menu_personality") {
        await sendMessage(chatId, "בחר אישיות:", personalityKeyboard());
      } else if (data.startsWith("done_reminder_")) {
        const id = data.replace("done_reminder_", "");
        const { data: reminder } = await supabase.from("reminders").select("id, chat_id, text, type, time").eq("id", id).maybeSingle();
        if (reminder) {
          const writes: Promise<unknown>[] = [
            supabase.from("reminder_completions").insert({ chat_id: chatId, reminder_id: reminder.id, reminder_text: reminder.text }),
            logBehavior(supabase, chatId, "reminder_done", { hour: new Date(reminder.time).getHours() }),
          ];
          if (reminder.type === "once") writes.push(supabase.from("reminders").update({ active: false }).eq("id", id));
          background(Promise.all(writes), "done_reminder_writes");
          await sendMessage(chatId, pickPersonalized(DONEREPLIES, activePersonality));
        }
      } else if (data.startsWith("snooze_")) {
        const id = data.replace("snooze_", "");
        background(
          Promise.all([
            supabase.from("reminders").update({ time: new Date(Date.now() + 15 * 60_000).toISOString(), nudge_sent_at: null }).eq("id", id),
            logBehavior(supabase, chatId, "reminder_snoozed"),
          ]),
          "snooze_writes",
        );
        await sendMessage(chatId, pickPersonalized(SNOOZEREPLIES, activePersonality));
      } else if (data.startsWith("ask_delete_reminder_")) {
        const id = data.replace("ask_delete_reminder_", "");
        const { data: reminder } = await supabase.from("reminders").select("id, text, type, time").eq("id", id).eq("chat_id", chatId).eq("active", true).maybeSingle();
        if (reminder) await askDeleteReminder(chatId, reminder as ActiveReminder);
      } else if (data.startsWith("confirm_delete_reminder_")) {
        const id = data.replace("confirm_delete_reminder_", "");
        const { error } = await supabase.from("reminders").update({ active: false }).eq("id", id).eq("chat_id", chatId);
        await sendMessage(chatId, error ? "לא הצלחתי למחוק. נסה שוב עוד רגע." : "נמחקה. לא אטריד אותך על זה יותר.");
      } else if (data === "cancel_delete_reminder") {
        await sendMessage(chatId, "סבבה, נשארת כמו שהיא.");
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const message = update.message;
    if (!message?.text) return new Response(JSON.stringify({ ok: true }), { status: 200 });

    const chatId = message.chat.id as number;
    const text = String(message.text).trim();
    const firstName = message.from?.first_name ?? "חבר";

    background(sendChatAction(chatId, "typing"), "initial_typing");

    const user = await touchUser(chatId, firstName);
    const personality = resolveActivePersonality(user);

    if (text === "/start") {
      await sendMessage(chatId, `שלום ${firstName}! בחר מי ידבר איתך:`, personalityKeyboard());
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (text === "/menu") {
      await sendMessage(chatId, "מה בא לך לעשות?", { inline_keyboard: [[{ text: "⏰ תזכורת", callback_data: "menu_reminder" }], [{ text: "🎭 אישיות", callback_data: "menu_personality" }]] });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (user.state === "awaiting_reminder_text") {
      background(updateUser(chatId, { state: "awaiting_reminder_time_once", pending_reminder_text: text }), "reminder_text_state");
      await sendMessage(chatId, "מתי? כתוב שעה כמו 08:30.");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (String(user.state ?? "").startsWith("awaiting_reminder_time_")) {
      const time = text.match(/^([0-1]?\d|2[0-3]):([0-5]\d)$/);
      if (!time) {
        await sendMessage(chatId, "תכתוב שעה בפורמט HH:MM, למשל 08:30.");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      const type = String(user.state).replace("awaiting_reminder_time_", "") as "once" | "daily" | "weekly";
      const due = israelTime(+time[1], +time[2]);
      await supabase.from("reminders").insert({ chat_id: chatId, text: user.pending_reminder_text, type, time: due.toISOString(), active: true });
      background(updateUser(chatId, { state: "idle", pending_reminder_text: null }), "reminder_time_state_reset");
      const manualLabel = reminderScheduleLabel(due, type);
      await sendMessage(chatId, pickReminderCreated(resolveActivePersonality(user), String(user.pending_reminder_text ?? "זה"), manualLabel));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const switchRequest = detectSwitchRequest(text);
    if (switchRequest?.type === "personality") {
      const changes = switchRequest.scope === "permanent"
        ? { personality: switchRequest.key, temp_personality: null, temp_personality_until: null }
        : { temp_personality: switchRequest.key, temp_personality_until: new Date(Date.now() + 2 * 3_600_000).toISOString() };
      background(updateUser(chatId, changes), "switch_personality");
      await sendMessage(chatId, `${PERSONALITIES[switchRequest.key]?.emoji ?? "💬"} סגור, לשעתיים הקרובות.`);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (switchRequest?.type === "tone") {
      background(updateUser(chatId, { tone_override: switchRequest.tone }), "switch_tone");
      await sendMessage(chatId, "סגור.");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (/^(\/reminders|התזכורות שלי|תזכורות)$/u.test(text)) {
      await showReminders(chatId);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (/(מחק|תמחק|לבטל|תבטל|הסר|תסיר)/u.test(text) && /(תזכור|כדור|אותה|אותו|ה)/u.test(text)) {
      const reminder = await findReminderForDeletion(chatId, text);
      if (reminder) {
        await askDeleteReminder(chatId, reminder);
      } else {
        await sendMessage(chatId, "איזו תזכורת למחוק? כתוב \"התזכורות שלי\" ובחר בכפתור.");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (detectDone(text)) {
      const { data: reminders } = await supabase.from("reminders").select("id, text").eq("chat_id", chatId).eq("active", true);
      const match = (reminders ?? []).find((reminder) => reminder.text.split(/\s+/).some((word: string) => word.length > 2 && text.includes(word)));
      if (match) {
        await sendMessage(chatId, `זה קשור ל"${match.text}"?`, { inline_keyboard: [[{ text: "✅ סיימתי", callback_data: `done_reminder_${match.id}` }, { text: "לא", callback_data: "dismiss" }]] });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    }

    if (detectReminderIntent(text)) {
      const parsed = parseReminder(text);
      if (parsed) {
        const { data: duplicates } = await supabase.from("reminders").select("id, text, type, time").eq("chat_id", chatId).eq("active", true);
        const duplicate = (duplicates ?? []).find((item) => item.text.trim().toLowerCase() === parsed.task.trim().toLowerCase() && item.type === parsed.type && Math.abs(new Date(item.time).getTime() - parsed.dueAt.getTime()) < 60_000);
        if (duplicate) {
          await sendMessage(chatId, `כבר יש לך תזכורת כזאת ל"${parsed.task}". לא הוספתי עוד אחת.`);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        await supabase.from("reminders").insert({ chat_id: chatId, text: parsed.task, type: parsed.type, time: parsed.dueAt.toISOString(), active: true });
        const label = reminderScheduleLabel(parsed.dueAt, parsed.type);
        await sendMessage(chatId, pickReminderCreated(personality, parsed.task, label));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      await sendMessage(chatId, "מתי להזכיר לך? למשל: מחר ב-8 או עוד שעה.");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const [histData, memRaw, profData, goalsData, eventsData, jokesData, phrasesData, remData] = await Promise.all([
      getHistory(chatId),
      fetchMemories(supabase, chatId),
      fetchProfile(supabase, chatId),
      fetchGoals(supabase, chatId),
      fetchEvents(supabase, chatId),
      fetchInsideJokes(supabase, chatId),
      fetchRecentPhrases(supabase, chatId),
      supabase.from("reminders").select("text").eq("chat_id", chatId).eq("active", true),
    ]);
    const history = histData;
    const memories = rankMemories(memRaw).slice(0, 5);
    const profile = profData;
    const goals = goalsData.slice(0, 3);
    const events = eventsData.slice(0, 3);
    const jokes = jokesData;
    const recentPhrases = phrasesData;

    const lastBot = [...history].reverse().find((item) => item.role === "assistant")?.content ?? "";
    const pace = computePacing(text, lastBot, profile);

    // Instant reply strictly for single laughter triggers ("חחח", "😂")
    if (pace.instantReply && isLaugh(text)) {
      await sendMessage(chatId, pace.instantReply);
      background(saveMessage(chatId, "user", text), "save_user_instant");
      background(saveMessage(chatId, "assistant", pace.instantReply), "save_assistant_instant");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const mode = /אין לי כוח|קשה לי|עייף|שרוף/.test(text) ? "frustration" : /סיימתי|עשיתי|הצלחתי/.test(text) ? "success" : "casual";
    const mood = pickMood(personality, { mode, hourLocal: new Date().getHours(), repeatStreak: 0, gapMinutes: 0, prevMood: user.mood });
    const humor = humorPolicy({ text, mode, tone: "neutral", intensity: 0, mood, userHumorLevel: profile.humor_level });
    const deep = detectDeepMode(text, history);
    const material = [...goals.map((g: any) => g.title), ...events.map((e: any) => e.title)];
    const surprise = rollSurprise(material.length > 0, deep.deep);
    const decision = decisionEngine({ text, pacing: pace, hasMemory: memories.length > 0, hasGoals: goals.length > 0, humorLevel: profile.humor_level, mood: moodLabel(mood) });

    const layers = [
      memoryContext(memories), confidenceContext(memories), profileContext(profile), goalContext(goals), eventContext(events), insideJokeContext(jokes),
      coreferenceInstruction(text, history), implicitIntentLayer(text, { events, goals, reminders: (remData.data ?? []).map((r: { text: string }) => r.text) }),
      moodInstruction(mood, 0), humor.instruction, toneOverrideInstruction(user.tone_override), followUpNudge(text), linkedReasoning(text, memories, goals, profile), selfCorrectionLayer(text, memories, goals),
      deep.deep ? deepModeInstruction(deep.topic) : pace.instruction, surpriseInstruction(surprise, material), antiRepetitionInstruction(recentPhrases), decision.layer,
    ];

    background(saveMessage(chatId, "user", text), "save_user");

    const reply = await askGemini(text, personality, history, "", layers);

    await sendMessage(chatId, reply);

    background(saveMessage(chatId, "assistant", reply), "save_assistant");
    background(rememberPhrase(supabase, chatId, reply), "remember_phrase");
    background(logBehavior(supabase, chatId, "message", { len: text.length }), "log_message");
    if (isLaugh(text)) background(logBehavior(supabase, chatId, "laughed"), "log_laughed");
    background(learnFromBehavior(supabase, chatId, profile), "learn_behavior");
    background(runBackgroundPipelines(chatId, text, reply, history, memories, profile), "pipelines");

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (error) {
    console.error("[telegram] fatal:", error);
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
});
