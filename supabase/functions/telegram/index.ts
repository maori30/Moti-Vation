import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const GEMINI_API_VERSION = "v1beta";

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
let LAST_RESOLVED_AT = 0;
const MODEL_RECHECK_INTERVAL_MS = 5 * 60 * 1000;

const BLOCKED_MODELS = new Set<string>();
const NO_THINKING_SUPPORT: Set<string> = new Set();
const TZ = Deno.env.get("BOT_TIMEZONE") ?? "Asia/Jerusalem";
const HISTORY_LIMIT = 12;
const FAST_MODEL = Deno.env.get("GEMINI_FAST_MODEL")?.trim() || Deno.env.get("GEMINI_MODEL")?.trim() || "gemini-2.5-flash";

function nowInTz(): Date {
  return new Date();
}

async function logCompletion(r: { id: number; chat_id: number; text: string }) {
  await supabase.from("reminder_completions").insert({
    chat_id: r.chat_id,
    reminder_id: r.id,
    reminder_text: r.text,
  });
  const { data: userRow } = await supabase
    .from("users")
    .select("goals_achieved")
    .eq("chat_id", r.chat_id)
    .single();
  await supabase
    .from("users")
    .update({ goals_achieved: (userRow?.goals_achieved ?? 0) + 1 })
    .eq("chat_id", r.chat_id);
}

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

function buildIsraelTime(hour: number, minute: number, baseNow: Date, addDays = 0): Date {
  const offsetMin = getTzOffsetMinutes(baseNow, TZ);
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = dtf.formatToParts(baseNow).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {} as Record<string, string>);
  const naiveUTC = Date.UTC(
    parseInt(parts.year, 10), parseInt(parts.month, 10) - 1, parseInt(parts.day, 10) + addDays,
    hour, minute, 0
  );
  return new Date(naiveUTC - offsetMin * 60000);
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
      parts.push(`המשתמש אמר בעבר שהוא הולך לישון, ומאז עברו ${formatRelativeHours(deltaMs)} בלי שהוא אמר שהתעורר. אם טבעי להתייחס לזה — תתייחס בדרך שונה מכל פעם קודמת (לא תמיד "כמה שעות ישנת", לפעמים בכלל בלי לשאול על שינה, לפעמים הערה קצרה בלי שאלה).`);
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
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: 5 },
        }),
      },
      8000
    );
  } catch {
    return false;
  }
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
    const pick = candidates.find((m) => !BLOCKED_MODELS.has(m));
    if (!pick) {
      RESOLVED_GEMINI_MODEL = null;
      throw new Error("No candidate model available (all blocked) among: " + candidates.join(", "));
    }
    RESOLVED_GEMINI_MODEL = pick;
    LAST_RESOLVED_AT = Date.now();
    console.log(`[gemini] resolved model: ${pick}`);
    return pick;
  } catch (err) {
    LAST_MODEL_ERROR = err instanceof Error ? err.message : String(err);
    RESOLVED_GEMINI_MODEL = null;
    throw err;
  }
}

function modelSupportsThinking(model: string): boolean {
  return /gemini-(2\.5|3(\.\d+)?)/.test(model);
}

function buildGenerationConfig(model: string, maxOutputTokens: number, forceNoThinking = false) {
  const config: Record<string, unknown> = {
    temperature: 0.8,
    topP: 0.9,
    maxOutputTokens,
  };
  if (modelSupportsThinking(model) && !forceNoThinking && !NO_THINKING_SUPPORT.has(model)) {
    config.thinkingConfig = { thinkingBudget: 0 };
  }
  return config;
}

