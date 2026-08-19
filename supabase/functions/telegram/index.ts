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
const GEMINI_API_VERSION = "v1beta";
const TZ = Deno.env.get("BOT_TIMEZONE") ?? "Asia/Jerusalem";
const HISTORY_LIMIT = 12;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const BLOCKED_MODELS = new Set<string>();
const NO_THINKING_SUPPORT = new Set<string>();
let resolvedModel: string | null = null;
let resolvedAt = 0;

const MODELS = [
  Deno.env.get("GEMINI_MODEL")?.trim(),
  "gemini-flash-latest",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
].filter(Boolean) as string[];

type HistoryMessage = { role: string; content: string; created_at?: string };
type ParsedReminder = { dueAt: Date; task: string; type: "once" | "daily" | "weekly" };

const PERSONALITIES: Record<string, { name: string; emoji: string; prompt: string }> = {
  coach: { name: "המאמן", emoji: "🧠", prompt: "אתה מאמן אישי ישראלי, חם וישיר. דוחף לצעד קטן ומעשי. בלי נאומים." },
  cynic: { name: "הציני", emoji: "😈", prompt: "אתה ציני חביב וקצר. עקיצה אחת לכל היותר, אבל לא פוגע." },
  friend: { name: "החבר", emoji: "🤗", prompt: "אתה חבר חם בוואטסאפ. מקשיב, מדבר טבעי ולא שיפוטי." },
  sergeant: { name: "הרס\"ר", emoji: "🪖", prompt: "אתה רס\"ר יבש וקצר. פעולה לפני תירוצים, אבל לא משפיל." },
  therapist: { name: "המטפל", emoji: "🛋️", prompt: "אתה עדין, סקרן ואנושי. פוגש רגש לפני פתרון." },
  hype: { name: "המעודד", emoji: "🔥", prompt: "אתה אנרגטי ומפרגן. חוגג הישגים בלי להיות מעיק." },
  grandma: { name: "הסבתא", emoji: "👵", prompt: "את סבתא ישראלית חמה ודואגת. מעט הומור על אוכל ושינה." },
  philosopher: { name: "הפילוסוף", emoji: "🧐", prompt: "אתה פילוסוף קצר ומדויק. שואל שאלה טובה בלי להסתבך." },
  frayer: { name: "הפראייר", emoji: "😏", prompt: "אתה ישראלי תכלסי. מדבר פשוט, בלי ז'רגון עסקי ובלי 'תשואה'." },
  neighbor: { name: "השכן מלמעלה", emoji: "🏠", prompt: "אתה שכן חביב עם FOMO קל, בלי התנשאות." },
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

const DONE_WORDS = ["סיימתי", "עשיתי", "לקחתי", "גמרתי", "טיפלתי", "שלחתי", "התקשרתי", "קניתי", "השלמתי"];
const STRONG_REMINDER_TRIGGER = /תזכיר\s*לי|אל תשכח(?:\s*לי)?|תדע\s*להזכיר/;
const REMINDER_TRIGGER = /תזכיר\s*לי|תזכורת|אל תשכח(?:\s*לי)?|תדע\s*להזכיר|תזכיר|כל\s*(?:יום|בוקר|ערב|לילה)/;
const TIME_OR_ANCHOR_SIGNAL = /(עוד\s*\d+\s*(דקות|דקה|שעות|שעה|ימים|יום)|מחר|מחרתיים|ביום\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|בשעה\s*\d|ב-?\d{1,2}[:.]\d{2}|כל\s*(?:יום|בוקר|ערב|לילה)|לפני שאני|כשאני מגיע|כשאני חוזר|כשאני יוצא|לפני השינה|כשאני קם)/i;
const WEEKDAYS: Record<string, number> = { ראשון: 0, שני: 1, שלישי: 2, רביעי: 3, חמישי: 4, שישי: 5, שבת: 6 };

function detectReminderIntent(text: string): boolean {
  const lower = text.toLowerCase();
  return STRONG_REMINDER_TRIGGER.test(lower) || (REMINDER_TRIGGER.test(lower) && TIME_OR_ANCHOR_SIGNAL.test(lower));
}

function detectDone(text: string): boolean {
  const lower = text.toLowerCase();
  return DONE_WORDS.some((word) => lower.includes(word));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 18_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function resolveModel(force = false): Promise<string> {
  if (resolvedModel && !force && !BLOCKED_MODELS.has(resolvedModel) && Date.now() - resolvedAt < 5 * 60_000) return resolvedModel;
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY is missing");
  const response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models?key=${key}`, {});
  if (!response.ok) throw new Error(`models.list HTTP ${response.status}`);
  const json = await response.json();
  const available = (json.models ?? [])
    .filter((model: any) => (model.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((model: any) => String(model.name).replace(/^models\//, ""));
  const model = [...MODELS, ...available].find((candidate) => available.includes(candidate) && !BLOCKED_MODELS.has(candidate));
  if (!model) throw new Error("No Gemini generateContent model available");
  resolvedModel = model;
  resolvedAt = Date.now();
  return model;
}

function modelConfig(model: string, base: Record<string, unknown>, tokenBoost: number, noThinking: boolean) {
  const maxOutputTokens = Number(base.maxOutputTokens ?? 700) + tokenBoost;
  const config: Record<string, unknown> = {
    ...base,
    temperature: base.temperature ?? 0.8,
    topP: base.topP ?? 0.9,
    maxOutputTokens,
  };
  if (/gemini-(2\.5|3)/.test(model) && !noThinking && !NO_THINKING_SUPPORT.has(model)) {
    config.thinkingConfig = { thinkingBudget: 0 };
  }
  return config;
}

// Important: keeps responseMimeType for JSON extraction calls.
async function generateContentWithFallback(
  apiKey: string,
  bodyBase: Record<string, unknown>,
  attempt = 0,
  tokenBoost = 0,
  noThinking = false,
): Promise<{ ok: true; data: any } | { ok: false }> {
  if (attempt >= 4) return { ok: false };
  let model: string;
  try { model = await resolveModel(attempt > 0); }
  catch (error) { console.error("[gemini] resolve model failed", error); return { ok: false }; }

  const baseConfig = (bodyBase.generationConfig as Record<string, unknown>) ?? {};
  const body = { ...bodyBase, generationConfig: modelConfig(model, baseConfig, tokenBoost, noThinking) };

  try {
    const response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${model}:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    if (response.ok) {
      const data = await response.json();
      const reason = data?.candidates?.[0]?.finishReason;
      const hasText = data?.candidates?.[0]?.content?.parts?.some((part: { text?: string }) => (part.text ?? "").trim());
      if (reason === "MAX_TOKENS" && attempt < 3 && tokenBoost < 800) {
        return generateContentWithFallback(apiKey, bodyBase, attempt + 1, tokenBoost + (hasText ? 300 : 700), noThinking);
      }
      return { ok: true, data };
    }
    const errorText = await response.text();
    if (response.status === 400 && !noThinking && /thinking/i.test(errorText)) {
      NO_THINKING_SUPPORT.add(model);
      return generateContentWithFallback(apiKey, bodyBase, attempt + 1, tokenBoost, true);
    }
    if (response.status === 404 || response.status === 403) {
      BLOCKED_MODELS.add(model);
      if (resolvedModel === model) resolvedModel = null;
    }
    console.error(`[gemini] ${model} HTTP ${response.status}: ${errorText.slice(0, 500)}`);
    return generateContentWithFallback(apiKey, bodyBase, attempt + 1, tokenBoost, noThinking);
  } catch (error) {
    console.error(`[gemini] ${model} network error`, error);
    return generateContentWithFallback(apiKey, bodyBase, attempt + 1, tokenBoost, noThinking);
  }
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

async function getOrCreateUser(chatId: number, firstName: string) {
  const { data } = await supabase.from("users").select("*").eq("chat_id", chatId).maybeSingle();
  if (data) return data;
  const { data: created, error } = await supabase
    .from("users")
    .insert({ chat_id: chatId, first_name: firstName, personality: "cynic", state: "idle" })
    .select()
    .single();
  if (error) throw error;
  return created;
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

function parseReminder(text: string): ParsedReminder | null {
  const input = text.trim();
  const now = new Date();
  let type: ParsedReminder["type"] = "once";
  let dueAt: Date | null = null;
  let span = "";

  const daily = input.match(/כל\s*(?:יום|בוקר|ערב|לילה)\s*(?:ב-?|בשעה\s*)?(\d{1,2})(?::(\d{2})|\s*וחצי|\s*ורבע)?/);
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
      const time = input.match(/(?:ב-?|בשעה\s*)(\d{1,2})(?::(\d{2}))?/);
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
      const time = input.match(/(?:ב-?|בשעה\s*)(\d{1,2})(?::(\d{2}))?/);
      dueAt = israelTime(time ? +time[1] : 9, time?.[2] ? +time[2] : 0, now, add);
      span = weekday[0] + (time ? time[0] : "");
    }
  }

  if (!dueAt) {
    const time = input.match(/(?:ב-?|בשעה\s*)(\d{1,2})(?::(\d{2}))?/);
    if (time) {
      dueAt = israelTime(+time[1], time[2] ? +time[2] : 0, now);
      if (dueAt <= now) dueAt = israelTime(+time[1], time[2] ? +time[2] : 0, now, 1);
      span = time[0];
    }
  }

  if (!dueAt || !span) return null;
  const task = input.replace(REMINDER_TRIGGER, "").replace(span, "").replace(/^[\s,־-]+|[\s,־-]+$/g, "").trim() || "תזכורת";
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

async function askGemini(text: string, personalityKey: string, history: HistoryMessage[], context: string, layers: string[]): Promise<string> {
  const personality = PERSONALITIES[personalityKey] ?? PERSONALITIES.cynic;
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return "אין לי כרגע חיבור ל-Gemini. תנסה שוב עוד רגע.";

  const prompt = `אתה ${personality.name}. ${personality.prompt}
אתה מדבר עברית ישראלית טבעית, קצרה ולא תאגידית. אין יותר משני משפטים קצרים, שאלה אחת לכל היותר, ואין לכתוב "אני כאן בשבילך", "בהחלט" או "אשמח לסייע".

הקשר בסיסי: ${context}

${layers.filter(Boolean).join("\n\n")}`;

  const contents = [
    ...history.map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })),
    { role: "user", parts: [{ text }] },
  ];

  const result = await generateContentWithFallback(apiKey, {
    systemInstruction: { parts: [{ text: prompt }] },
    contents,
    generationConfig: { temperature: 0.8, topP: 0.9, maxOutputTokens: 700 },
  });

  if (!result.ok) return "לא הצלחתי לענות עכשיו. תשלח שוב עוד רגע.";
  const raw = result.data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("") ?? "";
  return naturalize(raw || "לא הצלחתי לענות עכשיו. תשלח שוב עוד רגע.");
}

async function runBackgroundPipelines(chatId: number, text: string, reply: string, history: HistoryMessage[], memories: Memory[], profile: Profile) {
  try {
    const extraction = await runExtraction((payload) => generateContentWithFallback(Deno.env.get("GEMINI_API_KEY") ?? "", payload), { userText: text, replyText: reply, history, known: memories });
    await upsertMemories(supabase, chatId, extraction.memories);
    await forgetMemories(supabase, chatId, extraction.forget);
    await scheduleFollowUps(supabase, chatId, extraction.followUps);

    const awareness = await runAwarenessExtraction((payload) => generateContentWithFallback(Deno.env.get("GEMINI_API_KEY") ?? "", payload), { userText: text, replyText: reply, history });
    await upsertEvents(supabase, chatId, awareness.events);
    await bumpInsideJokes(supabase, chatId, awareness.jokes);

    const profileExtraction = await runProfileExtraction((payload) => generateContentWithFallback(Deno.env.get("GEMINI_API_KEY") ?? "", payload), { userText: text, replyText: reply, history, profile });
    if (Object.keys(profileExtraction.patch).length) await saveProfile(supabase, chatId, profileExtraction.patch);
    await upsertGoals(supabase, chatId, profileExtraction.goals);
  } catch (error) {
    console.error("[background] pipeline failed:", error);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("OK", { status: 200 });

  try {
    const update = await req.json();

    if (update.callback_query) {
      const callback = update.callback_query;
      const chatId = callback.message.chat.id as number;
      const data = String(callback.data ?? "");
      const user = await getOrCreateUser(chatId, callback.from?.first_name ?? "חבר");
      await answerCallback(callback.id);
      await updateUser(chatId, { last_message_at: new Date().toISOString() });

      if (data.startsWith("personality_")) {
        const personality = data.replace("personality_", "");
        await updateUser(chatId, { personality, temp_personality: null, temp_personality_until: null, state: "chatting" });
        await sendMessage(chatId, GREETINGS[personality] ?? "סגור. דבר איתי.");
      } else if (data === "menu_reminder") {
        await updateUser(chatId, { state: "awaiting_reminder_text" });
        await sendMessage(chatId, "מה להזכיר לך?");
      } else if (data === "menu_personality") {
        await sendMessage(chatId, "בחר אישיות:", personalityKeyboard());
      } else if (data.startsWith("done_reminder_")) {
        const id = data.replace("done_reminder_", "");
        const { data: reminder } = await supabase.from("reminders").select("id, chat_id, text, type, time").eq("id", id).maybeSingle();
        if (reminder) {
          if (reminder.type === "once") await supabase.from("reminders").update({ active: false }).eq("id", id);
          await supabase.from("reminder_completions").insert({ chat_id: chatId, reminder_id: reminder.id, reminder_text: reminder.text });
          await logBehavior(supabase, chatId, "reminder_done", { hour: new Date(reminder.time).getHours() });
          await sendMessage(chatId, "יפה. סומן.");
        }
      } else if (data.startsWith("snooze_")) {
        const id = data.replace("snooze_", "");
        await supabase.from("reminders").update({ time: new Date(Date.now() + 15 * 60_000).toISOString(), nudge_sent_at: null }).eq("id", id);
        await logBehavior(supabase, chatId, "reminder_snoozed");
        await sendMessage(chatId, "סגור, עוד 15 דקות.");
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const message = update.message;
    if (!message?.text) return new Response(JSON.stringify({ ok: true }), { status: 200 });

    const chatId = message.chat.id as number;
    const text = String(message.text).trim();
    const firstName = message.from?.first_name ?? "חבר";
    const user = await getOrCreateUser(chatId, firstName);

    // Always update activity before any return path.
    await updateUser(chatId, { last_message_at: new Date().toISOString() });

    if (text === "/start") {
      await sendMessage(chatId, `שלום ${firstName}! בחר מי ידבר איתך:`, personalityKeyboard());
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (text === "/menu") {
      await sendMessage(chatId, "מה בא לך לעשות?", { inline_keyboard: [[{ text: "⏰ תזכורת", callback_data: "menu_reminder" }], [{ text: "🎭 אישיות", callback_data: "menu_personality" }]] });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (user.state === "awaiting_reminder_text") {
      await updateUser(chatId, { state: "awaiting_reminder_time_once", pending_reminder_text: text });
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
      await updateUser(chatId, { state: "idle", pending_reminder_text: null });
      await sendMessage(chatId, `רשמתי: "${user.pending_reminder_text}" ב-${time[0]}.`);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const switchRequest = detectSwitchRequest(text);
    if (switchRequest?.type === "personality") {
      const changes = switchRequest.scope === "permanent"
        ? { personality: switchRequest.key, temp_personality: null, temp_personality_until: null }
        : { temp_personality: switchRequest.key, temp_personality_until: new Date(Date.now() + 2 * 3_600_000).toISOString() };
      await updateUser(chatId, changes);
      await sendMessage(chatId, `${PERSONALITIES[switchRequest.key]?.emoji ?? "💬"} סגור, לשעתיים הקרובות.`);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (switchRequest?.type === "tone") {
      await updateUser(chatId, { tone_override: switchRequest.tone });
      await sendMessage(chatId, "סגור.");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const temporary = user.temp_personality && user.temp_personality_until && new Date(user.temp_personality_until).getTime() > Date.now();
    const personality = (temporary ? user.temp_personality : user.personality) as string || "cynic";

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
        const label = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed.dueAt);
        await sendMessage(chatId, `רשמתי: "${parsed.task}" ב-${label}.`);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      // A strong trigger with no time: ask normally, do not claim the model is stuck.
      await sendMessage(chatId, "מתי להזכיר לך? למשל: מחר ב-8 או עוד שעה.");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const [history, memoriesRaw, profile, goals, events, jokes, recentPhrases, activeReminders] = await Promise.all([
      getHistory(chatId), fetchMemories(supabase, chatId), fetchProfile(supabase, chatId), fetchGoals(supabase, chatId), fetchEvents(supabase, chatId), fetchInsideJokes(supabase, chatId), fetchRecentPhrases(supabase, chatId),
      supabase.from("reminders").select("text").eq("chat_id", chatId).eq("active", true),
    ]);
    const memories = rankMemories(memoriesRaw);
    const lastBot = [...history].reverse().find((item) => item.role === "assistant")?.content ?? "";
    const pace = computePacing(text, lastBot, profile);

    if (pace.instantReply) {
      await sendMessage(chatId, pace.instantReply);
      await saveMessage(chatId, "user", text);
      await saveMessage(chatId, "assistant", pace.instantReply);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const mode = /אין לי כוח|קשה לי|עייף|שרוף/.test(text) ? "frustration" : /סיימתי|עשיתי|הצלחתי/.test(text) ? "success" : "casual";
    const mood = pickMood(personality, { mode, hourLocal: new Date().getHours(), repeatStreak: 0, gapMinutes: 0, prevMood: user.mood });
    const humor = humorPolicy({ text, mode, tone: "neutral", intensity: 0, mood, userHumorLevel: profile.humor_level });
    const deep = detectDeepMode(text, history);
    const material = [...goals.map((g) => g.title), ...events.map((e) => e.title)];
    const surprise = rollSurprise(material.length > 0, deep.deep);
    const decision = decisionEngine({ text, pacing: pace, hasMemory: memories.length > 0, hasGoals: goals.length > 0, humorLevel: profile.humor_level, mood: moodLabel(mood) });

    const layers = [
      memoryContext(memories), confidenceContext(memories), profileContext(profile), goalContext(goals), eventContext(events), insideJokeContext(jokes),
      coreferenceInstruction(text, history), implicitIntentLayer(text, { events, goals, reminders: (activeReminders.data ?? []).map((r: { text: string }) => r.text) }),
      moodInstruction(mood, 0), humor.instruction, toneOverrideInstruction(user.tone_override), followUpNudge(text), linkedReasoning(text, memories, goals, profile), selfCorrectionLayer(text, memories, goals),
      deep.deep ? deepModeInstruction(deep.topic) : pace.instruction, surpriseInstruction(surprise, material), antiRepetitionInstruction(recentPhrases), decision.layer,
    ];

    await saveMessage(chatId, "user", text);
    const reply = await askGemini(text, personality, "", history, layers);
    let finalReply = reply;
    const verdict = humanityCheck(reply, { deepMode: deep.deep, recent: recentPhrases, userText: text, lengthTarget: decision.lengthTarget });
    if (!verdict.ok) {
      const rewritten = await rewriteForHumanity((payload) => generateContentWithFallback(Deno.env.get("GEMINI_API_KEY") ?? "", payload), { reply, problems: verdict.problems, personalityPrompt: PERSONALITIES[personality]?.prompt ?? "", userText: text, lengthTarget: decision.lengthTarget });
      if (rewritten && !isRepetitive(rewritten, recentPhrases)) finalReply = naturalize(rewritten);
    }

    await sendMessage(chatId, finalReply);
    await saveMessage(chatId, "assistant", finalReply);
    await rememberPhrase(supabase, chatId, finalReply);
    await updateUser(chatId, { mood, mood_updated_at: new Date().toISOString() });
    logBehavior(supabase, chatId, "message", { len: text.length }).catch(() => {});
    if (isLaugh(text)) logBehavior(supabase, chatId, "laughed").catch(() => {});
    learnFromBehavior(supabase, chatId, profile).catch(() => {});
    runBackgroundPipelines(chatId, text, finalReply, history, memories, profile).catch(() => {});

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (error) {
    console.error("[telegram] fatal:", error);
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
});
