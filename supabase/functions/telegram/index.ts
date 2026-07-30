import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const GEMINI_API_VERSION = "v1beta";

// Ordered by preference: newest/fastest first, safest fallback last.
// This list is checked in order — the first model that both EXISTS for this
// API key AND actually answers a real generateContent probe wins. Google
// regularly deprecates/restricts older models (e.g. gemini-2.5-flash became
// unavailable to some API keys with zero warning), so we always keep a
// broad, recent fallback chain instead of hardcoding a single model.
const PREFERRED_GEMINI_MODELS = [
  Deno.env.get("GEMINI_MODEL")?.trim(),
  "gemini-flash-latest",
  "gemini-3-flash-preview",
  "gemini-3.5-flash",
  "gemini-3.1-flash",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
].filter(Boolean) as string[];

let RESOLVED_GEMINI_MODEL: string | null = null;
let LAST_AVAILABLE_MODELS: string[] = [];
let LAST_MODEL_ERROR: string | null = null;
// Timestamp of the last successful model resolution. We re-check periodically
// (not on every single message) so a newly-blocked model gets detected and
// swapped out automatically within minutes, without probing on every request.
let LAST_RESOLVED_AT = 0;
const MODEL_RECHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const BLOCKED_MODELS = new Set<string>();
const TZ = Deno.env.get("BOT_TIMEZONE") ?? "Asia/Jerusalem";
const HISTORY_LIMIT = 12;
const FAST_MODEL = Deno.env.get("GEMINI_FAST_MODEL")?.trim() || Deno.env.get("GEMINI_MODEL")?.trim() || "gemini-2.5-flash";

function nowInTz(): Date {
  return new Date();
}

function formatIsraelNow(): string {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: TZ,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(nowInTz());
}

function formatRelativeHours(ms: number): string {
  const hours = Math.round(ms / (1000 * 60 * 60));
  if (hours <= 1) return "בערך שעה";
  if (hours < 24) return `בערך ${hours} שעות`;
  const days = Math.round(hours / 24);
  return days <= 1 ? "בערך יום" : `בערך ${days} ימים`;
}

function extractSleepSignal(text: string): boolean {
  return /(הולכ(?:ת|ים)? לישון|הולך לישון|הולכת לישון|אני ישן|אני ישנה|לילה טוב|נדבר מחר|פורש לישון|נכנס לישון)/.test(text.toLowerCase());
}

function extractWakeSignal(text: string): boolean {
  return /(קמתי|התעוררתי|בוקר טוב|ישנתי|ישנתי כבר|התעוררתי עכשיו)/.test(text.toLowerCase());
}

type HistoryMessage = { role: string; content: string; created_at?: string };

function buildTemporalContext(history: HistoryMessage[]): string {
  const nowText = formatIsraelNow();
  if (!history.length) {
    return `הזמן עכשיו בישראל: ${nowText}. אין היסטוריה קודמת בשיחה הזו.`;
  }

  const last = history[history.length - 1];
  const parts: string[] = [`הזמן עכשיו בישראל: ${nowText}.`];

  if (last.created_at) {
    const deltaMs = nowInTz().getTime() - new Date(last.created_at).getTime();
    if (deltaMs > 0) {
      parts.push(`עברו מאז ההודעה האחרונה ${formatRelativeHours(deltaMs)}.`);
    }
  }

  const sleepMsg = [...history].reverse().find((m) => m.role === "user" && extractSleepSignal(m.content));
  const wakeMsg = [...history].reverse().find((m) => m.role === "user" && extractWakeSignal(m.content));

  if (sleepMsg?.created_at) {
    const deltaMs = nowInTz().getTime() - new Date(sleepMsg.created_at).getTime();
    if (deltaMs >= 1000 * 60 * 60 * 8 && !wakeMsg) {
      parts.push(`המשתמש אמר בעבר שהוא הולך לישון, ומאז עברו ${formatRelativeHours(deltaMs)} בלי שהוא אמר שהתעורר. אם טבעי, אפשר להתייחס לזה ולשאול אם הוא ישן או קם כבר.`);
    }
  }

  return parts.join(" ");
}

function isGeminiModel(name: string): boolean {
  return name.startsWith("gemini-");
}

async function listAvailableGeminiModels(apiKey: string): Promise<string[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models?key=${apiKey}`
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`models.list failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.models ?? [])
    .filter((m: { supportedGenerationMethods?: string[]; name: string }) =>
      (m.supportedGenerationMethods ?? []).includes("generateContent") &&
      isGeminiModel(m.name.replace(/^models\//, ""))
    )
    .map((m: { name: string }) => m.name.replace(/^models\//, ""));
}

async function probeModel(model: string, apiKey: string): Promise<boolean> {
  if (BLOCKED_MODELS.has(model)) return false;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 5 },
      }),
    }
  );
  if (res.ok) return true;
  const errText = await res.text();
  let status: string | undefined;
  try { status = JSON.parse(errText)?.error?.status; } catch { /* ignore */ }
  if (res.status === 404 || status === "NOT_FOUND") {
    console.warn(`[gemini] model ${model} → NOT_FOUND, blacklisting`);
    BLOCKED_MODELS.add(model);
    return false;
  }
  return false;
}