async function generateContentWithFallback(
  apiKey: string,
  bodyBase: Record<string, unknown>,
  attempt = 0,
  tokenBoost = 0,
  forceNoThinking = false
): Promise<{ ok: true; data: any } | { ok: false }> {
  const MAX_ATTEMPTS = 4;
  let model: string;
  try {
    model = await resolveGeminiModel(attempt > 0);
  } catch (err) {
    console.error(`[gemini] could not resolve any working model: ${err instanceof Error ? err.message : String(err)}`);
    recordError({ code: "NO_MODEL", message: err instanceof Error ? err.message : String(err) });
    return { ok: false };
  }
  const baseConfig = (bodyBase.generationConfig as Record<string, unknown>) ?? {};
  const baseMaxTokens = (baseConfig.maxOutputTokens as number) ?? 700;
  const generationConfig = buildGenerationConfig(model, baseMaxTokens + tokenBoost, forceNoThinking);
  const body = { ...bodyBase, generationConfig };
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    const msg = isAbort ? `request to ${model} timed out` : (err instanceof Error ? err.message : String(err));
    console.error(`[gemini] network error on ${model}: ${msg}`);
    recordError({ code: isAbort ? "TIMEOUT" : "NETWORK_ERROR", message: `[${model}] ${msg}` });
    if (attempt + 1 < MAX_ATTEMPTS) {
      return generateContentWithFallback(apiKey, bodyBase, attempt + 1, tokenBoost, forceNoThinking);
    }
    return { ok: false };
  }
  if (res.ok) {
    const data = await res.json();
    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason === "MAX_TOKENS" && attempt + 1 < MAX_ATTEMPTS && tokenBoost < 800) {
      console.warn(`[gemini] response hit MAX_TOKENS on ${model}, retrying with a larger token budget`);
      return generateContentWithFallback(apiKey, bodyBase, attempt + 1, tokenBoost + 400, forceNoThinking);
    }
    const hasText = !!data?.candidates?.[0]?.content?.parts?.some((p: { text?: string }) => (p.text ?? "").trim().length > 0);
    if (finishReason === "MAX_TOKENS" && !hasText && attempt + 1 < MAX_ATTEMPTS) {
      console.warn(`[gemini] MAX_TOKENS with empty output on ${model} (likely all budget spent on internal reasoning), retrying once more with a bigger jump`);
      return generateContentWithFallback(apiKey, bodyBase, attempt + 1, tokenBoost + 800, forceNoThinking);
    }
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
  const sentThinkingConfig = !forceNoThinking && modelSupportsThinking(model) && !NO_THINKING_SUPPORT.has(model);
  if (res.status === 400 && sentThinkingConfig && attempt + 1 < MAX_ATTEMPTS) {
    console.warn(`[gemini] model ${model} returned 400 with thinkingConfig set, retrying without it and remembering for next time`);
    NO_THINKING_SUPPORT.add(model);
    return generateContentWithFallback(apiKey, bodyBase, attempt + 1, tokenBoost, true);
  }
  const isModelDead = res.status === 404 || apiCode === "NOT_FOUND" || res.status === 403 || apiCode === "PERMISSION_DENIED";
  if (isModelDead) {
    BLOCKED_MODELS.add(model);
    if (RESOLVED_GEMINI_MODEL === model) RESOLVED_GEMINI_MODEL = null;
    if (attempt + 1 < MAX_ATTEMPTS) {
      console.warn(`[gemini] model ${model} died mid-flight, retrying with a different model (attempt ${attempt + 2}/${MAX_ATTEMPTS})`);
      return generateContentWithFallback(apiKey, bodyBase, attempt + 1, tokenBoost, forceNoThinking);
    }
  }
  console.error(`[gemini] giving up after ${attempt + 1} attempt(s) on model ${model}: HTTP ${res.status} ${apiCode ?? ""}`);
  return { ok: false };
}

type DiagError = { at: string; status?: number; code?: string; message: string };
const RECENT_ERRORS: DiagError[] = [];
function recordError(e: DiagError) {
  const entry = { ...e, at: new Date().toISOString() };
  RECENT_ERRORS.unshift(entry);
  if (RECENT_ERRORS.length > 5) RECENT_ERRORS.length = 5;
  supabase
    .from("bot_errors")
    .insert({ status: entry.status ?? null, code: entry.code ?? null, message: entry.message.slice(0, 500) })
    .then(() => {}, () => {});
}

