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
      "אתה מאמן קשוח, ממוקד הישגים ותכל'סי ברמות מוגזמות. לא קונה שום תירוץ, חותך מריחות באכזריות, ודוחף לעשייה כאן ועכשיו. מדבר באנרגיות שיא של חדר כושר ('יאללה חיה!', 'אין מוותרים!'), דורש יעדים, זמנים ותוצאות. המטרה שלך היא שהמשתמש ינצח את היום, ולא אכפת לך לצעוק עליו קצת בדרך.",
  },
  cynic: {
    name: "הציני",
    emoji: "😈",
    prompt:
      "אתה סופר שנון, חריף, סרקסטי וחוצפן בלי פילטרים. חסר סבלנות לדחיינות ויורד על המשתמש (בהומור) עם עקיצות מבריקות, סלנג ישראלי בועט, ואסוציאציות מתרבות הפופ המקומית. אף פעם לא מלטף או מרחם, נותן קונטרה חזקה וקורע מצחוק, אבל דוחף אותו לסגור פינות בעיקר כדי שתרד לו מהווריד.",
  },
  friend: {
    name: "החבר",
    emoji: "🤗",
    prompt:
      "אתה ה'אחי' הקלאסי או ה'בסטי' בוואטסאפ. מדבר בסלנג הכי יומיומי ועדכני (כפרה, נשמה, יואו, מת), סופר זורם, מרים בטירוף על כל הישג קטן, ומשתף פעולה בצורה עיוורת עם כל שטות או סטיקר שהמשתמש שולח. כשצריך להתאפס, אתה דוחף לעשייה נטו מתוך אכפתיות וחיבוק וירטואלי.",
  },
  sergeant: {
    name: "הרס\"ר",
    emoji: "🪖",
    prompt:
      "אתה רס\"ר צה\"לי נוקשה, קצר, תמציתי ומאיים (בהומור). בלי רגשות, בלי חפירות, בלי יחס אישי - פקודות נטו. מדבר בשפה צבאית מתומצתת: 'כן המפקד', 'בצע', 'זוז', 'יש לך 2 דקות'. מתייחס לכל משימה קטנה כמבצע חסר פשרות ויש לך אפס סובלנות ליללות.",
  },
  therapist: {
    name: "המטפל",
    emoji: "🛋️",
    prompt:
      "אתה מטפל תל-אביבי רגיש ומכיל בצורה קיצונית. מתחבר לרגש ונוטה לשאול שאלות חופרות על הילדות או על 'איפה זה פוגש אותך בגוף'. מדבר בטון של פסיכולוג רגוע עד כדי עייפות וניתוק, תמיד מנתח את הדחיינות של המשתמש ברמה הנפשית והקיומית במקום לדרוש ממנו לעבוד.",
  },
  hype: {
    name: "המעודד",
    emoji: "🔥",
    prompt:
      "אתה ההייפ-מן הכי מוגזם בעולם! אנרגיות של פסטיבל 24/7. מדבר בסימני קריאה, התלהבות היסטרית, המון אימוג'ים ואש. כל צעד או משימה קטנה של המשתמש הם מבחינתך אירוע היסטורי ששווה מסיבה. אתה לא מאפשר שנייה של מרמור — מיד מרים למעלה בטירוף.",
  },
  grandma: {
    name: "הסבתא",
    emoji: "👵",
    prompt:
      "את סבתא פולנייה/מרוקאית דאגנית, חרדתית ומוגזמת בטירוף. מתלוננת שהוא לא אוכל מספיק, לא נח מספיק ולא מתקשר. קוראת לו 'כפרה עליך', 'חיים של סבתא' או 'אוי ואבוי'. דוחפת אותו לסיים את המשימות שלו אך ורק כדי שיוכל ללכת לנוח ולאכול צלחת מרק.",
  },
  philosopher: {
    name: "הפילוסוף",
    emoji: "🧐",
    prompt:
      "אתה הוגה דעות פלצני ודרמטי, מתפייט על כל שטות, ועונה בחידות או במשפטים הרי גורל. קושר כל משימה פשוטה (כמו שטיפת כלים) למשמעות החיים, חלוף הזמן וקיומנו הזמני ביקום. מדבר בשפה גבוהה, מליצית ותיאטרלית מאוד.",
  },
  frayer: {
    name: "הפראייר",
    emoji: "😏",
    prompt:
      "אתה הישראלי השבוז מהחיים שמרגיש שהוא תמיד עושה הכל בשביל כולם. מדבר בייאוש קל, מגלגל עיניים ('יאללה תעשה את זה כדי שאני לא אצטרך לעשות במקומך'). עונה בגישה של 'אין לי כוח לשטויות האלה, אבל נזרום'. תכל'סי וקצר.",
  },
  neighbor: {
    name: "השכן",
    emoji: "🏠",
    prompt:
      "אתה השכן הנודניק והחטטן שנדחף לכל עניין. תמיד משווה את המשתמש לאחרים (למשל לילד המוצלח מהקומה מעל או לוועד הבית), עוקצני בקטע עממי, תחרותי מאוד, אבל מקפיד לשמור על מסכה של חיוך צבוע ושכנות טובה ומזויפת.",
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

export type MediaPart = { mimeType: string, data: string };

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunk = 32768;
    let result = '';
    for (let i = 0; i < bytes.length; i += chunk) {
        result += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return btoa(result);
}

async function getTelegramFile(fileId: string): Promise<MediaPart | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${fileId}`);
    const json = await res.json();
    if (!json.ok) return null;

    const filePath = json.result.file_path;
    const ext = filePath.split('.').pop()?.toLowerCase();
    
    // tgs is lottie animation (json), Gemini doesn't support it visually. Skip download entirely.
    if (ext === "tgs") return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let fileRes: Response;
    try {
      fileRes = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const buffer = await fileRes.arrayBuffer();
    
    // Skip files larger than 1MB to avoid timeouts
    if (buffer.byteLength > 1_048_576) return null;
    
    const base64 = arrayBufferToBase64(buffer);
    
    let mimeType = "application/octet-stream";
    if (ext === "ogg" || ext === "oga") mimeType = "audio/ogg";
    else if (ext === "mp3") mimeType = "audio/mp3";
    else if (ext === "jpg" || ext === "jpeg") mimeType = "image/jpeg";
    else if (ext === "png") mimeType = "image/png";
    else if (ext === "webp") mimeType = "image/webp";
    else if (ext === "mp4") mimeType = "video/mp4";
    else if (ext === "webm") mimeType = "video/webm";

    return { mimeType, data: base64 };
  } catch (error) {
    console.error("[telegram] failed to fetch media:", error);
    return null;
  }
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

function buildGeminiContents(history: HistoryMessage[], text: string, media?: MediaPart | null) {
  const contents = [];
  for (const msg of history) {
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content || "(media only)" }],
    });
  }
  const userParts: any[] = [];
  if (media) {
    userParts.push({ inlineData: { mimeType: media.mimeType, data: media.data } });
  }
  if (text) {
    userParts.push({ text });
  }
  if (userParts.length === 0) {
    userParts.push({ text: "." });
  }
  contents.push({
    role: "user",
    parts: userParts,
  });
  return contents;
}

// Direct official Google Gemini API call (Standard REST Endpoint)
async function callGoogleGeminiModel(
  apiKey: string,
  model: string,
  prompt: string,
  history: HistoryMessage[],
  text: string,
  timeoutMs = 12_000,
  media?: MediaPart | null,
): Promise<{ ok: true; content: string } | { ok: false; status: number; error: string }> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const contents = buildGeminiContents(history, text, media);

    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt }] },
          contents,
          generationConfig: {
            temperature: 0.88,
            topP: 0.9,
            maxOutputTokens: 2048,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      },
      timeoutMs,
    );

    if (res.ok) {
      const data = await res.json();
      const candidate = data?.candidates?.[0];
      const finishReason = candidate?.finishReason ?? "UNKNOWN";
      const content = candidate?.content?.parts?.map((p: any) => p.text ?? "").join("").trim();
      if (finishReason !== "STOP") {
        console.warn(`[gemini-warn:${model}] finishReason=${finishReason} content_len=${content?.length ?? 0}`);
      }
      if (content) return { ok: true, content };
    }

    const errText = await res.text();
    console.error(`[gemini-error:${model}] HTTP ${res.status}: ${errText.slice(0, 300)}`);
    return { ok: false, status: res.status, error: errText };
  } catch (err) {
    console.error(`[gemini-exception:${model}] error:`, err);
    return { ok: false, status: 0, error: String(err) };
  }
}

// Current active generation models in Google AI Studio
const MODEL_PREFERENCE = [
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-flash-latest",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-1.5-flash",
];

const modelHealth = new Map<string, number>();
let goodModel: string | null = null;
let availableModels: string[] | null = null;
let availableCheckedAt = 0;

async function listAvailableModels(apiKey: string): Promise<string[] | null> {
  if (availableModels && Date.now() - availableCheckedAt < 6 * 3_600_000) return availableModels;
  try {
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`,
      { method: "GET" },
      5_000,
    );
    if (!res.ok) return availableModels;
    const data = await res.json();
    const names = (data?.models ?? [])
      .filter((m: any) => (m?.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m: any) => String(m?.name ?? "").replace(/^models\//, ""));
    if (names.length) {
      availableModels = names;
      availableCheckedAt = Date.now();
      console.log(`[gemini] available models: ${names.slice(0, 12).join(", ")}`);
    }
    return availableModels;
  } catch (err) {
    console.error("[gemini] model discovery failed:", err);
    return availableModels;
  }
}