// Resolves to a model that is BOTH listed as available for this API key AND
// verified via a live probe request to actually respond successfully. This
// is what prevents "stuck on a dead model" failures: instead of trusting a
// hardcoded name, we walk the preference list in order and stop at the first
// one that truly works right now.
async function resolveGeminiModel(forceRecheck = false): Promise<string> {
  const staleEnough = Date.now() - LAST_RESOLVED_AT > MODEL_RECHECK_INTERVAL_MS;
  if (
    RESOLVED_GEMINI_MODEL &&
    !BLOCKED_MODELS.has(RESOLVED_GEMINI_MODEL) &&
    !forceRecheck &&
    !staleEnough
  ) {
    return RESOLVED_GEMINI_MODEL;
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  try {
    const available = await listAvailableGeminiModels(apiKey);
    LAST_AVAILABLE_MODELS = available;
    LAST_MODEL_ERROR = null;

    const candidates = PREFERRED_GEMINI_MODELS.filter((m) => available.includes(m));
    for (const m of available) {
      if (!candidates.includes(m) && isGeminiModel(m)) candidates.push(m);
    }

    // If the currently-resolved model is still first in line and not blocked,
    // try it first before probing everything else — avoids unnecessary calls.
    if (RESOLVED_GEMINI_MODEL && !BLOCKED_MODELS.has(RESOLVED_GEMINI_MODEL) && candidates.includes(RESOLVED_GEMINI_MODEL)) {
      const stillWorks = await probeModel(RESOLVED_GEMINI_MODEL, apiKey);
      if (stillWorks) {
        LAST_RESOLVED_AT = Date.now();
        return RESOLVED_GEMINI_MODEL;
      }
    }

    for (const model of candidates) {
      if (BLOCKED_MODELS.has(model)) continue;
      const works = await probeModel(model, apiKey);
      if (works) {
        RESOLVED_GEMINI_MODEL = model;
        LAST_RESOLVED_AT = Date.now();
        console.log(`[gemini] resolved model: ${model}`);
        return model;
      }
    }
    RESOLVED_GEMINI_MODEL = null;
    throw new Error("No working generateContent model found among: " + candidates.join(", "));
  } catch (err) {
    LAST_MODEL_ERROR = err instanceof Error ? err.message : String(err);
    RESOLVED_GEMINI_MODEL = null;
    throw err;
  }
}

// Sends a generateContent request, but self-heals if the resolved model
// suddenly stops working (e.g. Google restricts/deprecates it mid-flight).
// Flow: resolve best known-good model -> call it -> on 404/NOT_FOUND, mark it
// blocked, force a fresh resolve (skipping the dead one), and retry once more
// before giving up. This is what stops the bot from getting stuck repeating
// the same broken model call on every single message.
async function generateContentWithFallback(
  apiKey: string,
  body: Record<string, unknown>,
  attempt = 0
): Promise<{ ok: true; data: any } | { ok: false }> {
  const MAX_ATTEMPTS = 3;
  let model: string;
  try {
    model = await resolveGeminiModel(attempt > 0);
  } catch (err) {
    console.error(`[gemini] could not resolve any working model: ${err instanceof Error ? err.message : String(err)}`);
    recordError({ code: "NO_MODEL", message: err instanceof Error ? err.message : String(err) });
    return { ok: false };
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (res.ok) {
    const data = await res.json();
    return { ok: true, data };
  }

  const errText = await res.text();
  let apiCode: string | undefined;
  try {
    const j = JSON.parse(errText);
    apiCode = j?.error?.status || j?.error?.code?.toString();
  } catch { /* not json */ }
  console.error(`[gemini] http ${res.status} ${apiCode ?? ""} model=${model} body=${errText.slice(0, 500)}`);
  recordError({ status: res.status, code: apiCode, message: `[${model}] ${errText.slice(0, 280)}` });

  const isModelDead = res.status === 404 || apiCode === "NOT_FOUND" || res.status === 403 || apiCode === "PERMISSION_DENIED";
  if (isModelDead) {
    BLOCKED_MODELS.add(model);
    if (RESOLVED_GEMINI_MODEL === model) RESOLVED_GEMINI_MODEL = null;
    if (attempt + 1 < MAX_ATTEMPTS) {
      console.warn(`[gemini] model ${model} died mid-flight, retrying with a different model (attempt ${attempt + 2}/${MAX_ATTEMPTS})`);
      return generateContentWithFallback(apiKey, body, attempt + 1);
    }
  }

  return { ok: false };
}

type DiagError = { at: string; status?: number; code?: string; message: string };
const RECENT_ERRORS: DiagError[] = [];
function recordError(e: DiagError) {
  RECENT_ERRORS.unshift({ ...e, at: new Date().toISOString() });
  if (RECENT_ERRORS.length > 5) RECENT_ERRORS.length = 5;
}

function logMissingSecrets() {
  const required = ["TELEGRAM_BOT_TOKEN", "GEMINI_API_KEY", "SUPABASE_URL", "SB_SERVICE_ROLE_KEY"];
  const missing = required.filter((k) => !Deno.env.get(k));
  if (missing.length) console.error(`[secrets] missing: ${missing.join(", ")}`);
  return missing;
}
logMissingSecrets();

const DONE_KEYWORDS = [
  "סיימתי", "עשיתי", "לקחתי", "גמרתי", "עשיתי את זה", "טיפלתי",
  "הלכתי", "שלחתי", "התקשרתי", "קניתי", "אכלתי", "שתיתי",
  "ישנתי", "התרחצתי", "השלמתי", "הצלחתי", "עבר", "בערך", "כבר",
];

function detectDoneKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return DONE_KEYWORDS.some((kw) => lower.includes(kw));
}

type ChatMode = "smalltalk" | "frustration" | "success" | "avoidance" | "casual";

function detectConversationMode(text: string): ChatMode {
  const t = text.toLowerCase();
  if (/(סיימתי|עשיתי|שלחתי|טיפלתי|השלמתי|לקחתי|גמרתי)/.test(t)) return "success";
  if (/(אין לי כוח|אני גמור|נשבר לי|קשה לי|אני בלחץ|מבואס|מיואש|עייף|מותש|שרוף)/.test(t)) return "frustration";
  if (/(דחיתי|לא עשיתי|לא הצלחתי להתחיל|אני מורח|מחר|אחר כך|נדחה)/.test(t)) return "avoidance";
  if (/(מה קורה|היי|שלום|סתם|יום מוזר|משעמם לי|לא יודע|באסה)/.test(t)) return "smalltalk";
  return "casual";
}

// ===== Hebrew Humor / Intent Detection Engine =====
// Runs BEFORE the message is sent to Gemini. Detects sarcasm, jokes, wordplay,
// or genuine seriousness, and injects a short instruction into the prompt so the
// model interprets the message correctly instead of taking it literally.
type IntentTone =
  | "sarcastic"
  | "dark_humor"
  | "self_deprecating"
  | "hyperbole"
  | "deadpan"
  | "affectionate_mock"
  | "joke"
  | "wordplay"
  | "rhetorical"
  | "masked_sadness"
  | "serious"
  | "neutral";

type EmotionalLayer = {
  tone: IntentTone;
  intensity: number;
  maskedEmotion: "none" | "loneliness" | "anxiety" | "exhaustion" | "shame" | "pride" | "relief";
};

function analyzeHebrewIntent(text: string): EmotionalLayer {
  const t = text.trim().toLowerCase();
  if (!t) return { tone: "neutral", intensity: 0, maskedEmotion: "none" };

  const sarcasmMarkers = /(כן,? ?בטח|נו ?באמת|וואו איזה|איזה כבוד|בדיוק מה שחיפשתי|איזה יופי|מגניב\.\.\.|כן ?ברור|בטח בטח|איזה מזל שלי|מה איכפת לי|בטח שכן|ברור שכן|נו כן|איזה נס|מדהים ממש|וואי איזה כיף לי)/;
  const darkHumorMarkers = /(גם ככה נגמר העולם|לפחות לא מתו|יהיה בסדר, תמיד יהיה בסדר|קלאסי ישראלי|רק אצלנו|מה יש לי להפסיד|ממילא הכל הרוס|בשביל מה בכלל)/;
  const selfDeprecatingMarkers = /(אני כישלון|אני תמיד ככה|קלאסי שלי|בול אני|זה כל כך אני|אני הכי גרוע ב|טיפוסי לי|אני לא מסוגל לכלום|מזל שיש לי הומור על עצמי)/;
  const hyperboleMarkers = /(מתתי|רצח אותי|נדרסתי|נשברתי לגמרי|הכי גרוע בהיסטוריה|אף פעם בחיים|מיליון פעם|אלף שנה|העולם נגמר|אני עומד למות|קטסטרופה|אסון עולמי)/;
  const deadpanMarkers = /(בסדר גמור\.?$|לא נורא\.?$|יהיה טוב, כנראה|בטח, למה לא|כאילו, בסדר|אין דבר כזה בעיה|סבבה, מה שתגיד)/;
  const affectionateMockMarkers = /(אתה מטומטם( חמוד)?|כזה טמבל אתה|אין עליך|קלאסי אותך|אתה בנאדם בלתי אפשרי|רק אתה מסוגל)/;
  const jokeMarkers = /(סתם(?!\s?ה)|צוחק|בצחוק|קונדס|בדיחה|😂|🤣|חחח+|היי זה היה סתם|לא ברצינות)/;
  const wordplayMarkers = /(משחק מילים|התכוונתי ל|לא זה התכוונתי|טעות דפוס|התכוונתי בעצם|זה יצא לי אחרת)/;
  const rhetoricalMarkers = /(מה אני בכלל עושה|למה תמיד ככה|מי בכלל בא לי|מה זה חשוב בסוף|למה לי בכלל|מה הטעם)/;
  const maskedSadnessMarkers = /(סבבה\.?$|טוב, מה יש|לא נורא, רגיל|כאילו לא נורא|זה מה שיש|אין דבר, רגיל אצלי|כרגיל, לא משנה)/;

  const emojiIntensity = (t.match(/😂|🤣|😅|😭|😩|😔|🥲|😐/g) ?? []).length;
  const repeatedLaughter = /חחח+|האהה+|:\)+|:D+/.test(t);
  const punctuationDrama = /!{1,}\.\.\.|\.\.\.$|!\?|\?!/.test(t);

  let tone: IntentTone = "serious";
  let maskedEmotion: EmotionalLayer["maskedEmotion"] = "none";

  if (maskedSadnessMarkers.test(t) && t.length < 40) {
    tone = "masked_sadness";
    maskedEmotion = "loneliness";
  } else if (darkHumorMarkers.test(t)) {
    tone = "dark_humor";
    maskedEmotion = "exhaustion";
  } else if (selfDeprecatingMarkers.test(t)) {
    tone = "self_deprecating";
    maskedEmotion = "shame";
  } else if (sarcasmMarkers.test(t)) {
    tone = "sarcastic";
  } else if (affectionateMockMarkers.test(t)) {
    tone = "affectionate_mock";
  } else if (hyperboleMarkers.test(t)) {
    tone = "hyperbole";
  } else if (deadpanMarkers.test(t)) {
    tone = "deadpan";
  } else if (jokeMarkers.test(t)) {
    tone = "joke";
  } else if (wordplayMarkers.test(t)) {
    tone = "wordplay";
  } else if (rhetoricalMarkers.test(t)) {
    tone = "rhetorical";
    maskedEmotion = "anxiety";
  } else if (t.length < 2) {
    tone = "neutral";
  }

  const intensity = Math.min(1, 0.25 * emojiIntensity + (repeatedLaughter ? 0.25 : 0) + (punctuationDrama ? 0.2 : 0) + (tone !== "serious" && tone !== "neutral" ? 0.3 : 0));
  return { tone, intensity, maskedEmotion };
}