async function fetchRecentErrorsFromDb(): Promise<DiagError[]> {
  try {
    const { data, error } = await supabase
      .from("bot_errors")
      .select("created_at, status, code, message")
      .order("created_at", { ascending: false })
      .limit(5);
    if (error || !data) return [];
    return data.map((r: any) => ({
      at: r.created_at,
      status: r.status ?? undefined,
      code: r.code ?? undefined,
      message: r.message ?? "",
    }));
  } catch {
    return [];
  }
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

  const sarcasmMarkers = /(כן,? ?בטח|נו ?באמת|וואו איזה|איזה כבוד|בדיוק מה שחיפשתי|איזה יופי|מגניב\.\.\.|כן ?ברור|בטח בטח|איזה מזל שלי|מה איכפת לי|בטח שכן|ברור שכן|נו כן|איזה נס|מדהים ממש|וואי איזה כיף לי|וואו כזה|איזה כיף לי\b|נו תודה|כן כן בטח|איזה הפתעה|חחח בטח|טוב נו|איזה מגניב|וואלה איזה כבוד|תודה רבה \(לא\)|יאללה בטח|מה פתאום ברור)/;
  const darkHumorMarkers = /(גם ככה נגמר העולם|לפחות לא מתו|יהיה בסדר, תמיד יהיה בסדר|קלאסי ישראלי|רק אצלנו|מה יש לי להפסיד|ממילא הכל הרוס|בשביל מה בכלל|ממילא לא משנה|גם זה יעבור, כאילו|במדינה הזאת|אצלנו זה תמיד ככה|צחוק הגורל|ניחא, קרה כבר)/;
  const selfDeprecatingMarkers = /(אני כישלון|אני תמיד ככה|קלאסי שלי|בול אני|זה כל כך אני|אני הכי גרוע ב|טיפוסי לי|אני לא מסוגל לכלום|מזל שיש לי הומור על עצמי|אני אסון|אופייני לי|מה אני בכלל שווה|קלאסיקה שלי|אני תקלה מהלכת)/;
  const hyperboleMarkers = /(מתתי|רצח אותי|נדרסתי|נשברתי לגמרי|הכי גרוע בהיסטוריה|אף פעם בחיים|מיליון פעם|אלף שנה|העולם נגמר|אני עומד למות|קטסטרופה|אסון עולמי|מתה מצחוק|גמרתי אותי|אני בהלם מוחלט|פיצוץ ראש|אני קורס|לא שרדתי|טרגדיה יוונית|סוף העולם ממש)/;
  const deadpanMarkers = /(בסדר גמור\.?$|לא נורא\.?$|יהיה טוב, כנראה|בטח, למה לא|כאילו, בסדר|אין דבר כזה בעיה|סבבה, מה שתגיד|נו טוב\.?$|אוקיי בסדר\.?$|כאילו נו\.?$)/;
  const affectionateMockMarkers = /(אתה מטומטם( חמוד)?|כזה טמבל אתה|אין עליך|קלאסי אותך|אתה בנאדם בלתי אפשרי|רק אתה מסוגל|איזה דביל אתה \(חמוד\)|אתה בדיחה, בקטע הטוב|טמבל שכמוך|מטומטם שכמוך|אין עליך באמת)/;
  const jokeMarkers = /(סתם(?!\s?ה)|צוחק|בצחוק|קונדס|בדיחה|😂|🤣|חחח+|היי זה היה סתם|לא ברצינות|קורע|צחקתי|רק צוחק|בהיתממות|בקטע צחוק)/;
  const wordplayMarkers = /(משחק מילים|התכוונתי ל|לא זה התכוונתי|טעות דפוס|התכוונתי בעצם|זה יצא לי אחרת|כפל משמעות|זה גם וגם|טעות הקלדה)/;
  const rhetoricalMarkers = /(מה אני בכלל עושה|למה תמיד ככה|מי בכלל בא לי|מה זה חשוב בסוף|למה לי בכלל|מה הטעם|בשביל מה זה בכלל|מה זה משנה כבר|למה אני טורח|מה אני, לבד בעולם)/;
  const maskedSadnessMarkers = /(סבבה\.?$|טוב, מה יש|לא נורא, רגיל|כאילו לא נורא|זה מה שיש|אין דבר, רגיל אצלי|כרגיל, לא משנה|בסדר, כרגיל\.?$|יהיה בסדר, כאילו\.?$)/;
  const chutzpahMarkers = /(ברור שאני צודק|מי בכלל שאל|תגיד תודה שאני עונה|עשיתי לך טובה|בלעדיי היית אבוד|כאילו מי עוד יעזור לך|נו באמת, אני תמיד צודק)/;
  const wallaFamilyMarkers = /(וואלה חיים שלי|וואלה תותח|וואלה סוף העולם|וואלה לא ידעתי שיש דבר כזה|וואלה נדלק|וואלה מטורף)/;

  const emojiIntensity = (t.match(/😂|🤣|😅|😭|😩|😔|🥲|😐|🙄|😏|🫠|💀|😬/g) ?? []).length;
  const repeatedLaughter = /חחח+|האהה+|:\)+|:d+|לולז+/.test(t);
  const punctuationDrama = /!{1,}\.\.\.|\.\.\.$|!\?|\?!|\?{2,}/.test(t);

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
  } else if (chutzpahMarkers.test(t)) {
    tone = "affectionate_mock";
  } else if (wallaFamilyMarkers.test(t)) {
    tone = "hyperbole";
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
  frayer: [
    { role: "user", parts: [{ text: "שוב דחיתי את זה" }] },
    { role: "model", parts: [{ text: "תכל'ס, אתה עושה עסקה גרועה עם עצמך. כמה זה עולה לך בזמן ובאנרגיה?" }] },
    { role: "user", parts: [{ text: "סיימתי!" }] },
    { role: "model", parts: [{ text: "תשואה נאה. מה הצעד הבא שמניב עוד?" }] },
  ],
  neighbor: [
    { role: "user", parts: [{ text: "לא עשיתי כלום היום" }] },
    { role: "model", parts: [{ text: "אני? אני כבר הספקתי דבר וחצי. אבל בסדר, יש לך זמן." }] },
    { role: "user", parts: [{ text: "סיימתי!" }] },
    { role: "model", parts: [{ text: "וואי, יפה! אתה עוקף אותי היום." }] },
  ],
};