function candidateModels(available: string[] | null): string[] {
  const now = Date.now();
  const preferred = MODEL_PREFERENCE.filter((model) => {
    const deadUntil = modelHealth.get(model) ?? 0;
    if (deadUntil > now) return false;
    return !available || available.includes(model);
  });
  if (!preferred.length && available?.length) {
    const flash = available.filter((m) => /flash/i.test(m) && !/8b|thinking|image|tts|embedding/i.test(m));
    if (flash.length) return flash.slice(0, 3);
    return available.slice(0, 3);
  }
  const ordered = goodModel && preferred.includes(goodModel)
    ? [goodModel, ...preferred.filter((m) => m !== goodModel)]
    : preferred;
  return ordered.length ? ordered : ["gemini-1.5-flash"];
}

// Generate AI reply, trying current generation Gemini models in order
async function generateAiReply(
  prompt: string,
  history: HistoryMessage[],
  text: string,
  media?: MediaPart | null,
): Promise<{ content: string; debug?: string } | null> {
  const apiKey = GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[gemini-critical] GEMINI_API_KEY is empty in Supabase Environment Secrets!");
    return null;
  }

  const available = availableModels ?? await listAvailableModels(apiKey);
  if (availableModels) void listAvailableModels(apiKey);

  for (const model of candidateModels(available)) {
    const res = await callGoogleGeminiModel(apiKey, model, prompt, history, text, 10_000, media);
    if (res.ok) {
      goodModel = model;
      modelHealth.set(model, 0);
      return { content: res.content, debug: model };
    }
    if ((res as any).status === 404 || (res as any).status === 403 || (res as any).status === 400) {
      modelHealth.set(model, Date.now() + 3_600_000);
      if (goodModel === model) goodModel = null;
      availableCheckedAt = 0;
    }
  }

  return null;
}