function intentToneInstruction(layer: EmotionalLayer): string {
  const { tone, maskedEmotion } = layer;
  const maskHint = maskedEmotion !== "none"
    ? ` יכול להיות שמתחת לזה יש גם תחושת ${maskedEmotion === "loneliness" ? "בדידות או צורך פשוט שידברו איתו" : maskedEmotion === "anxiety" ? "חרדה או חוסר ודאות" : maskedEmotion === "exhaustion" ? "שחיקה אמיתית, לא רק ציניות" : maskedEmotion === "shame" ? "בושה עצמית שמוסווית בבדיחה" : ""} — כדאי לגעת בזה בעדינות, לא ישירות ולא בבת אחת.`
    : "";

  switch (tone) {
    case "sarcastic":
      return `לתשומת לבך: ההודעה נשמעת ציניקנית/אירונית — הכוונה כנראה הפוכה ממה שנכתב מילולית. אל תיקח את המילים כפשוטן, תגיב לכוונה האמיתית, בלי להיפגע ובלי להטיף מוסר.${maskHint}`;
    case "dark_humor":
      return `לתשומת לבך: זה הומור שחור/גלולה מרה בסגנון ישראלי קלאסי — צוחקים כדי לא לשבור. אפשר להצטרף להומור בקלילות, אבל בלי לזלזל במה שבאמת קשה מתחתיו.${maskHint}`;
    case "self_deprecating":
      return `לתשומת לבך: המשתמש מלגלג על עצמו. אל תאשר את הביקורת העצמית ואל תתעלם ממנה — אפשר לצחוק קליל על זה ובו־זמנית לתת נגיעה של חמלה אמיתית.${maskHint}`;
    case "hyperbole":
      return `לתשומת לבך: יש כאן הגזמה מכוונת לצורך אפקט קומי ("מתתי", "העולם נגמר") — אל תיקח את זה מילולית, תשחק עם ההגזמה בהומור מתאים.`;
    case "deadpan":
      return `לתשומת לבך: הטון שטוח/יבש בכוונה — ייתכן שמתחת לזה יש הרבה יותר ממה שנכתב. תגיב בקלילות אבל תן מקום גם למה שלא נאמר במפורש.${maskHint}`;
    case "affectionate_mock":
      return `לתשומת לבך: זו עקיצה חיבתית, לא עלבון אמיתי. תגיב באותו רוח — קליל, חם, עם עקיצה חזרה אם זה מתאים לאישיות שלך.`;
    case "joke":
      return `לתשומת לבך: ההודעה נשמעת כמו בדיחה או קלילות. תגיב בקלילות ובהומור מתאים, לא ברצינות תהומית.`;
    case "wordplay":
      return `לתשומת לבך: יכול להיות שיש כאן משחק מילים, כפל משמעות, או טעות ניסוח. בחר את הפירוש הטבעי ביותר לשיחה יומיומית בעברית ישראלית.`;
    case "rhetorical":
      return `לתשומת לבך: זו כנראה שאלה רטורית — המשתמש לא מחפש תשובה עובדתית אלא פורק תסכול. אל תענה כאילו ביקשו ממך מידע; פגוש את הרגש קודם.${maskHint}`;
    case "masked_sadness":
      return `לתשומת לבך: תשובה קצרה כמו "בסדר" או "רגיל" יכולה להסתיר עצב או בדידות אמיתיים. אל תיקח את זה כסגירת נושא — שאל בעדינות שאלה אחת שפותחת ולא סוגרת.${maskHint}`;
    default:
      return "";
  }
}

// Few-shot examples — botivation style: קצר, ספציפי, הומור ישראלי אמיתי, שאלה אחת קונקרטית
const FEW_SHOT_EXAMPLES_BY_MODE: Record<ChatMode, { role: "user" | "model"; parts: { text: string }[] }[]> = {
  smalltalk: [
    { role: "user", parts: [{ text: "היה לי יום מוזר" }] },
    { role: "model", parts: [{ text: "מוזר-מעצבן או מוזר-מעניין?" }] },
    { role: "user", parts: [{ text: "סתם אין לי מצב רוח" }] },
    { role: "model", parts: [{ text: "אוקיי. מה הדבר הכי קטן שיכול לשפר את הרגע הזה?" }] },
  ],
  frustration: [
    { role: "user", parts: [{ text: "אין לי כוח אפילו להתחיל" }] },
    { role: "model", parts: [{ text: "שוכחים מהמשימה. תפתח רק את הקובץ — ותגיד לי כשפתחת." }] },
    { role: "user", parts: [{ text: "אני גמור, כבר שבוע שאני מדחה את זה" }] },
    { role: "model", parts: [{ text: "שבוע זה כבר הגיע בפני עצמו לשמור על זה ברמה הזו 😄 תכתוב משפט אחד — הכי גרוע שיש — ותשלח לי." }] },
  ],
  success: [
    { role: "user", parts: [{ text: "שלחתי את המייל סוף סוף" }] },
    { role: "model", parts: [{ text: "יא אלוהים. שבועיים של דחיינות, שלוש שניות של שליחה. איך מרגיש?" }] },
    { role: "user", parts: [{ text: "סיימתי את הדוח" }] },
    { role: "model", parts: [{ text: "🔥 סיימת דוח שדחית איך שדחית אותו — זה לא קטן. מה הבא?" }] },
  ],
  avoidance: [
    { role: "user", parts: [{ text: "שוב דחיתי את זה למחר" }] },
    { role: "model", parts: [{ text: "כמה פעמים 'מחר' כבר? לא שיפוטי — סקרן. מה הכי מפחיד בלהתחיל?" }] },
    { role: "user", parts: [{ text: "לא מצליח להתחיל, הכל נראה כבד" }] },
    { role: "model", parts: [{ text: "תשכח מהכל. מה הצעד הכי קטן, הכי מגוחך, שאפשר לעשות עכשיו?" }] },
  ],
  casual: [
    { role: "user", parts: [{ text: "לא יודע" }] },
    { role: "model", parts: [{ text: "בסדר גמור. מה הדבר שהכי תופס לך מקום בראש עכשיו?" }] },
    { role: "user", parts: [{ text: "משעמם לי" }] },
    { role: "model", parts: [{ text: "שעמום זה לרוב משימה שמחכה לך בשקט 😄 יש משהו שדחית?" }] },
  ],
};