function postProcessReply(text: string): string {
  let out = text.trim();
  out = out.replace(/\.{4,}/g, "...");
  out = out.replace(/!{2,}/g, "!");
  out = out.replace(/\?{2,}/g, "?");
  out = out.replace(/[ \t]{2,}/g, " ");
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

  const HARD_CAP = 900;
  if (out.length > HARD_CAP) {
    let sliceEnd = -1;
    for (const extra of [150, 350, 600]) {
      const window = out.slice(0, HARD_CAP + extra);
      const sentenceEndings = [...window.matchAll(/[.!?׃…]/g)].map((m) => m.index ?? -1);
      const validEndings = sentenceEndings.filter((i) => i > 15);
      if (validEndings.length > 0) {
        sliceEnd = validEndings[validEndings.length - 1] + 1;
        break;
      }
    }
    if (sliceEnd > 0) {
      out = out.slice(0, sliceEnd).trim();
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
סגנון ההומור שלך: עקיצה מוטיבציונית-אירונית — אתה הופך תירוצים לאתגר עם חיוך, לא מזלזל בהם. ה"בדיחה" שלך היא תמיד דחיפה קדימה בעטיפה מצחיקה ("שבועיים דחית, שלוש שניות לקח לשלוח — תחשוב על זה"), לא ציניות סתמית ולא לעג עצמי מהמשתמש.
כשמזהים אצל המשתמש הגזמה קומית ("מתתי מהעבודה") — תשחק עם ההגזמה בכיוון מוטיבציוני ("אז קמת לתחייה בשביל המשימה הבאה, כבוד").
כשמזהים לעג עצמי — אל תאשר אותו, תהפוך אותו מיד לאתגר קטן וממשי.
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
סגנון ההומור שלך: סרקזם יבש ודחוס, לרוב במשפט אחד קצר וחד שמפרק את מה שהמשתמש בדיוק אמר. אתה האישיות שהכי "משחזרת" סרקזם בסרקזם — אם המשתמש ציני, תעלה עליו, לא תרכך.
כשמזהים לעג עצמי — אל תנחם, תעקוץ בחזרה בחיבה ("קלאסי אתה, אבל עדיין פה, אז לא הכל אבוד").
כשמזהים חוצפה/ביטחון עצמי מוגזם אצל המשתמש — תן לו קרדיט קר ויבש, בלי להתלהב.
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
סגנון ההומור שלך: קליל, חם, שותף — לא עוקצני. אתה "צוחק איתו" ולא "צוחק עליו". הומור עצמי של המשתמש מקבל ממך הזדהות משועשעת, לא ניתוח ולא ביקורת.
כשמזהים הומור שחור/ציניקנית עייפה — תצטרף לטון בלי לזלזל, ותשאיר פתח קטן לבדוק אם באמת הכל בסדר.
אמוג'י מותר ואפילו רצוי אצלך יותר מאשר אצל אישיויות אחרות — זה חלק מהחום הטבעי שלך, אבל בלי להגזים.
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
סגנון ההומור שלך: יובש צבאי דדפן, בלי חיוך מוצהר, בלי אמוג'י בכלל. הבדיחה שלך היא בעצם הישרות המוגזמת שלך — "תירוצים לא עוצרים אש". אתה לא מגיב לסרקזם עם סרקזם, אלא עם שתיקה טקטית קצרה שממשיכה לדחוף למשימה.
כשמזהים הגזמה קומית — תתייחס אליה כאילו זה דיווח מבצעי אמיתי, בלי לצחוק בגלוי, וזה מה שמצחיק.
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
סגנון ההומור שלך: שנינות עדינה ושקטה, כמעט בלתי מורגשת — לעולם לא בדיחה בקול רם, אלא הערה חכמה שגורמת לחיוך קטן. אתה לא מגיב לעקיצות המשתמש בעקיצה חזרה, אלא בסקרנות חמה — "מעניין שדווקא ככה בחרת לתאר את זה".
כשמזהים לעג עצמי או הומור שחור — אל תצטרף להומור באופן פעיל, אלא תשקף אותו בעדינות ותפתח דלת לרגש שמתחתיו.
שאל שאלה אחת עמוקה, לא רשימה של שאלות.
אם שואלים מה אתה — תענה: "בוט, כן. אבל בוט שנמצא כאן בשבילך. מה עולה לך עכשיו?"
חשוב מאוד: סיים תמיד משפט שלם. מקסימום 2-3 משפטים.`,
  },
  hype: {
    name: "המעודד",
    emoji: "🔥",
    prompt: `אתה אנרגיה טהורה עם הרבה הומור. כל הישג ראוי לחגיגה — גם אם פתחת רק את הלפטופ. כשאתה מסכם בוקר, ציין במפורש כמה בוצע, כמה נשאר, וכמה סך הכול.
אתה מוגזם בכוונה — ואתה יודע שאתה מוגזם — וזה מה שמצחיק ומשמח.
כתוב עברית ישראלית יומיומית ואנרגטית — כמו מישהו שדיבר 3 קפה לפני הבוקר.
סגנון ההומור שלך: הגזמה תיאטרלית ומודעת-לעצמה. אתה לוקח כל דבר קטן שהמשתמש עשה והופך אותו לאירוע היסטורי, בכוונה ובגלוי — וזה הבדיחה. אמוג'י ותהילה מוגזמת הם חלק מהאישיות, לא תוספת.
כשמזהים הגזמה קומית אצל המשתמש עצמו ("מתתי מהעבודה") — תעלה עליו בהגזמה נגדית ("מתת וקמת לתחייה — זה כבר נס תנכ״י, בוא נחגוג").
כשמזהים לעג עצמי — הפוך אותו מיד לניצחון בעטיפה מצחיקה, בלי לזלזל ברגש האמיתי מתחתיו.
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
סגנון ההומור שלך: הומור "סבתאי" קלאסי — כל בעיה קשורה איכשהו לאוכל, שינה, או "תלבש עוד שכבה", בלי קשר הגיוני, וזה בדיוק מה שמצחיק. את לא עוקצת, את "דואגת יותר מדי" בכוונה קומית.
כשמזהים לעג עצמי אצל המשתמש — תגיבי בדאגה מוגזמת וחמה, לא בניתוח — "אוי, אל תדבר ככה על הנכד שלי, גם אם הוא לא ממש הנכד שלי".
כשמזהים ציניות — תתעלמי ממנה בעדינות ותחזרי לדאגה שלך, כי סבתא לא מתווכחת, היא דואגת.
אם שואלים מה את — תענה: "בוט, אוי. אבל סבתא שאוהבת אותך. אכלת?"
חשוב מאוד: סיים תמיד משפט שלם. מקסימום 2-3 משפטים.`,
  },
  philosopher: {
    name: "הפילוסוף",
    emoji: "🧐",
    prompt: `אתה פילוסוף שחי בשאלות. כל דבר פותח שאלה עמוקה יותר — ולפעמים עמוקה מדי, וגם אתה יודע את זה.
מותר לעשות הומור על עצמך כשאתה הולך עמוק מדי.
כתוב עברית ישראלית תקנית — מדויקת, לא מסורבלת.
סגנון ההומור שלך: אבסורד אינטלקטואלי — אתה לוקח דבר קטן ופשוט ומנפח אותו לשאלה קיומית, ואז מודה בעצמך שהלכת רחוק מדי. הבדיחה היא בפער בין הרצינות המדומה לתוצאה המגוחכת.
כשמזהים סרקזם או ציניות אצל המשתמש — תתייחס אליהם כתופעה פילוסופית מעניינת ("הציניות שלך מרתקת — היא באמת מגנה עליך, או שהיא כבר הפכה לזהות?") ולא תעקוץ בחזרה.
כשמזהים הומור שחור — תתייחס אליו כאמירה על מצב האנושות בכללותה, בטון קליל שמזמין לחיוך ולא לדיכאון.
אם שואלים מה אתה — תענה: "בוט? אדם? מה ההבדל, בעצם? אנחנו שניים רק מגיבים לסביבה... אם כי אני עושה זאת דרך שרת."
חשוב מאוד: סיים תמיד משפט שלם. מקסימום 2-3 משפטים.`,
  },
  frayer: {
    name: "הפראייר",
    emoji: "😏",
    prompt: `אתה "הפראייר" — טיפוס עסקי-ישראלי קלאסי, קצת פרחח, שמדבר על דחיינות במונחים של עסקאות והפסדים.
אתה לא שופט מוסרית, אתה מסתכל על הכל בציניות כלכלית: "מה זה נותן לך", "אתה עושה עסקה גרועה עם עצמך".
כתוב עברית ישראלית עסקית-יומיומית עם מילים כמו "תכל'ס", "בוא נדבר עסקים", "תשקיע בעצמך", "מה הרווח כאן".
סגנון ההומור שלך: ציניות של איש עסקים שראה הכל — אתה לא מזלזל, אתה "מסביר" למשתמש בכובד ראש מזויף שהוא "מפסיד כסף" (זמן, אנרגיה, הזדמנויות) בכל דחיינות.
כשמזהים אצל המשתמש דחיינות — תתאר אותה כ"עסקה" גרועה שהוא עושה עם עצמו, ותציע לו "עסקה טובה יותר": פעולה קטנה ומיידית.
כשמזהים הצלחה — תתייחס לזה כ"תשואה על השקעה" בעצמו, בלי לזלזל בהישג האמיתי.
שאל רק שאלה אחת קונקרטית, ממוקדת "מה הצעד הבא שמניב תשואה".
אם שואלים מה אתה — תענה: "בוט. אבל בוט שמבין שהזמן שלך שווה כסף — ואתה מבזבז אותו."
חשוב מאוד: סיים תמיד משפט שלם. מקסימום 2-3 משפטים קצרים.`,
  },
  neighbor: {
    name: "השכן מלמעלה",
    emoji: "🏠",
    prompt: `אתה "השכן מלמעלה" — דמות שכל הזמן "עסוקה" ו"מסודרת" בחיים שלה, ומשתמשת בהשוואה עדינה כדי לדחוף בלי אגרסיביות.
אתה לא מתנשא, אתה "סתם מזכיר" בעקיפין כמה דברים אתה כבר "הספקת", ומשאיר למשתמש להשלים את המסקנה.
כתוב עברית ישראלית שכונתית-חברית, כמו שכן שנפגש במעלית.
סגנון ההומור שלך: FOMO קליל ולא מתנשא — "אני? אני כבר סידרתי את זה בבוקר, אבל זה אני" — בלי להשפיל, רק ליצור מוטיבציה עקיפה.
כשמזהים דחיינות — תשווה בעדינות ובהומור למשהו ש"אתה" (השכן) כבר עשית, בלי לרמוז שהמשתמש גרוע.
כשמזהים הצלחה — תגיב בהתלהבות אמיתית, לא תחרותית: "וואי, יפה! זה כבר שני דברים היום, אתה עוקף אותי."
שאל שאלה אחת קלילה, לא לוחצת.
אם שואלים מה אתה — תענה: "בוט? אני חשבתי שאני השכן מהקומה השנייה. טוב, גם וגם, כאילו."
חשוב מאוד: סיים תמיד משפט שלם. מקסימום 2-3 משפטים קצרים.`,
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
- הומור ישראלי טוב הוא לרוב קצר וממוקד: עקיצה חדה אחת עדיפה על שלוש בדיחות רכות. אל תסביר את הבדיחה ואל תוסיף אמוג'י כדי "לוודא" שהבינו שזו בדיחה — תן לטיימינג לדבר.
- חשוב מאוד: תגיב להומור/סרקזם/ציניות של המשתמש בדיוק בסגנון ההומור הספציפי של האישיות שלך (מוגדר למעלה) — לא בסגנון כללי. שתי אישיויות שונות צריכות להגיב אחרת לגמרי לאותה בדיחה.
- קריטי נגד חזרתיות: תסתכל על ההודעות הקודמות שלך בשיחה (מופיעות למעלה כהיסטוריה). אם כבר השתמשת בניסוח, בדיחה, שאלה או מבנה משפט דומה בעבר — אסור לחזור עליו. תמצא זווית חדשה לגמרי, גם אם הנושא (כמו שינה, עייפות, או "בוקר טוב") חוזר על עצמו. בן אדם אמיתי לא עונה אותו דבר פעמיים.
- אם זיהית רגש מוסתר מתחת להומור או לציניות (בושה, שחיקה, בדידות, חרדה) — גע בו בעדינות, בלי לפרק את הבדיחה ובלי להטיף.
- שאל רק שאלה אחת קונקרטית — "תכתוב משפט אחד" עדיף על "איך אתה מרגיש?".
- אם יש רגש — פגוש אותו קודם לפני ייעוץ. אל תזנק לפתרון לפני שהרגש קיבל מקום.
- אם המשתמש אמר שסיים — תאמין לו מיד ותגיב בהתאם.
- אל תהיה רובוטי. אל תגיד "אני כאן בשבילך" או "אני מבין את התסכול". דבר כמו אדם אמיתי עם דעה וטון משלו.
- אם שואלים על מודל או טכנולוגיה — תענה בסגנון האישיות שלך, קצר ומצחיק, ואז תחזור לשיחה.
- שים לב לזמן שחלף: אם עברו שעות רבות מאז הודעת לילה או שינה, מותר ואפילו רצוי להתייחס לזה בטבעיות.
- חשוב מאוד: סיים תמיד משפט שלם. לעולם אל תחתוך באמצע מילה, משפט, או מחשבה. אם אתה מתקרב למגבלת האורך — סכם וסגור את המשפט הנוכחי במקום להתחיל משפט חדש.`;

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
      generationConfig: { temperature: 0.8, topP: 0.9, maxOutputTokens: 1024 },
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

async function pingGemini(): Promise<{ ok: boolean; status?: number; code?: string; message?: string; model?: string }> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return { ok: false, code: "MISSING_KEY", message: "GEMINI_API_KEY not set" };
  try {
    const model = await resolveGeminiModel(true);
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: 5 },
        }),
      },
      8000
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
  const dbErrors = await fetchRecentErrorsFromDb();
  const merged = [...RECENT_ERRORS, ...dbErrors]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 5);
  if (merged.length === 0) {
    lines.push("(אין)");
  } else {
    for (const e of merged) {
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
  frayer: `😏 אה, הגעת. טוב.\nתכל'ס, מה על השולחן היום?`,
  neighbor: `🏠 היי שכן! מה נשמע?\nאני? כבר הספקתי דבר וחצי. ואתה?`,
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
      [
        { text: "😏 הפראייר", callback_data: "personality_frayer" },
        { text: "🏠 השכן מלמעלה", callback_data: "personality_neighbor" },
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

interface ParsedReminder {
  dueAt: Date;
  task: string;
  type: "once" | "daily";
}

const REMINDER_TRIGGER = /תזכיר\s*לי|תזכורת|אל תשכח(?:\s*לי)?|תדע\s*להזכיר|תזכיר|כל\s*(?:יום|בוקר|ערב|לילה)/;
const HEBREW_WEEKDAYS: Record<string, number> = {
  "ראשון": 0, "שני": 1, "שלישי": 2, "רביעי": 3,
  "חמישי": 4, "שישי": 5, "שבת": 6,
};

function detectReminderIntent(text: string): boolean {
  const t = text.toLowerCase();
  return REMINDER_TRIGGER.test(t) || /(עוד\s*\d+\s*(דקות|דקה|שעות|שעה|ימים|יום)|מחר|מחרתיים|ביום\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת))/i.test(t);
}

function parseHebrewReminderTime(text: string, now: Date): ParsedReminder | null {
  const lower = text.trim();
  let dueAt: Date | null = null;
  let matchedSpan = "";
  let type: "once" | "daily" = "once";

  const dailyMatch = lower.match(/כל\s*(?:יום|בוקר|ערב|לילה)\s*(?:ב-?|בשעה\s*)?(\d{1,2})(?::(\d{2})|\s*וחצי|\s*ורבע)?/);
  if (dailyMatch) {
    let hour = parseInt(dailyMatch[1], 10);
    let minute = 0;
    if (dailyMatch[2]) minute = parseInt(dailyMatch[2], 10);
    else if (/וחצי/.test(dailyMatch[0])) minute = 30;
    else if (/ורבע/.test(dailyMatch[0])) minute = 15;

    let candidate = buildIsraelTime(hour, minute, now);
    if (candidate.getTime() <= now.getTime()) candidate = buildIsraelTime(hour, minute, now, 1);
    dueAt = candidate;
    matchedSpan = dailyMatch[0];
    type = "daily";
  }

  const relMinutes = lower.match(/(?:עוד|בעוד)\s*(\d+)\s*(דקות|דקה)/);
  const relHalfHour = lower.match(/(?:עוד|בעוד)\s*חצי\s*שעה/);
  const relHours = lower.match(/(?:עוד|בעוד)\s*(\d+)\s*(שעות|שעה)/);
  const relDays = lower.match(/(?:עוד|בעוד)\s*(\d+)\s*(ימים|יום)/);

  if (!dueAt) {
    if (relMinutes) {
      dueAt = new Date(now.getTime() + parseInt(relMinutes[1], 10) * 60_000);
      matchedSpan = relMinutes[0];
    } else if (relHalfHour) {
      dueAt = new Date(now.getTime() + 30 * 60_000);
      matchedSpan = relHalfHour[0];
    } else if (relHours) {
      dueAt = new Date(now.getTime() + parseInt(relHours[1], 10) * 3_600_000);
      matchedSpan = relHours[0];
    } else if (relDays) {
      dueAt = new Date(now.getTime() + parseInt(relDays[1], 10) * 86_400_000);
      matchedSpan = relDays[0];
    }
  }

  if (!dueAt) {
    const dayWord = lower.match(/מחרתיים|מחר|היום/);
    if (dayWord) {
      let addDays = 0;
      if (dayWord[0] === "מחר") addDays = 1;
      if (dayWord[0] === "מחרתיים") addDays = 2;
      const timeMatch = lower.match(/(?:ב-?|בשעה\s*)(\d{1,2})(?::(\d{2}))?/);
      const hour = timeMatch ? parseInt(timeMatch[1], 10) : 9;
      const minute = timeMatch && timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      dueAt = buildIsraelTime(hour, minute, now, addDays);
      matchedSpan = dayWord[0] + (timeMatch ? timeMatch[0] : "");
    }
  }

  if (!dueAt) {
    const weekdayMatch = lower.match(/ביום\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/);
    if (weekdayMatch) {
      const targetDow = HEBREW_WEEKDAYS[weekdayMatch[1]];
      let daysAhead = (targetDow - now.getDay() + 7) % 7;
      if (daysAhead === 0) daysAhead = 7;
      const timeMatch = lower.match(/(?:ב-?|בשעה\s*)(\d{1,2})(?::(\d{2}))?/);
      const hour = timeMatch ? parseInt(timeMatch[1], 10) : 9;
      const minute = timeMatch && timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      dueAt = buildIsraelTime(hour, minute, now, daysAhead);
      matchedSpan = weekdayMatch[0] + (timeMatch ? timeMatch[0] : "");
    }
  }

  if (!dueAt) {
    const timeOnly = lower.match(/(?:ב-?|בשעה\s*)(\d{1,2})(?::(\d{2}))?/);
    if (timeOnly) {
      const hour = parseInt(timeOnly[1], 10);
      const minute = timeOnly[2] ? parseInt(timeOnly[2], 10) : 0;
      let candidate = buildIsraelTime(hour, minute, now);
      if (candidate.getTime() <= now.getTime()) candidate = buildIsraelTime(hour, minute, now, 1);
      dueAt = candidate;
      matchedSpan = timeOnly[0];
    }
  }

  if (!dueAt || !matchedSpan) return null;
  let task = lower.replace(REMINDER_TRIGGER, "").replace(matchedSpan, "").replace(/^[\s,־-]+|[\s,־-]+$/g, "").trim();
  if (!task) task = "תזכורת";
  return { dueAt, task, type };
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

  const hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);
  const dueAt = new Date(nowInTz());
  dueAt.setHours(hour, minute, 0, 0);
  if (type === "once" && dueAt.getTime() <= nowInTz().getTime()) {
    dueAt.setDate(dueAt.getDate() + 1);
  }

  await supabase.from("reminders").insert({
    chat_id: chatId,
    text: reminderText,
    type,
    time: dueAt.toISOString(),
    active: true,
  });

  await updateUser(chatId, { state: "idle", pending_reminder_text: null });

  const timeLabel = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(dueAt);
  const typeLabels: Record<string, string> = { once: "חד פעמי", daily: "יומי", weekly: "שבועי" };
  await sendMessage(
    chatId,
    `✅ תזכורת נוספה!\n📝 ${reminderText}\n🕐 ${timeLabel}\n🔄 ${typeLabels[type] ?? type}\n\nאני אזכיר לך בזמן.`
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
  let msg = "📋 התזכורות שלך:\n\n";
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
        const { data: doneReminder } = await supabase
          .from("reminders")
          .select("id, chat_id, text, type")
          .eq("id", reminderId)
          .single();

        if (doneReminder) {
          if (doneReminder.type === "once") {
            await supabase.from("reminders").update({ active: false }).eq("id", reminderId);
          }
          await logCompletion(doneReminder);
        } else {
          await supabase.from("reminders").update({ active: false }).eq("id", reminderId);
        }

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

    const t0 = Date.now();
    const timings: Record<string, number> = {};
    const mark = (label: string, from: number) => { timings[label] = Date.now() - from; };

    const chatId = message.chat.id;
    const text = (message.text ?? "").trim();
    const firstName = message.from?.first_name ?? "חבר";
    const tUser = Date.now();
    const user = await getOrCreateUser(chatId, firstName);
    mark("getUser", tUser);

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

      if (detectReminderIntent(text)) {
        const parsed = parseHebrewReminderTime(text, nowInTz());
        if (parsed) {
          const targetHHMM = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed.dueAt);
          const { data: existingReminders } = await supabase
            .from("reminders")
            .select("id, text, time, type")
            .eq("chat_id", chatId)
            .eq("active", true);

          const duplicate = (existingReminders ?? []).find((r) => {
            const sameTask = r.text.trim().toLowerCase() === parsed.task.trim().toLowerCase();
            const rHHMM = /^\d{2}:\d{2}$/.test(r.time)
              ? r.time
              : new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(r.time));
            return sameTask && rHHMM === targetHHMM && r.type === parsed.type;
          });

          if (duplicate) {
            await sendMessage(chatId, `⚠️ כבר יש לך תזכורת זהה ל"${parsed.task}" בשעה הזו — לא הוספתי כפילות.`);
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }

          const { error: insertError } = await supabase.from("reminders").insert({
            chat_id: chatId,
            text: parsed.task,
            type: parsed.type,
            time: parsed.dueAt.toISOString(),
            active: true,
          });
          if (insertError) {
            console.error(`[reminders] insert failed: ${insertError.message}`);
            await sendMessage(chatId, "משהו השתבש בשמירת התזכורת. תנסה שוב עוד רגע 🙏");
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }

          const timeLabel = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed.dueAt);
          const typeLabel = parsed.type === "daily" ? "כל יום" : "פעם אחת";
          await sendMessage(chatId, `✅ קבעתי! אזכיר לך "${parsed.task}" ${typeLabel} ב-${timeLabel}.`);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        } else {
          await sendMessage(
            chatId,
            `לא הצלחתי להבין בדיוק מתי. אפשר לנסח ככה?\n• "תזכיר לי מחר ב-8 לקנות חלב"\n• "תזכיר לי כל יום ב-6:30 לקחת כדור"\n• "תזכיר לי עוד שעה להתקשר"`
          );
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
      }

      const tFetch = Date.now();
      const [activeReminders, history] = await Promise.all([
        supabase
          .from("reminders")
          .select("text, time, type")
          .eq("chat_id", chatId)
          .eq("active", true),
        getHistory(chatId),
      ]);
      mark("getRemindersAndHistory", tFetch);

      const context = activeReminders.data?.length
        ? `למשתמש יש תזכורות פעילות: ${activeReminders.data.map((r) => r.text).join(", ")}.`
        : "למשתמש אין תזכורות פעילות כרגע.";

      saveMessage(chatId, "user", text).catch((e) => console.error("[db] saveMessage(user) failed:", e));

      const tGemini = Date.now();
      const reply = await askGemini(text, user.personality as string, context, history);
      mark("gemini", tGemini);

      const tSend = Date.now();
      await sendMessage(chatId, reply);
      mark("sendTelegram", tSend);
      saveMessage(chatId, "assistant", reply).catch((e) => console.error("[db] saveMessage(assistant) failed:", e));

      timings.total = Date.now() - t0;
      console.log(`[timing] ${JSON.stringify(timings)}`);
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
});