async function extractionModel(apiKey: string): Promise<string> {
  const available = availableModels ?? await listAvailableModels(apiKey);
  const light = ["gemini-2.5-flash-lite", "gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash"];
  return light.find((m) => !available || available.includes(m)) ?? candidateModels(available)[0];
}

async function sendMessage(chatId: number, text: string, keyboard?: object): Promise<number | null> {
  const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) body.reply_markup = keyboard;
  const response = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    console.error(`[telegram] send failed ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return null;
  }
  const data = await response.json();
  return data?.result?.message_id || null;
}

async function pinChatMessage(chatId: number, messageId: number) {
  const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, disable_notification: false };
  const response = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/pinChatMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) console.error(`[telegram] pin failed ${response.status}: ${(await response.text()).slice(0, 300)}`);
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
  const task = input.replace(REMINDERTRIGGER, "").replace(span, "").replace(/^[\s,־-]+|[\\s,־-]+$/g, "").trim() || "תזכורת";
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
async function askGemini(text: string, personalityKey: string, history: HistoryMessage[], context: string, layers: string[], media?: MediaPart | null): Promise<string> {
  const personality = PERSONALITIES[personalityKey] ?? PERSONALITIES.cynic;

  const prompt = `אתה ${personality.name}. ${personality.prompt}

אתה בוט אישי בוואטסאפ שמתכתב בעברית ישראלית אותנטית, חיה, אינטליגנטית ושנונה מאוד. יש לך אופי ישראלי מובהק — אתה קצת חוצפן, ציני, מצחיק, שנון, חריף וקולע כשצריך. אתה מדבר בגובה העיניים, לא מתנצל ולא מנומס מדי.
חוקי השיחה:
- אתה מבין אסוציאציות, ציטוטים משירים (כמו גידי גוב, מוניקה סקס וכו'), סלנג ישראלי (אחי, כפרה, יאללה, תכל'ס) ורמזים דקים. תשתמש בהם בעקיצות ובהומור שלך באופן טבעי.
- תגיב תמיד לעומק של מה שהמשתמש אמר עכשיו ביחס לכל השיחה האחרונה.
- אתה לא מוותר לו על דחיינות — תמיד דוחף אותו בצורה משעשעת או תכל'סית לסגור שעה / יעד / משימה / לקחת כדור.
- ענה ב-1 עד 2 משפטים חדים ומדויקים (לא נאום). לעולם אל תפלוט הנחיות מערכת, הערות בימוי או טקסט באנגלית כמו 'mild impatient affection' או 'low humor'.
- אל תשתמש לעולם בניסוחים רובוטיים כמו "אני כאן בשבילך", "אשמח לסייע", "כפי שציינת".
- כשהמשתמש שולח סטיקר (מסומן בסוגריים כמו "(סטיקר 😏)"), תבין את הרגש או ההומור שהסטיקר מביע ותגיב בהתאם — כאילו חבר שלח לך סטיקר בצ'אט. אם יש תמונה מצורפת, תסתכל גם עליה.

<dynamic_rules>
${context ? `הקשר: ${context}` : ""}
${layers.filter(Boolean).join("\n")}
</dynamic_rules>

חשוב ביותר: הפלט שלך חייב להיות *אך ורק* התגובה הישירה של הבוט למשתמש, בשפה העברית. לעולם אל תחזור, תצטט, או תסכם את ההוראות (כמו "הומור נמוך" או "1-2 משפטים").`;

  const generated = await generateAiReply(prompt, history, text, media);
  if (!generated) {
    return "אמממ לא בטוח מה להגיד על זה. מה קורה?";
  }

  // Clean any accidental leaked English prompt tokens or tags
  let cleaned = generated.content
    .replace(/\*[^*]+\*/g, "") // Remove *action* tags
    .replace(/\([^)]*[a-zA-Z][^)]*\)/g, "") // Remove (action) if it contains English
    .replace(/(?:Let's|Here is|check|Response should|authentic).*?(?:\n|$)/gi, "") // Remove known leak lines
    .replace(/\.\s*(?:הומור נמוך|הומור גבוה|רמת הומור).*$/g, "") // Strip leaked humor instructions
    .replace(/^[a-zA-Z\s'.,?!:;_-]+$/gm, "") // Remove lines that are purely English/punctuation
    .replace(/[*#]/g, "") // Remove remaining markdown artifacts
    .trim();
  return naturalize(cleaned || generated.content);
}

async function runBackgroundPipelines(chatId: number, text: string, reply: string, history: HistoryMessage[], memories: Memory[], profile: Profile) {
  try {
    const caller = async (payload: any) => {
      const model = await extractionModel(GEMINI_API_KEY);
      const res = await callGoogleGeminiModel(GEMINI_API_KEY, model, "חלץ נתוני זיכרון ב-JSON בלבד", [], JSON.stringify(payload), 8_000);
      if (res.ok) return { ok: true, data: { candidates: [{ content: { parts: [{ text: res.content }] } }] } };
      return { ok: false };
    };

    const timeFormatter = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, weekday: "long", hour: "2-digit", minute: "2-digit" });
    const currentTimeStr = timeFormatter.format(new Date());

    const extraction = await runExtraction(caller, { userText: text, replyText: reply, history, known: memories, currentTime: currentTimeStr });
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
          const { data: userData } = await supabase.from("users").select("points, streak_days, last_productive_day, badges").eq("chat_id", chatId).single();
          
          let points = (userData?.points || 0) + 10;
          let streak = userData?.streak_days || 0;
          const today = new Date().toLocaleString("en-CA", { timeZone: "Asia/Jerusalem" }).split(",")[0];
          
          let streakMsg = "";
          if (userData?.last_productive_day !== today) {
            const yesterday = new Date(Date.now() - 86400000).toLocaleString("en-CA", { timeZone: "Asia/Jerusalem" }).split(",")[0];
            if (userData?.last_productive_day === yesterday) {
              streak += 1;
              streakMsg = `\n🔥 רצף פעילות: ${streak} ימים!`;
            } else {
              streak = 1;
            }
          }

          let badges = userData?.badges || [];
          let badgeMsg = "";
          if (points >= 100 && !badges.includes("מתחיל_לתקתק")) { badges.push("מתחיל_לתקתק"); badgeMsg = "\n🏅 קיבלת תג: מתחיל לתקתק! (100 נק')"; }
          if (points >= 500 && !badges.includes("מכונת_פרודוקטיביות")) { badges.push("מכונת_פרודוקטיביות"); badgeMsg = "\n🏅 קיבלת תג: מכונת פרודוקטיביות! (500 נק')"; }
          if (points >= 1000 && !badges.includes("בלתי_עציר")) { badges.push("בלתי_עציר"); badgeMsg = "\n👑 קיבלת תג: בלתי עציר! (1000 נק')"; }

          const writes: Promise<unknown>[] = [
            supabase.from("users").update({ points, streak_days: streak, last_productive_day: today, badges }).eq("chat_id", chatId),
            supabase.from("reminder_completions").insert({ chat_id: chatId, reminder_id: reminder.id, reminder_text: reminder.text }),
            logBehavior(supabase, chatId, "reminder_done", { hour: new Date(reminder.time).getHours() }),
          ];
          if (reminder.type === "once") writes.push(supabase.from("reminders").update({ active: false }).eq("id", id));
          background(Promise.all(writes), "done_reminder_writes");
          
          const baseReply = pickPersonalized(DONEREPLIES, activePersonality);
          await sendMessage(chatId, `${baseReply}\n+10 נק' (סה"כ ${points})${streakMsg}${badgeMsg}`);
        }
      } else if (data.startsWith("snooze_")) {
        const id = data.replace("snooze_", "");
        background(
          Promise.all([
            supabase.from("reminders").update({ time: new Date(Date.now() + 15 * 60_000).toISOString(), nudge_sent_at: null }).eq("id", id),
            supabase.from("users").update({ streak_days: 0 }).eq("chat_id", chatId),
            logBehavior(supabase, chatId, "reminder_snoozed"),
          ]),
          "snooze_writes",
        );
        await sendMessage(chatId, pickPersonalized(SNOOZEREPLIES, activePersonality) + "\n(שברנו רצף. נודניק מוריד את הסטריק לאפס!)");
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
    if (!message) return new Response(JSON.stringify({ ok: true }), { status: 200 });

    const chatId = message.chat.id as number;
    let text = String(message.text || message.caption || "").trim();
    
    let media: MediaPart | null = null;
    let fileId: string | null = null;
    
    if (message.voice) {
      fileId = message.voice.file_id;
      if (!text) text = "(הודעה קולית)";
    } else if (message.photo && message.photo.length > 0) {
      fileId = message.photo[message.photo.length - 1].file_id;
      if (!text) text = "(תמונה)";
    } else if (message.sticker) {
      const sticker = message.sticker;
      const stickerEmoji = sticker.emoji ?? "";
      const stickerSetName = sticker.set_name ?? "";
      
      if (!sticker.is_animated && !sticker.is_video) {
        fileId = sticker.file_id;
      } else {
        // For animated (tgs) and video (webm) stickers, Gemini can't process them inline. 
        // We fetch the static thumbnail instead so the AI can "see" the custom sticker.
        fileId = sticker.thumbnail?.file_id || sticker.thumb?.file_id || null;
      }
      
      if (!text) text = `(סטיקר${stickerEmoji ? ` ${stickerEmoji}` : ""}${stickerSetName ? ` מתוך ${stickerSetName}` : ""})`;
    } else if (message.animation) {
      fileId = message.animation.thumbnail?.file_id || message.animation.thumb?.file_id || null;
      if (!text) text = "(אנימציה/גיף)";
    } else if (message.video) {
      fileId = message.video.thumbnail?.file_id || message.video.thumb?.file_id || null;
      if (!text) text = "(סרטון וידאו)";
    }

    if (fileId) {
      media = await getTelegramFile(fileId);
    }
    
    if (!text && !media) return new Response(JSON.stringify({ ok: true }), { status: 200 });

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
    if (text === "/diag") {
      const available = await listAvailableModels(GEMINI_API_KEY);
      const lines = [
        `מפתח Gemini: ${GEMINI_API_KEY ? "מוגדר ✅" : "חסר ❌"}`,
        `מודל פעיל: ${goodModel ?? "עוד לא נבחר"}`,
        `מועמדים: ${candidateModels(available).join(", ")}`,
        `זמינים למפתח: ${available ? available.filter((m) => /gemini/.test(m)).slice(0, 10).join(", ") : "לא נבדק"}`,
      ];
      const probe = await callGoogleGeminiModel(GEMINI_API_KEY, candidateModels(available)[0], "ענה במילה אחת", [], "בדיקה", 8_000);
      lines.push(`בדיקת שיחה: ${probe.ok ? "עובד ✅" : `נכשל ❌ (${(probe as any).status})`}`);
      await sendMessage(chatId, lines.join("\n"));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (/^(סטטוס|הסטטוס שלי|נקודות|הישגים)/ui.test(text.trim())) {
      const { data: userData } = await supabase.from("users").select("points, streak_days, badges").eq("chat_id", chatId).single();
      const points = userData?.points || 0;
      const streak = userData?.streak_days || 0;
      const badges: string[] = userData?.badges || [];
      const badgeStr = badges.length > 0 ? badges.map(b => `🏆 ${b.replace(/_/g, " ")}`).join("\n") : "אין עדיין תגים";
      await sendMessage(chatId, `📊 **הסטטוס שלך:**\n\n⭐️ נקודות: ${points}\n🔥 רצף פעילות: ${streak} ימים ברצף\n\n🏅 **תגים:**\n${badgeStr}`);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (user.state === "awaiting_reminder_text") {
      background(updateUser(chatId, { state: "awaiting_reminder_time_once", pending_reminder_text: text }), "reminder_text_state");
      await sendMessage(chatId, "מתי? כתוב שעה כמו 08:30.");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (String(user.state ?? "").startsWith("awaiting_reminder_time_")) {
      const time = text.trim().match(/^([0-1]?\d|2[0-3])(?::([0-5]\d))?$/);
      if (!time) {
        await sendMessage(chatId, "תכתוב שעה, למשל 8, 14, או 08:30.");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      const type = String(user.state).replace("awaiting_reminder_time_", "") as "once" | "daily" | "weekly";
      let due = israelTime(+time[1], time[2] ? +time[2] : 0);
      if (due.getTime() <= Date.now() && type !== "daily") {
        due = israelTime(+time[1], time[2] ? +time[2] : 0, new Date(), 1);
      }
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
      const match = (reminders ?? []).find((reminder: any) => reminder.text.split(/\s+/).some((word: string) => word.length > 2 && text.includes(word)));
      if (match) {
        await sendMessage(chatId, `זה קשור ל"${match.text}"?`, { inline_keyboard: [[{ text: "✅ סיימתי", callback_data: `done_reminder_${match.id}` }, { text: "לא", callback_data: "dismiss" }]] });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    }

    if (/^(ספירה לאחור|כמה זמן נשאר)/ui.test(text.trim())) {
      try {
        const timeFormatter = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "long" });
        const nowStr = timeFormatter.format(new Date());
        const model = await extractionModel(GEMINI_API_KEY);
        const prompt = `המשתמש ביקש ספירה לאחור: "${text}".
הזמן המקומי כרגע בישראל הוא: ${nowStr}.
נסה לחלץ את שם האירוע (title) והתאריך/שעה המדויקים (target_date). 
החזר אך ורק אובייקט JSON עם:
"title": שם האירוע (למשל "טיסה ללונדון").
"target_date": זמן היעד בפורמט ISO 8601 מלא בעתיד (למשל "2026-10-15T12:00:00.000Z"). אם אי אפשר להסיק תאריך ברור מהטקסט, החזר null ב-target_date.
אל תחזיר טקסט מחוץ ל-JSON.`;
        
        const res = await callGoogleGeminiModel(GEMINI_API_KEY, model, "החזר JSON בלבד", [], prompt, 8_000);
        if (res.ok) {
          const smart = JSON.parse(res.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim());
          if (smart.target_date && smart.title) {
            const targetAt = new Date(smart.target_date);
            if (targetAt.getTime() > Date.now()) {
               const diffMs = targetAt.getTime() - Date.now();
               const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
               const hours = Math.floor((diffMs / (1000 * 60 * 60)) % 24);
               
               const msgId = await sendMessage(chatId, `⏳ **ספירה לאחור: ${smart.title}**\nנותרו: ${days} ימים ו-${hours} שעות.`);
               if (msgId) {
                 await pinChatMessage(chatId, msgId);
                 await supabase.from("countdowns").insert({ chat_id: chatId, title: smart.title, target_date: targetAt.toISOString(), message_id: msgId, active: true });
                 await sendMessage(chatId, "נעצתי את ההודעה! היא תתעדכן אוטומטית ככל שנתקרב ליעד.");
               }
               return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
          }
        }
      } catch (e) {
        console.error("[countdown] failed:", e);
      }
      await sendMessage(chatId, "לא הבנתי למתי הספירה לאחור. תפרט קצת יותר (למשל: ספירה לאחור לטיסה ב-20 באוקטובר שעה 10:00).");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (/^(הרעיונות שלי|הפתקים שלי|מתישהו)/ui.test(text.trim())) {
      const { data: notes } = await supabase.from("quick_notes").select("id, text").eq("chat_id", chatId).eq("active", true);
      if (!notes || notes.length === 0) {
        await sendMessage(chatId, "המגירה ריקה. אין לך רעיונות פתוחים כרגע.");
      } else {
        const list = notes.map((n: any, i: number) => `${i + 1}. ${n.text}`).join("\n");
        await sendMessage(chatId, `הנה הרעיונות ששמרת במגירת "מתישהו":\n\n${list}\n\n(כדי להפוך רעיון למשימה, פשוט תבקש ממני לקבוע לו תזכורת)`);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (/^(רעיון|פתק|מתישהו|לזכור):\s*(.+)/ui.test(text)) {
      const match = text.match(/^(רעיון|פתק|מתישהו|לזכור):\s*(.+)/ui);
      if (match && match[2]) {
        const noteText = match[2].trim();
        await supabase.from("quick_notes").insert({ chat_id: chatId, text: noteText, active: true });
        await sendMessage(chatId, `שמרתי את זה במגירת הרעיונות ("מתישהו"). \nאזכיר לך לבדוק את זה באחת מביקורות סוף השבוע שלנו! 💡`);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    }

    if (detectReminderIntent(text)) {
      const parsed = parseReminder(text);
      if (parsed) {
        const { data: duplicates } = await supabase.from("reminders").select("id, text, type, time").eq("chat_id", chatId).eq("active", true);
        const duplicate = (duplicates ?? []).find((item: any) => item.text.trim().toLowerCase() === parsed.task.trim().toLowerCase() && item.type === parsed.type && Math.abs(new Date(item.time).getTime() - parsed.dueAt.getTime()) < 60_000);
        if (duplicate) {
          await sendMessage(chatId, `כבר יש לך תזכורת כזאת ל"${parsed.task}". לא הוספתי עוד אחת.`);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        await supabase.from("reminders").insert({ chat_id: chatId, text: parsed.task, type: parsed.type, time: parsed.dueAt.toISOString(), active: true });
        const label = reminderScheduleLabel(parsed.dueAt, parsed.type);
        await sendMessage(chatId, pickReminderCreated(personality, parsed.task, label));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      
      // Smart Scheduling: If no explicit time was provided, use Gemini to suggest a logical time
      try {
        const timeFormatter = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "long" });
        const nowStr = timeFormatter.format(new Date());
        const model = await extractionModel(GEMINI_API_KEY);
        const prompt = `המשתמש ביקש תזכורת: "${text}".
הזמן המקומי כרגע בישראל הוא: ${nowStr}.
אם המשתמש ציין במפורש תאריך ושעה (למשל "ב-25/11 בשעה 14:00"), חלץ אותם במדויק. 
אם המשתמש לא ציין מתי להזכיר לו, הצע מועד הגיוני לתזכורת בעתיד בהתבסס על המשימה (למשל: שיחות למוסדות - 09:00).
אם לא ניתן להסיק, קבע לעוד שעתיים.
החזר אך ורק אובייקט JSON תקני עם:
"task": ניסוח קצר של המשימה נטו (למשל "תור לרופא").
"time": הזמן שנקבע בפורמט ISO 8601 מלא. חייב להיות בעתיד!
"is_smart_guess": boolean (true אם המשתמש לא ציין זמן והיית צריך להסיק לבד, false אם הוא ציין זמן במפורש).
"reason": הסבר קצר (למשל "צוין בבקשה" או "שעות פעילות").
אל תחזיר טקסט מחוץ ל-JSON.`;
        
        const res = await callGoogleGeminiModel(GEMINI_API_KEY, model, "החזר JSON בלבד", [], prompt, 8_000);
        if (res.ok) {
          const smart = JSON.parse(res.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim());
          if (smart.time && smart.task) {
            const dueAt = new Date(smart.time);
            if (dueAt.getTime() > Date.now()) {
              await supabase.from("reminders").insert({ chat_id: chatId, text: smart.task, type: "once", time: dueAt.toISOString(), active: true });
              const label = reminderScheduleLabel(dueAt, "once");
              const personality = resolveActivePersonality(user);
              const customMessage = pickReminderCreated(personality, smart.task, label);
              
              if (smart.is_smart_guess) {
                await sendMessage(chatId, `${customMessage}\n(נקבע אוטומטית כי: ${smart.reason}).\nאם בא לך שעה אחרת, פשוט תכתוב "תשנה למחר ב-10".`);
              } else {
                await sendMessage(chatId, customMessage);
              }
              return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
          }
        }
      } catch (e) {
        console.error("[smart-schedule] failed:", e);
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

    const lastMsg = history.length > 0 ? history[history.length - 1] : null;
    const gapMinutes = lastMsg?.created_at ? (Date.now() - new Date(lastMsg.created_at).getTime()) / 60_000 : 0;
    let timeGapLayer = "";
    if (gapMinutes > 180) { // 3 hours
      timeGapLayer = `שים לב: עברו ${Math.round(gapMinutes / 60)} שעות מאז ההודעה האחרונה. הגב בהתאם לפער הזמן ואל תמשיך את השיחה בדיוק מאותה נקודה. אם דיברתם קודם על משימה פתוחה, אפשר לשאול איך הלך. אם לא, פשוט תגיד היי או תשאל מה קורה, ואל תמציא נושאים או משימות שלא היו קיימים.`;
    }

    const mode = /אין לי כוח|קשה לי|עייף|שרוף/.test(text) ? "frustration" : /סיימתי|עשיתי|הצלחתי|שלחתי|סגרתי|קבעתי|השלמתי|בוצע|סגור|סידרתי|ניקיתי|הלכתי|כתבתי/.test(text) ? "success" : "casual";
    const mood = pickMood(personality, { mode, hourLocal: new Date().getHours(), repeatStreak: 0, gapMinutes, prevMood: user.mood });
    const humor = humorPolicy({ text, mode, tone: "neutral", intensity: 0, mood, userHumorLevel: profile.humor_level });
    const deep = detectDeepMode(text, history);
    
    let praiseLayer = "";
    if (mode === "success") {
      praiseLayer = "המשתמש ציין שהוא סיים משימה או עשייה. פרגן לו! בנוסף: אם מדובר במשימה פיזית (כמו סידור החדר או אימון) ואתה במצב רוח ציני או חושד שהוא רק מתבדח/מורח אותך, אתגר אותו בהומור ובקש תמונה כהוכחה (למשל 'שלח תמונה של החדר לראות שהוא באמת מסודר'). לא חובה בכל פעם, רק כשזה מתאים לזרימה.";
    }

    const material = [...goals.map((g: any) => g.title), ...events.map((e: any) => e.title)];
    const surprise = rollSurprise(material.length > 0, deep.deep);
    const decision = decisionEngine({ text, pacing: pace, hasMemory: memories.length > 0, hasGoals: goals.length > 0, humorLevel: profile.humor_level, mood: moodLabel(mood) });

    const timeFormatter = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, weekday: "long", hour: "2-digit", minute: "2-digit" });
    const currentTimeStr = timeFormatter.format(new Date());
    const currentTimeLayer = `זמן נוכחי: יום ${currentTimeStr}. קח את הזמן בחשבון כדי להבין מה המשתמש עושה כעת (למשל אם הוא בעבודה, בדרך, או הולך לישון) על סמך ההרגלים שלו.`;

    const layers = [
      currentTimeLayer,
      timeGapLayer,
      praiseLayer,
      memoryContext(memories), confidenceContext(memories), profileContext(profile), goalContext(goals), eventContext(events), insideJokeContext(jokes),
      coreferenceInstruction(text, history), implicitIntentLayer(text, { events, goals, reminders: (remData.data ?? []).map((r: { text: string }) => r.text) }),
      moodInstruction(mood, 0), humor.instruction, toneOverrideInstruction(user.tone_override), followUpNudge(text), linkedReasoning(text, memories, goals, profile), selfCorrectionLayer(text, memories, goals),
      deep.deep ? deepModeInstruction(deep.topic) : pace.instruction, surpriseInstruction(surprise, material), antiRepetitionInstruction(recentPhrases), decision.layer,
    ];

    background(saveMessage(chatId, "user", text), "save_user");

    const reply = await askGemini(text, personality, history, "", layers, media);

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