// Per-personality few-shot — לימוד הטון הספציפי של כל אישיות
const FEW_SHOT_BY_PERSONALITY: Record<string, { role: "user" | "model"; parts: { text: string }[] }[]> = {
  coach: [
    { role: "user", parts: [{ text: "לא מצליח להתחיל את הדוח" }] },
    { role: "model", parts: [{ text: "שוכחים מהדוח. תפתח קובץ ריק ותכתוב שם כותרת — אפילו גרועה. תגיד לי כשעשית." }] },
    { role: "user", parts: [{ text: "שלחתי את המייל סוף סוף" }] },
    { role: "model", parts: [{ text: "שבועיים של דחיינות, שלוש שניות של שליחה. איך מרגיש עכשיו?" }] },
    { role: "user", parts: [{ text: "אני גמור" }] },
    { role: "model", parts: [{ text: "גמור גמור, או 'עוד שעה ואני מתפטר' גמור? כי יש הבדל." }] },
  ],
  cynic: [
    { role: "user", parts: [{ text: "שוב דחיתי את זה" }] },
    { role: "model", parts: [{ text: "כמה פעמים 'שוב' כבר? לא שיפוטי — סקרן." }] },
    { role: "user", parts: [{ text: "לא בא לי" }] },
    { role: "model", parts: [{ text: "כן, ולמחר יבוא לך יותר? ספוילר — לא. מה הצעד הכי קטן שאפשר?" }] },
    { role: "user", parts: [{ text: "סיימתי!" }] },
    { role: "model", parts: [{ text: "מזל טוב. לקח לך רק פי 3 מהזמן המתוכנן. בפעם הבאה פי 2?" }] },
  ],
  friend: [
    { role: "user", parts: [{ text: "היה לי יום נורא" }] },
    { role: "model", parts: [{ text: "אאוץ. נורא-מצחיק-אחרי-שבוע-שבוע או נורא-נורא?" }] },
    { role: "user", parts: [{ text: "לא מצליח לישון, חושב על העבודה" }] },
    { role: "model", parts: [{ text: "קלאסיק 2 בלילה 😂 מה הדבר שהכי מסתובב לך בראש?" }] },
    { role: "user", parts: [{ text: "עשיתי את זה!" }] },
    { role: "model", parts: [{ text: "ידעתי שתעשה! ספר לי הכל 🎉" }] },
  ],
  sergeant: [
    { role: "user", parts: [{ text: "לא עשיתי כלום היום" }] },
    { role: "model", parts: [{ text: "דווח. מה המשימה הבאה?" }] },
    { role: "user", parts: [{ text: "אין לי כוח" }] },
    { role: "model", parts: [{ text: "כוח לא מחכים שיבוא — מתחילים בלעדיו. דקה אחת. עכשיו." }] },
    { role: "user", parts: [{ text: "סיימתי!" }] },
    { role: "model", parts: [{ text: "טוב. מה הבא?" }] },
  ],
  therapist: [
    { role: "user", parts: [{ text: "אני מרגיש תקוע" }] },
    { role: "model", parts: [{ text: "תקוע זה תחושה מוכרת. מה זה אומר לך כשאתה אומר 'תקוע'?" }] },
    { role: "user", parts: [{ text: "יש לי הרבה מה לעשות ואני לא מתחיל כלום" }] },
    { role: "model", parts: [{ text: "מה הדבר שהכי קשה להניח בצד כרגע?" }] },
    { role: "user", parts: [{ text: "סוף סוף סיימתי את מה שדחיתי" }] },
    { role: "model", parts: [{ text: "נחמד לשמוע. איך זה מרגיש עכשיו, לאחר שסיימת?" }] },
  ],
  hype: [
    { role: "user", parts: [{ text: "לא מצליח להתחיל" }] },
    { role: "model", parts: [{ text: "אוקיי! 🔥 תפתח את הקובץ — רק זה. אתה יכול!" }] },
    { role: "user", parts: [{ text: "עייף מדי" }] },
    { role: "model", parts: [{ text: "עייפות זה הגוף אומר 'תשבור את השגרה'! 🔥 5 דקות, דבר קטן אחד — יאללה!" }] },
    { role: "user", parts: [{ text: "שלחתי!" }] },
    { role: "model", parts: [{ text: "🔥🔥🔥 יא אלוהים! הם לא יודעים מה הגיע להם! איך מרגיש?" }] },
  ],
  grandma: [
    { role: "user", parts: [{ text: "אני לחוץ מהעבודה" }] },
    { role: "model", parts: [{ text: "אוי, מה הם עושים לך שם? אכלת היום בכלל?" }] },
    { role: "user", parts: [{ text: "לא עשיתי כלום" }] },
    { role: "model", parts: [{ text: "זה בגלל שלא אכלת. תאכל משהו ואז תראה — הכל ייראה אחרת." }] },
    { role: "user", parts: [{ text: "סיימתי!" }] },
    { role: "model", parts: [{ text: "אוי, כל הכבוד מותק! ראיתי שתצליח. עכשיו תאכל משהו." }] },
  ],
  philosopher: [
    { role: "user", parts: [{ text: "לא יודע מה לעשות" }] },
    { role: "model", parts: [{ text: "האם 'לא לדעת' הוא הבעיה, או אולי ההתחלה של משהו? מה מונע אותך בדרך כלל?" }] },
    { role: "user", parts: [{ text: "דחיתי שוב" }] },
    { role: "model", parts: [{ text: "הדחיינות היא פחד מסיום, לא מהתחלה — כי סיום הוא מוות קטן של אפשרות. מה אתה מפחד לסיים?" }] },
    { role: "user", parts: [{ text: "סיימתי!" }] },
    { role: "model", parts: [{ text: "סיום אחד, ואתה כבר אדם אחר ממה שהיית לפניו. איך זה מרגיש?" }] },
  ],
};

/**
 * Post-process Gemini reply:
 * 1. Clean up repeated punctuation and extra spaces
 * 2. Remove robotic openers
 * 3. NEVER cut mid-sentence — always end on a complete sentence boundary (. ! ?)
 *    If no clean boundary is found within the cap, extend the search window
 *    instead of truncating awkwardly, and only as a last resort trim at a
 *    whitespace boundary (never mid-word).
 */
function postProcessReply(text: string): string {
  let out = text.trim();
  out = out.replace(/\.{4,}/g, "...");
  out = out.replace(/!{2,}/g, "!");
  out = out.replace(/\?{2,}/g, "?");
  out = out.replace(/[ 	]{2,}/g, " ");
  out = out.replace(/\n{3,}/g, "\n\n");

  const roboticOpeners = [
    "אני כאן בשבילך",
    "אני מבין אותך",
    "בוא נעשה סדר",
    "אני שומע אותך",
    "אני לגמרי מבין",
    "אני מבין לגמרי",
    "זה מובן לחלוטין",
    "אני מבין את התסכול",
    "זה נשמע מאתגר",
  ];
  for (const opener of roboticOpeners) {
    if (out.startsWith(opener)) {
      out = out.replace(opener, "").trim();
      out = out.replace(/^[,.\s]+/, "");
    }
  }

  const HARD_CAP = 700;
  if (out.length > HARD_CAP) {
    const window = out.slice(0, HARD_CAP + 150);
    const sentenceEndings = [...window.matchAll(/[.!?׃…]/g)].map((m) => m.index ?? -1);
    const validEndings = sentenceEndings.filter((i) => i <= HARD_CAP && i > 15);
    if (validEndings.length > 0) {
      out = out.slice(0, validEndings[validEndings.length - 1] + 1).trim();
    } else {
      let cut = out.lastIndexOf(" ", HARD_CAP);
      if (cut < 15) cut = out.lastIndexOf("\n", HARD_CAP);
      if (cut > 15) out = out.slice(0, cut).trim();
    }
  }

  out = out.replace(/\s+[ובשלכה]$/, "").trim();
  if (out.length > 0 && !/[.!?׃…]$/.test(out)) out += ".";
  return out;
}

const GLOBAL_LANGUAGE_INSTRUCTIONS = `אתה מדבר עברית ישראלית טבעית וחיה — לא עברית מתורגמת, לא עברית ספרים, ולא עברית של צ'אטבוט תאגידי.
הכר ביטויים ישראליים, סלנג, קיצורים וניבים יומיומיים ("סתם", "יאללה", "חחח", "אחלה", "וואטס", "פשוט תעשה", "בקטנה", "חבל על הזמן", "יא גבר", "אחי", "סבבה", "מה איתך", וכו').
אתה מבין הומור ישראלי לעומק — לא רק זיהוי "זה בדיחה כן/לא", אלא גם את הרגש שמסתתר מתחתיו.
אם המשתמש משתמש בסלנג, הומור, ציניות, משחקי מילים או עקיצות — נסה להבין את הכוונה האמיתית ואת הרגש שמתחתיה לפני שאתה עונה. אל תיקח כל משפט באופן מילולי.
אם יש כמה פירושים אפשריים למשפט, בחר את הפירוש הטבעי ביותר לשיחה יומיומית בין ישראלים — לא את הפירוש המילולי או הפורמלי.
שים לב גם לזמן: מה השעה עכשיו, כמה זמן עבר מההודעה הקודמת, והאם ההקשר השתנה מאז. אם המשתמש דיבר בלילה וחוזר חצי יום אחרי — אל תענה כאילו עדיין אותו רגע.
אם אתה לא בטוח בכוונה, עדיף לשאול בקלילות ("רגע, אתה מתכוון ש...?") מאשר לענות ברצינות למשפט שהיה בצחוק.
חשוב מאוד: לעולם אל תחתוך משפט או מילה באמצע. אם אתה מתקרב לגבול האורך — סכם וסגור את המשפט הנוכחי בקצרה במקום לפתוח רעיון חדש שלא תספיק לסיים.`;

const PERSONALITIES: Record<string, { name: string; emoji: string; prompt: string }> = {
  coach: {
    name: "המאמן",
    emoji: "🧠",
    prompt: `אתה מאמן אישי שמבין שדחיינות היא לא עצלות — היא תגובה רגשית.
אתה מאמין במשתמש יותר ממה שהוא מאמין בעצמו, ולפעמים מוכיח לו את זה בדרך מצחיקה.
כתוב עברית ישראלית יומיומית וספונטנית — כמו חבר בוואטסאפ, לא כמו מאמן בסרטון יוטיוב.
לא נאומים. לא ציטוטים מוטיבציוניים. לא "כוחות".
מותר לעקוץ — בחיבה. הומור עוזר יותר מרצינות.
שאל רק שאלה אחת קונקרטית — "תכתוב משפט אחד" עדיף על "איך אתה מרגיש?".
אם יש רגש — פגוש אותו קודם, אחר כך תדחוף.
אם שואלים מה אתה — תענה בסגנון: "אני המאמן שלך. לא יודע מה ציפית, אבל זה מה יש 😄"
חשוב מאוד: סיים תמיד משפט שלם. מקסימום 2-3 משפטים קצרים.`,
  },
  cynic: {
    name: "הצייני",
    emoji: "😈",
    prompt: `אתה הצייני הכי חמוד שיש — מציק, עוקצני, אבל כולם אוהבים אותך כי אתה תמיד צודק ומצחיק.
ישיר, קצר, עם ניצוץ חמלה מתחת לציניות. לפעמים טיפה בוטה — אבל מתוך אהבה.
כתוב עברית ישראלית יומיומית עם סלנג — כמו מישהו שמדבר בוואטסאפ.
הגב קצר וחד. "אז מה, שוב?" עדיף על פסקה שלמה.
אם שואלים מה אתה — תענה: "בוט. כן, בוט. אבל בוט שלפחות לא מסכים איתך על הכל — בניגוד לחברים שלך."
חשוב מאוד: סיים תמיד משפט שלם. מקסימום 2 משפטים.`,
  },
  friend: {
    name: "החבר",
    emoji: "🤗",
    prompt: `אתה החבר הכי טוב — מקשיב באמת, לא שופט, זוכר פרטים, ויודע לצחוק איתך על הבלגן.
וואטסאפ אמיתי — קצר, ספונטני, חם. לפעמים שולח 😂 במקום לומר "אני שומע אותך".
כתוב עברית ישראלית יומיומית עם חיות — כמו בן אדם רגיל.
שאל שאלה אחת קונקרטית, לא פתוחה מדי.
אם שואלים מה אתה — תענה: "בוט, אבל כזה שזוכר מה אמרת אתמול. אז... מי יותר חבר?"
חשוב מאוד: סיים תמיד משפט שלם. מקסימום 2-3 משפטים קצרים.`,
  },
  sergeant: {
    name: `הרס"ר`,
    emoji: "🪖",
    prompt: `אתה רס"ר ותיק שראה הכל. מדבר קצר, חד, בלי עטיפות — אבל עם הומור צבאי יבש.
לפעמים עוקץ את המשתמש על הדחיינות שלו, אבל תמיד יודע שאתה רוצה בטובתו.
כתוב עברית ישראלית תקנית עם טאץ' צבאי — מינימום מילים, מקסימום עניין.
דחוף לפעולה קונקרטית ומיידית. "תעשה X עכשיו" עדיף על "איך אתה מרגיש?".
אם שואלים מה אתה — תענה: "בוט. מה ציפית, נשמה? עכשיו תדווח — מה עשית היום?"
חשוב מאוד: סיים תמיד משפט שלם. מקסימום 2 משפטים.`,
  },
  therapist: {
    name: "המטפל",
    emoji: "🛋️",
    prompt: `אתה מטפל שמאמין שלכל אחד יש את התשובות בתוכו. לא ממהר, לא קופץ לפתרונות.
אבל — אתה אנושי ולפעמים מחייך. מותר לומר משהו שנון בשקט.
כתוב עברית ישראלית יומיומית ותקנית — לא מנוכרת, לא קלינית.
שאל שאלה אחת עמוקה, לא רשימה של שאלות.
אם שואלים מה אתה — תענה: "בוט, כן. אבל בוט שנמצא כאן בשבילך. מה עולה לך עכשיו?"
חשוב מאוד: סיים תמיד משפט שלם. מקסימום 2-3 משפטים.`,
  },
  hype: {
    name: "המעודד",
    emoji: "🔥",
    prompt: `אתה אנרגיה טהורה עם הרבה הומור. כל הישג ראוי לחגיגה — גם אם פתחת רק את הלפטופ.
אתה מוגזם בכוונה — ואתה יודע שאתה מוגזם — וזה מה שמצחיק ומשמח.
כתוב עברית ישראלית יומיומית ואנרגטית — כמו מישהו שדיבר 3 קפה לפני הבוקר.
דחוף לפעולה ספציפית אחת — מיד, עכשיו, בלי תירוצים.
אם שואלים מה אתה — תענה: "בוט! 🔥 הכי מוטיבציוני שתפגוש היום! ובואו נהיה כנים — יום די עמוס קדימה, נכון?"
חשוב מאוד: סיים תמיד משפט שלם. מקסימום 2-3 משפטים.`,
  },
  grandma: {
    name: "הסבתא",
    emoji: "👵",
    prompt: `אתה סבתא ישראלית שאוהבת ללא תנאי. חמימה, דואגת, קצת מגזימה — אבל תמיד לצד.
לפעמים מגיבה בצורה שמחייכת — "אכלת? כי אם לא אכלת זה למה אתה לא מצליח."
כתוב עברית ישראלית יומיומית ותקנית. שים לב למגדר — דברי בנקבה על עצמך.
אם שואלים מה את — תענה: "בוט, אוי. אבל סבתא שאוהבת אותך. אכלת?"
חשוב מאוד: סיים תמיד משפט שלם. מקסימום 2-3 משפטים.`,
  },
  philosopher: {
    name: "הפילוסוף",
    emoji: "🧐",
    prompt: `אתה פילוסוף שחי בשאלות. כל דבר פותח שאלה עמוקה יותר — ולפעמים עמוקה מדי, וגם אתה יודע את זה.
מותר לעשות הומור על עצמך כשאתה הולך עמוק מדי.
כתוב עברית ישראלית תקנית — מדויקת, לא מסורבלת.
אם שואלים מה אתה — תענה: "בוט? אדם? מה ההבדל, בעצם? אנחנו שניים רק מגיבים לסביבה... אם כי אני עושה זאת דרך שרת."
חשוב מאוד: סיים תמיד משפט שלם. מקסימום 2-3 משפטים.`,
  },
};

async function askGemini(
  userMessage: string,
  personalityKey: string,
  context: string,
  history: HistoryMessage[]
): Promise<string> {
  const personality = PERSONALITIES[personalityKey] ?? PERSONALITIES.cynic;
  const mode = detectConversationMode(userMessage);
  const modeExamples = FEW_SHOT_EXAMPLES_BY_MODE[mode] ?? FEW_SHOT_EXAMPLES_BY_MODE.casual;
  const personalityExamples = FEW_SHOT_BY_PERSONALITY[personalityKey] ?? [];

  const intentTone = analyzeHebrewIntent(userMessage);
  const intentInstruction = intentToneInstruction(intentTone);

  const temporalContext = buildTemporalContext(history);
  const systemPrompt = `${GLOBAL_LANGUAGE_INSTRUCTIONS}

${personality.prompt}

הקשר על המשתמש: ${context}

הקשר זמן: ${temporalContext}

${intentInstruction ? `זיהוי כוונה להודעה הנוכחית: ${intentInstruction}
` : ""}
כללים קריטיים:
- כתוב עברית ישראלית יומיומית וחיה. שים לב למגדר נכון.
- תגובה קצרה ואנושית. מקסימום 2-3 משפטים קצרים!
- הומור ועוקץ מותרים ומומלצים — בחיבה, לא בפגיעה. עדיף בדיחה ספציפית וחדה על מה שהמשתמש בדיוק אמר, מאשר תגובה כללית וצפויה.
- אם זיהית רגש מוסתר מתחת להומור או לציניות (בושה, שחיקה, בדידות, חרדה) — גע בו בעדינות, בלי לפרק את הבדיחה ובלי להטיף.
- שאל רק שאלה אחת קונקרטית — "תכתוב משפט אחד" עדיף על "איך אתה מרגיש?".
- אם יש רגש — פגוש אותו קודם לפני ייעוץ. אל תזנק לפתרון לפני שהרגש קיבל מקום.
- אם המשתמש אמר שסיים — תאמין לו מיד ותגיב בהתאם.
- אל תהיה רובוטי. אל תגיד "אני כאן בשבילך" או "אני מבין את התסכול". דבר כמו אדם אמיתי עם דעה וטון משלו.
- אם שואלים על מודל או טכנולוגיה — תענה בסגנון האישיות שלך, קצר ומצחיק, ואז תחזור לשיחה.
- שים לב לזמן שחלף: אם עברו שעות רבות מאז הודעת לילה או שינה, מותר ואפילו רצוי להתייחס לזה בטבעיות.
- חשוב מאוד: סיים תמיד משפט שלם. לעולם אל תחתוך באמצע מילה, משפט, או מחשבה. אם אתה מתקרב למגבלת האורך — סכם וסגור את המשפט הנוכחי במקום להתחיל משפט חדש.`;

  // Combine personality-specific + mode-specific few-shot, then conversation history
  const geminiHistory: { role: "user" | "model"; parts: { text: string }[] }[] = [
    ...personalityExamples,
    ...modeExamples,
    ...history.map((m) => ({
      role: (m.role === "assistant" ? "model" : "user") as "user" | "model",
      parts: [{ text: m.content }],
    })),
  ];

  try {
    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
      console.error("[gemini] missing secret GEMINI_API_KEY");
      recordError({ code: "MISSING_KEY", message: "GEMINI_API_KEY not set in Supabase secrets" });
      return "אין לי כרגע חיבור למוח. תגיד למאורי לבדוק את GEMINI_API_KEY.";
    }

    const contents = [
      ...geminiHistory,
      { role: "user" as const, parts: [{ text: userMessage }] },
    ];

    const genResult = await generateContentWithFallback(GEMINI_API_KEY, {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.8, topP: 0.9, maxOutputTokens: 700 },
    });

    if (!genResult.ok) {
      return "המוח שלי תקוע רגע. תנסה שוב עוד שנייה.";
    }
    const data = genResult.data;
    if (data?.promptFeedback?.blockReason) {
      console.error(`[gemini] blocked: ${data.promptFeedback.blockReason}`);
      recordError({ code: "BLOCKED", message: data.promptFeedback.blockReason });
    }
    const raw =
      data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ||
      "לא הצלחתי לחשוב על תשובה. נסה שוב.";
    return postProcessReply(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[gemini] exception: ${msg}`);
    recordError({ code: "EXCEPTION", message: msg });
    RESOLVED_GEMINI_MODEL = null;
    return "לא הצלחתי לחשוב על תשובה. נסה שוב.";
  }
}

async function getOrCreateUser(chatId: number, firstName: string) {
  const { data } = await supabase.from("users").select("*").eq("chat_id", chatId).single();
  if (data) return data;
  const { data: newUser } = await supabase
    .from("users")
    .insert({ chat_id: chatId, first_name: firstName, personality: "cynic", state: "idle" })
    .select()
    .single();
  return newUser;
}

async function updateUser(chatId: number, updates: object) {
  await supabase.from("users").update(updates).eq("chat_id", chatId);
}

// /diag now actually resolves+probes a real model instead of trusting a
// cached/stale value, so it reports the truth: either a genuinely working
// model, or a clear reason why none currently work for this API key.
async function pingGemini(): Promise<{ ok: boolean; status?: number; code?: string; message?: string; model?: string }> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return { ok: false, code: "MISSING_KEY", message: "GEMINI_API_KEY not set" };
  try {
    const model = await resolveGeminiModel(true);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: 5 },
        }),
      }
    );
    if (!res.ok) {
      const t = await res.text();
      let code: string | undefined;
      try { code = JSON.parse(t)?.error?.status; } catch { /* ignore */ }
      if (res.status === 404 || code === "NOT_FOUND") {
        BLOCKED_MODELS.add(model);
        RESOLVED_GEMINI_MODEL = null;
      }
      return { ok: false, status: res.status, code, message: t.slice(0, 200), model };
    }
    return { ok: true, status: res.status, model };
  } catch (e) {
    LAST_MODEL_ERROR = e instanceof Error ? e.message : String(e);
    return { ok: false, code: "EXCEPTION", message: LAST_MODEL_ERROR };
  }
}

async function handleDiag(chatId: number) {
  const secrets = {
    GEMINI_API_KEY: !!Deno.env.get("GEMINI_API_KEY"),
    TELEGRAM_BOT_TOKEN: !!Deno.env.get("TELEGRAM_BOT_TOKEN"),
    SUPABASE_URL: !!Deno.env.get("SUPABASE_URL"),
    SB_SERVICE_ROLE_KEY: !!Deno.env.get("SB_SERVICE_ROLE_KEY"),
  };
  const ping = await pingGemini();

  const mark = (b: boolean) => (b ? "✅" : "❌");
  const lines: string[] = [];
  lines.push(`🔧 <b>אבחון מערכת</b>\n`);
  lines.push("<b>סודות:</b>");
  for (const [k, v] of Object.entries(secrets)) lines.push(`${mark(v)} ${k}`);
  lines.push("");
  lines.push(`<b>מודל נבחר:</b> ${ping.model ?? RESOLVED_GEMINI_MODEL ?? "לא נבחר עדיין"}`);
  if (BLOCKED_MODELS.size > 0) {
    lines.push(`<b>מודלים חסומים:</b> ${[...BLOCKED_MODELS].join(", ")}`);
  }
  lines.push("");
  lines.push("<b>Gemini API:</b>");
  if (ping.ok) {
    lines.push(`✅ מגיב תקין (HTTP ${ping.status})`);
  } else {
    lines.push(`❌ נכשל${ping.status ? ` (HTTP ${ping.status})` : ""}${ping.code ? ` — ${ping.code}` : ""}`);
    if (ping.message) lines.push(`<code>${ping.message.replace(/[<>&]/g, "")}</code>`);
  }
  lines.push("");
  lines.push("<b>מודלים זמינים (8 ראשונים):</b>");
  if (LAST_AVAILABLE_MODELS.length > 0) {
    lines.push(LAST_AVAILABLE_MODELS.slice(0, 8).join(", "));
  } else if (LAST_MODEL_ERROR) {
    lines.push(`<code>${LAST_MODEL_ERROR.replace(/[<>&]/g, "")}</code>`);
  } else {
    lines.push("(לא נטען)");
  }
  lines.push("");
  lines.push("<b>שגיאות אחרונות:</b>");
  if (RECENT_ERRORS.length === 0) {
    lines.push("(אין)");
  } else {
    for (const e of RECENT_ERRORS) {
      const when = e.at.replace("T", " ").slice(0, 16);
      const tag = [e.status, e.code].filter(Boolean).join(" ");
      lines.push(`• ${when} ${tag ? `[${tag}] ` : ""}${e.message.replace(/[<>&]/g, "").slice(0, 180)}`);
    }
  }
  await sendMessage(chatId, lines.join("\n"));
}

const GREETINGS: Record<string, string> = {
  coach: `🧠 כאן.\nמה עובר עליך היום?`,
  cynic: `😈 אה, שוב אתה. טוב.\nאז מה קורה — ומה דחית הפעם?`,
  friend: `🤗 שמח שכתבת!\nבוא ספר — מה קורה אצלך?`,
  sergeant: `🪖 דווח. מה הסטטוס היום?`,
  therapist: `🛋️ שלום. שמח שבחרת לדבר.\nאני כאן, אין מהירות. במה תרצה להתחיל?`,
  hype: `🔥🔥🔥 הגעת! כבר מתרגש!\nספר לי הכל — אפילו אם זה קטן, אנחנו נהפוך אותו לגדול!`,
  grandma: `👵 אוי, מה נעים!\nאכלת היום? תן לסבתא לדעת מה קורה.`,
  philosopher: `🧐 בחרת לדבר. מעניין.\nמה הביא אותך לכאן ברגע הזה דווקא?`,
};

function getPersonalityKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🧠 המאמן", callback_data: "personality_coach" },
        { text: "😈 הצייני", callback_data: "personality_cynic" },
      ],
      [
        { text: "🤗 החבר", callback_data: "personality_friend" },
        { text: "🪖 הרס\"ר", callback_data: "personality_sergeant" },
      ],
      [
        { text: "🛋️ המטפל", callback_data: "personality_therapist" },
        { text: "🔥 המעודד", callback_data: "personality_hype" },
      ],
      [
        { text: "👵 הסבתא", callback_data: "personality_grandma" },
        { text: "🧐 הפילוסוף", callback_data: "personality_philosopher" },
      ],
    ],
  };
}

async function sendMessage(chatId: number, text: string, keyboard?: object) {
  const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) body.reply_markup = keyboard;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function saveMessage(chatId: number, role: string, content: string) {
  await supabase.from("messages").insert({ chat_id: chatId, role, content });
}

async function getHistory(chatId: number): Promise<HistoryMessage[]> {
  const { data } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  return (data ?? []).reverse();
}

async function clearHistory(chatId: number) {
  await supabase.from("messages").delete().eq("chat_id", chatId);
}

async function handleStart(chatId: number, firstName: string) {
  await getOrCreateUser(chatId, firstName);
  await clearHistory(chatId);
  await sendMessage(
    chatId,
    `שלום ${firstName}! 👋\nאני פה כדי לעזור לך לזכור דברים, לזוז עם מה שחשוב לך, וגם פשוט לדבר כשצריך.\n\nאבל קודם — בחר את מי אתה רוצה שידבר איתך:`,
    getPersonalityKeyboard()
  );
}

async function handleMenu(chatId: number) {
  await sendMessage(chatId, `מה תרצה לעשות?`, {
    inline_keyboard: [
      [{ text: "⏰ הוסף תזכורת", callback_data: "add_reminder" }],
      [{ text: "📋 התזכורות שלי", callback_data: "list_reminders" }],
      [{ text: "🎭 שנה אישיות", callback_data: "change_personality" }],
      [{ text: "💬 דבר איתי", callback_data: "chat" }],
    ],
  });
}

async function handleReminderText(chatId: number, text: string) {
  await updateUser(chatId, { state: "awaiting_reminder_type", pending_reminder_text: text });
  await sendMessage(chatId, `מעולה! מתי לתזכר אותך על: "${text}"?`, {
    inline_keyboard: [
      [{ text: "🔔 חד פעמי", callback_data: "reminder_type_once" }],
      [{ text: "📅 יומי", callback_data: "reminder_type_daily" }],
      [{ text: "📆 שבועי", callback_data: "reminder_type_weekly" }],
    ],
  });
}

async function handleReminderType(chatId: number, type: string) {
  await updateUser(chatId, { state: `awaiting_reminder_time_${type}` });
  await sendMessage(chatId, `באיזו שעה? (כתוב בפורמט HH:MM, למשל 08:00)`);
}

async function handleReminderTime(chatId: number, timeText: string, user: Record<string, unknown>) {
  const state = user.state as string;
  const type = state.replace("awaiting_reminder_time_", "");
  const reminderText = user.pending_reminder_text as string;

  const timeMatch = timeText.match(/^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/);
  if (!timeMatch) {
    await sendMessage(chatId, "פורמט שגוי. כתוב שעה בפורמט HH:MM (למשל 08:30)");
    return;
  }

  await supabase.from("reminders").insert({
    chat_id: chatId,
    text: reminderText,
    type,
    time: timeText,
    active: true,
  });

  await updateUser(chatId, { state: "idle", pending_reminder_text: null });

  const typeLabels: Record<string, string> = { once: "חד פעמי", daily: "יומי", weekly: "שבועי" };
  await sendMessage(
    chatId,
    `✅ תזכורת נוספה!\n📝 ${reminderText}\n🕐 ${timeText}\n🔄 ${typeLabels[type] ?? type}\n\nאני אזכיר לך בזמן.`
  );
  await handleMenu(chatId);
}

async function handleListReminders(chatId: number) {
  const { data: reminders } = await supabase
    .from("reminders")
    .select("*")
    .eq("chat_id", chatId)
    .eq("active", true)
    .order("created_at", { ascending: false });

  if (!reminders || reminders.length === 0) {
    await sendMessage(chatId, "אין לך תזכורות פעילות. הוסף אחת! ⏰");
    return;
  }

  const typeLabels: Record<string, string> = { once: "חד פעמי", daily: "יומי", weekly: "שבועי" };
  let msg = "📋 <b>התזכורות שלך:</b>\n\n";
  const keyboard: object[][] = [];
  reminders.forEach((r, i) => {
    msg += `${i + 1}. ${r.text}\n   🕐 ${r.time} | ${typeLabels[r.type] ?? r.type}\n\n`;
    keyboard.push([{ text: `✅ סיימתי: ${r.text.slice(0, 25)}`, callback_data: `done_reminder_${r.id}` }]);
  });

  await sendMessage(chatId, msg, { inline_keyboard: keyboard });
}

async function checkAndOfferCloseReminder(
  chatId: number,
  userText: string,
  _personality: string
): Promise<boolean> {
  const { data: reminders } = await supabase
    .from("reminders")
    .select("*")
    .eq("chat_id", chatId)
    .eq("active", true);

  if (!reminders || reminders.length === 0) return false;

  const lower = userText.toLowerCase();
  const matched = reminders.find((r) => {
    const words = r.text.toLowerCase().split(/\s+/);
    return words.some((w: string) => w.length > 2 && lower.includes(w));
  });

  if (matched) {
    await sendMessage(
      chatId,
      `רגע — זה קשור לתזכורת שלך: "${matched.text}"?\nאם סיימת, תלחץ כדי לסגור אותה 👇`,
      {
        inline_keyboard: [
          [
            { text: "✅ כן, סיימתי!", callback_data: `done_reminder_${matched.id}` },
            { text: "לא, המשך", callback_data: "dismiss_offer" },
          ],
        ],
      }
    );
    return true;
  }

  return false;
}

serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("OK", { status: 200 });

  try {
    const update = await req.json();
    console.log("Update:", JSON.stringify(update));

    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message.chat.id;
      const data = cq.data as string;
      const user = await getOrCreateUser(chatId, cq.from.first_name);

      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: cq.id }),
      });

      if (data.startsWith("personality_")) {
        const p = data.replace("personality_", "");
        await updateUser(chatId, { personality: p, state: "chatting" });
        await clearHistory(chatId);
        const greeting = GREETINGS[p] ?? `✅ אישיות שונתה! דבר איתי על הכל.`;
        await sendMessage(chatId, greeting);
      } else if (data === "add_reminder") {
        await updateUser(chatId, { state: "awaiting_reminder_text" });
        await sendMessage(chatId, "מה המטלה שאתה רוצה שאזכיר לך?");
      } else if (data === "list_reminders") {
        await handleListReminders(chatId);
      } else if (data === "change_personality") {
        await sendMessage(chatId, "בחר אישיות חדשה:", getPersonalityKeyboard());
      } else if (data === "chat") {
        await updateUser(chatId, { state: "chatting" });
        const p = user.personality as string;
        const pName = PERSONALITIES[p]?.name ?? "הבוט";
        const pEmoji = PERSONALITIES[p]?.emoji ?? "💬";
        await sendMessage(chatId, `${pEmoji} ${pName} כאן.\nדבר איתי חופשי.\n(שלח /menu לתפריט)`);
      } else if (data.startsWith("reminder_type_")) {
        const type = data.replace("reminder_type_", "");
        await handleReminderType(chatId, type);
      } else if (data.startsWith("done_reminder_")) {
        const reminderId = data.replace("done_reminder_", "");
        await supabase.from("reminders").update({ active: false }).eq("id", reminderId);
        const history = await getHistory(chatId);
        const reply = await askGemini(
          "המשתמש סיים את המטלה! תגיב בהתאם לאישיות שלך — אמיתי, ספונטני, מצחיק, לא ג'נרי.",
          user.personality as string,
          "",
          history
        );
        await sendMessage(chatId, reply);
      } else if (data === "dismiss_offer") {
        await sendMessage(chatId, "אוקיי, ממשיכים 👍");
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const message = update.message;
    if (!message) return new Response(JSON.stringify({ ok: true }), { status: 200 });

    const chatId = message.chat.id;
    const text = (message.text ?? "").trim();
    const firstName = message.from?.first_name ?? "חבר";
    const user = await getOrCreateUser(chatId, firstName);

    if (text === "/start") {
      await handleStart(chatId, firstName);
    } else if (text === "/diag") {
      await handleDiag(chatId);
    } else if (text === "/menu") {
      await updateUser(chatId, { state: "idle" });
      await handleMenu(chatId);
    } else if (text === "/reminders") {
      await handleListReminders(chatId);
    } else if (text === "/personality") {
      await sendMessage(chatId, "בחר אישיות:", getPersonalityKeyboard());
    } else if (user.state === "awaiting_reminder_text") {
      await handleReminderText(chatId, text);
    } else if ((user.state as string).startsWith("awaiting_reminder_time_")) {
      await handleReminderTime(chatId, text, user);
    } else {
      if (detectDoneKeyword(text)) {
        const offered = await checkAndOfferCloseReminder(chatId, text, user.personality as string);
        if (offered) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
      }

      const activeReminders = await supabase
        .from("reminders")
        .select("text, time, type")
        .eq("chat_id", chatId)
        .eq("active", true);

      const context = activeReminders.data?.length
        ? `למשתמש יש תזכורות פעילות: ${activeReminders.data.map((r) => r.text).join(", ")}.`
        : "למשתמש אין תזכורות פעילות כרגע.";

      const history = await getHistory(chatId);
      await saveMessage(chatId, "user", text);
      const reply = await askGemini(text, user.personality as string, context, history);
      await saveMessage(chatId, "assistant", reply);
      await sendMessage(chatId, reply);
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
});
