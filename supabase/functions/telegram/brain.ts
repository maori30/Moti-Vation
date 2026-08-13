// ============================================================
// Moti "brain" — the layers that sit around the raw model call:
// Intent → Memory → Context → Personality mood → Humor → Naturalness
// Everything here is dependency-injected so index.ts stays the entry point.
// ============================================================

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Supa = any;
export type ModelCall = (payload: Record<string, unknown>) => Promise<{ ok: boolean; data?: any }>;
export type HistoryMsg = { role: string; content: string; created_at?: string };

export type Memory = {
  id?: string;
  kind: string;
  mem_key: string;
  value: string;
  confidence?: number;
  expires_at?: string | null;
};

// ---------------------------------------------------------------
// 1) MEMORY LAYER
// ---------------------------------------------------------------

const MEMORY_LIMIT = 25;

export async function fetchMemories(supabase: Supa, chatId: number): Promise<Memory[]> {
  const { data, error } = await supabase
    .from("user_memories")
    .select("id, kind, mem_key, value, confidence, expires_at")
    .eq("chat_id", chatId)
    .order("confidence", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(MEMORY_LIMIT);
  if (error) {
    console.error("[memory] fetch failed:", error.message);
    return [];
  }
  const now = Date.now();
  return (data ?? []).filter((m: Memory) => !m.expires_at || new Date(m.expires_at).getTime() > now);
}

const KIND_LABEL: Record<string, string> = {
  fact: "עובדה",
  preference: "העדפה",
  habit: "הרגל",
  relationship: "אנשים בחיים שלו",
  joke: "בדיחה פנימית",
  project: "פרויקט/מטרה",
  request: "בקשה שהוא ביקש בעבר",
};

export function memoryContext(memories: Memory[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m) => `- (${KIND_LABEL[m.kind] ?? m.kind}) ${m.value}`);
  return `מה שאתה כבר יודע עליו מהעבר (זיכרון אמיתי, לא לחזור על זה סתם — להשתמש בזה רק כשזה רלוונטי וטבעי):
${lines.join("\n")}
אל תכריז "אני זוכר ש..." בכל הודעה. פשוט תדבר כמו מישהו שמכיר אותו.`;
}

export async function upsertMemories(supabase: Supa, chatId: number, mems: Memory[]) {
  if (mems.length === 0) return;
  const rows = mems.map((m) => ({
    chat_id: chatId,
    kind: m.kind || "fact",
    mem_key: m.mem_key,
    value: m.value,
    confidence: m.confidence ?? 0.75,
    expires_at: m.expires_at ?? null,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from("user_memories").upsert(rows, { onConflict: "chat_id,mem_key" });
  if (error) console.error("[memory] upsert failed:", error.message);
}

export async function forgetMemories(supabase: Supa, chatId: number, keys: string[]) {
  if (keys.length === 0) return;
  await supabase.from("user_memories").delete().eq("chat_id", chatId).in("mem_key", keys);
}

// ---------------------------------------------------------------
// 2) CONTEXT / CO-REFERENCE
// ---------------------------------------------------------------

const PRONOUN_RE = /(אליו|אליה|אליהם|אותו|אותה|אותם|לזה|את זה|הדבר הזה|שם|ההוא|ההיא|זה שדיברנו|כמו שאמרתי|הבנאדם הזה)/;

export function needsCoreference(text: string): boolean {
  return PRONOUN_RE.test(text);
}

export function coreferenceInstruction(text: string, history: HistoryMsg[]): string {
  if (!needsCoreference(text) || history.length === 0) return "";
  const recent = history.slice(-6).map((m) => `${m.role === "assistant" ? "אתה" : "הוא"}: ${m.content}`);
  return `שים לב: בהודעה הנוכחית יש התייחסות עמומה ("אליו", "זה", "אותו"...). תפענח את זה לבד מתוך השיחה האחרונה, ואל תשאל "למי אתה מתכוון?" אלא אם באמת אין שום רמז.
השיחה האחרונה:
${recent.join("\n")}
אם אתה מסיק למי/למה הכוונה — תגיד את זה במפורש בתשובה ("מחר ב-10 להתקשר לדני, סגור") כדי שהוא יוכל לתקן אותך אם טעית.`;
}

// ---------------------------------------------------------------
// 3) MOOD ENGINE — every personality has an internal changing state
// ---------------------------------------------------------------

export type Mood = "calm" | "funny" | "serious" | "busy" | "energetic" | "mildly_frustrated" | "warm";

const MOOD_HE: Record<Mood, string> = {
  calm: "רגוע",
  funny: "מצחיק",
  serious: "רציני",
  busy: "עסוק",
  energetic: "אנרגטי",
  mildly_frustrated: "מתוסכל קלות",
  warm: "מפרגן",
};

const MOOD_BEHAVIOR: Record<Mood, string> = {
  calm: "אתה במצב רוח רגוע — משפטים קצרים, בלי דרמה, בלי לדחוף.",
  funny: "אתה במצב רוח מצחיק — מותר עקיצה חדה אחת, קלילות, טיימינג טוב.",
  serious: "אתה במצב רוח רציני — בלי בדיחות, ישר לעניין, אנושי אבל ממוקד.",
  busy: "אתה במצב 'עסוק' — תשובה קצרה במיוחד (משפט אחד), כאילו אתה באמצע משהו, אבל בלי להיות מנותק.",
  energetic: "אתה במצב אנרגטי — קצב מהיר, פועל בהתחלת המשפט, דוחף לפעולה קטנה עכשיו.",
  mildly_frustrated: "אתה מתוסכל קלות — מותר להראות את זה בעדינות ובהומור ('אחי, פעם שלישית היום'), בלי לתקוף אותו.",
  warm: "אתה במצב מפרגן — שים לב למאמץ שלו, תן קרדיט אמיתי בלי חנופה.",
};

// Each personality drifts inside its own emotional range.
const PERSONALITY_MOODS: Record<string, Mood[]> = {
  coach:        ["energetic", "serious", "warm", "calm", "mildly_frustrated"],
  cynic:        ["funny", "mildly_frustrated", "deadpanish" as Mood, "calm", "busy"].filter(Boolean) as Mood[],
  friend:       ["warm", "funny", "calm", "energetic"],
  sergeant:     ["energetic", "mildly_frustrated", "busy", "serious"],
  therapist:    ["calm", "warm", "serious"],
  hype:         ["energetic", "funny", "warm"],
  grandma:      ["warm", "calm", "mildly_frustrated"],
  philosopher:  ["calm", "serious", "funny"],
  frayer:       ["funny", "mildly_frustrated", "warm"],
  neighbor:     ["funny", "busy", "mildly_frustrated", "warm"],
};

export type MoodSignals = {
  mode: string;              // conversation mode from index.ts
  hourLocal: number;
  repeatStreak: number;      // how many similar requests in a row
  gapMinutes: number;        // since last message
  prevMood?: string | null;
};

export function pickMood(personalityKey: string, s: MoodSignals): Mood {
  const palette = (PERSONALITY_MOODS[personalityKey] ?? PERSONALITY_MOODS.cynic).filter(
    (m) => MOOD_HE[m] !== undefined,
  );

  // Hard signals win over drift.
  if (s.mode === "frustration") return palette.includes("warm") ? "warm" : "calm";
  if (s.mode === "success") return palette.includes("energetic") ? "energetic" : "warm";
  if (s.repeatStreak >= 3 && palette.includes("mildly_frustrated")) return "mildly_frustrated";
  if (s.hourLocal >= 23 || s.hourLocal < 6) return "calm";
  if (s.hourLocal >= 6 && s.hourLocal < 10 && palette.includes("energetic")) return "energetic";
  if (s.gapMinutes < 2 && palette.includes("busy")) return "busy";

  // Soft drift: usually keep the mood, sometimes change it.
  const prev = (s.prevMood as Mood) ?? palette[0];
  if (palette.includes(prev) && Math.random() > 0.35) return prev;
  return palette[Math.floor(Math.random() * palette.length)];
}

export function moodInstruction(mood: Mood, streak: number): string {
  const base = MOOD_BEHAVIOR[mood] ?? MOOD_BEHAVIOR.calm;
  const streakLine =
    streak >= 3
      ? ` הוא כבר ביקש ממך משהו דומה ${streak} פעמים — תגיב לזה כמו בן אדם ("הבנתי, הבנתי 😄"), לא כמו טופס.`
      : "";
  return `מצב הרוח הפנימי שלך כרגע: ${MOOD_HE[mood]}. ${base}${streakLine}
מצב הרוח משפיע על הסגנון בלבד — האישיות שלך נשארת אותה אישיות.`;
}

export function moodLabel(mood: string): string {
  return MOOD_HE[mood as Mood] ?? mood;
}

// ---------------------------------------------------------------
// 4) HUMOR ENGINE — decide *if*, *what kind*, and *how much*
// ---------------------------------------------------------------

export type HumorDecision = { level: 0 | 1 | 2 | 3; instruction: string };

const SERIOUS_TOPICS = /(מת|מוות|אשפוז|בית חולים|גירושין|פיטורים|פוטרתי|דיכאון|חרדה קשה|אובדני|נפרדנו|חולה|ניתוח|לוויה|אבל|שכול|התמכרות|פשיטת רגל)/;

export function humorPolicy(opts: {
  text: string;
  mode: string;
  tone: string;
  intensity: number;
  mood: Mood;
  userHumorLevel: number;
}): HumorDecision {
  const { text, mode, tone, intensity, mood, userHumorLevel } = opts;

  if (SERIOUS_TOPICS.test(text)) {
    return {
      level: 0,
      instruction:
        "מנוע ההומור: כבוי לחלוטין. הנושא כבד ואמיתי. אפס בדיחות, אפס עוקצנות, אפס אמוג'י מצחיק. תהיה בן אדם שמקשיב.",
    };
  }
  if (mode === "frustration" && intensity < 0.4) {
    return {
      level: 1,
      instruction:
        "מנוע ההומור: מינימלי. אולי חצי חיוך בסוף המשפט, לא יותר. קודם הרגש, אחר כך הקלילות.",
    };
  }
  if (mood === "serious") {
    return { level: 1, instruction: "מנוע ההומור: נמוך. עקיצה אחת קטנה לכל היותר, ורק אם היא ממש מתבקשת." };
  }

  const userIsJoking = ["joke", "sarcastic", "dark_humor", "hyperbole", "affectionate_mock"].includes(tone);
  const score = (userIsJoking ? 0.5 : 0) + intensity * 0.3 + userHumorLevel * 0.4 + (mood === "funny" ? 0.3 : 0);

  if (score >= 0.85) {
    const kind = tone === "dark_humor" ? "הומור שחור ישראלי" : tone === "sarcastic" ? "סרקזם יבש" : "עקיצה חיבתית";
    return {
      level: 3,
      instruction: `מנוע ההומור: גבוה, והסוג המתאים הוא ${kind}. הוא בעצמו צוחק — תחזיר באותו מטבע, ספציפי למה שהוא בדיוק אמר. בדיחה אחת חדה, לא שלוש רכות. אל תסביר את הבדיחה.`,
    };
  }
  if (score >= 0.5) {
    return {
      level: 2,
      instruction:
        "מנוע ההומור: בינוני. עקיצה אחת ספציפית למה שהוא אמר, ואז חזרה לעניין. בלי סטנד־אפ.",
    };
  }
  return {
    level: 1,
    instruction: "מנוע ההומור: נמוך. קלילות במקום בדיחה. אם אין משהו באמת מצחיק להגיד — אל תמציא.",
  };
}

// ---------------------------------------------------------------
// 5) PERSONALITY SWITCHING (explicit request, session or permanent)
// ---------------------------------------------------------------

const PERSONALITY_ALIASES: Record<string, string> = {
  "מאמן": "coach", "coach": "coach",
  "ציני": "cynic", "הציני": "cynic", "ציניות": "cynic", "cynic": "cynic",
  "חבר": "friend", "friend": "friend",
  "סמל": "sergeant", "צבאי": "sergeant", "sergeant": "sergeant",
  "מטפל": "therapist", "פסיכולוג": "therapist",
  "מעודד": "hype", "הייפ": "hype",
  "סבתא": "grandma",
  "פילוסוף": "philosopher",
  "פראייר": "frayer",
  "שכן": "neighbor",
};

export type SwitchRequest =
  | { type: "personality"; key: string; scope: "session" | "permanent" }
  | { type: "tone"; tone: "serious" | "funnier" | "softer" | "harsher"; scope: "session" }
  | null;

export function detectSwitchRequest(text: string): SwitchRequest {
  const t = text.trim().toLowerCase();
  if (!/(תהיה|דבר|תדבר|עבור|תעבור|עזוב|מספיק|די עם|תפסיק עם|בוא נהיה|אני רוצה ש)/.test(t)) return null;

  // Tone shifts first — "עזוב ציניות עכשיו, תהיה רציני"
  if (/(תהיה רציני|בלי בדיחות|עזוב ציניות|מספיק ציניות|די עם הבדיחות|תפסיק עם ההומור|ברצינות עכשיו)/.test(t)) {
    return { type: "tone", tone: "serious", scope: "session" };
  }
  if (/(תהיה מצחיק|יותר מצחיק|תצחיק אותי|יותר בציניות|יותר ציני|תעקוץ|יותר סרקסטי)/.test(t)) {
    return { type: "tone", tone: /ציני|סרקס/.test(t) ? "harsher" : "funnier", scope: "session" };
  }
  if (/(תהיה עדין|תרד ממני|יותר בעדינות|תהיה נחמד|תפסיק ללחוץ)/.test(t)) {
    return { type: "tone", tone: "softer", scope: "session" };
  }

  for (const [alias, key] of Object.entries(PERSONALITY_ALIASES)) {
    if (t.includes(alias)) {
      const permanent = /(מעכשיו|תמיד|קבוע|מהיום|תישאר)/.test(t);
      return { type: "personality", key, scope: permanent ? "permanent" : "session" };
    }
  }
  return null;
}

export function toneOverrideInstruction(tone: string | null | undefined): string {
  switch (tone) {
    case "serious":
      return "המשתמש ביקש במפורש שתהיה רציני עכשיו — אפס בדיחות ואפס ציניות בשיחה הזו, עד שיגיד אחרת.";
    case "funnier":
      return "המשתמש ביקש שתהיה יותר מצחיק — תעלה הילוך בהומור, אבל עדיין תשובה קצרה.";
    case "harsher":
      return "המשתמש ביקש יותר ציניות/עוקץ — תחדד את הלשון, בחיבה ובלי להעליב באמת.";
    case "softer":
      return "המשתמש ביקש שתרד מהגז — עדין, בלי לחץ, בלי עקיצות.";
    default:
      return "";
  }
}

// ---------------------------------------------------------------
// 6) SMART REMINDERS — anchors, lead time, confirmation nudges
// ---------------------------------------------------------------

export type SmartReminderHint = {
  anchor?: string;        // "לפני שאני יוצא מהבית", "כשאני מגיע לעבודה"
  leadMinutes?: number;   // "שעתיים לפני", "יום לפני"
  confirmNeeded?: boolean;// "אם לא סימנתי שביצעתי"
};

const ANCHOR_PATTERNS: { re: RegExp; anchor: string; memKey: string }[] = [
  { re: /(לפני שאני יוצא|כשאני יוצא|לפני היציאה) (מהבית|מהעבודה)?/, anchor: "leaving_home", memKey: "leave_home_time" },
  { re: /(כשאני מגיע|כשאגיע) ל?עבודה/, anchor: "arriving_work", memKey: "arrive_work_time" },
  { re: /(כשאני חוזר|כשאחזור) (הביתה|מהעבודה)/, anchor: "back_home", memKey: "leave_work_time" },
  { re: /(לפני שאני הולך לישון|לפני השינה)/, anchor: "bedtime", memKey: "bedtime" },
  { re: /(כשאני קם|בבוקר כשאני מתעורר)/, anchor: "wakeup", memKey: "wake_time" },
];

export function parseSmartHints(text: string): SmartReminderHint {
  const hint: SmartReminderHint = {};
  for (const p of ANCHOR_PATTERNS) {
    if (p.re.test(text)) { hint.anchor = p.anchor; break; }
  }
  const lead = text.match(/(יום|יומיים|שעה|שעתיים|חצי שעה|\d{1,3})\s*(דקות|דקה|שעות|ימים)?\s*(לפני|קודם)/);
  if (lead) {
    const [, amount, unit] = lead;
    const n = Number(amount);
    if (amount === "יום") hint.leadMinutes = 1440;
    else if (amount === "יומיים") hint.leadMinutes = 2880;
    else if (amount === "שעה") hint.leadMinutes = 60;
    else if (amount === "שעתיים") hint.leadMinutes = 120;
    else if (amount === "חצי שעה") hint.leadMinutes = 30;
    else if (!Number.isNaN(n)) hint.leadMinutes = /שע/.test(unit ?? "") ? n * 60 : /ימ/.test(unit ?? "") ? n * 1440 : n;
  }
  if (/(אם לא סימנתי|אם לא אישרתי|עד שאני מאשר|תרדוף אחריי|תציק לי|אם לא עשיתי)/.test(text)) {
    hint.confirmNeeded = true;
  }
  return hint;
}

export function anchorMemoryKeyFor(anchor: string): string | null {
  const found = ANCHOR_PATTERNS.find((p) => p.anchor === anchor);
  return found ? found.memKey : null;
}

export function anchorQuestion(anchor: string): string {
  switch (anchor) {
    case "leaving_home": return "באיזו שעה אתה בדרך כלל יוצא מהבית?";
    case "arriving_work": return "מתי אתה בדרך כלל מגיע לעבודה?";
    case "back_home": return "מתי אתה בדרך כלל חוזר הביתה?";
    case "bedtime": return "באיזו שעה אתה בדרך כלל הולך לישון?";
    case "wakeup": return "באיזו שעה אתה בדרך כלל קם?";
    default: return "באיזו שעה בערך?";
  }
}

// ---------------------------------------------------------------
// 7) NATURALNESS FILTER — last gate before sending
// ---------------------------------------------------------------

const CORPORATE_REPLACEMENTS: [RegExp, string][] = [
  [/^בהחלט[!,.]?\s*/u, ""],
  [/^כמובן[!,.]?\s*/u, ""],
  [/^ללא ספק[!,.]?\s*/u, ""],
  [/^מצוין[!,.]?\s*/u, ""],
  [/^נהדר[!,.]?\s*/u, ""],
  [/אשמח לסייע לך בנושא זה/gu, "מה אתה צריך?"],
  [/אשמח לסייע/gu, "יאללה, מה צריך"],
  [/אני כאן כדי לסייע לך/gu, "אני פה"],
  [/אני כאן בשבילך/gu, "אני פה"],
  [/האם תרצה ש/gu, "רוצה ש"],
  [/האם ברצונך/gu, "רוצה"],
  [/במידה ו/gu, "אם"],
  [/על מנת ל/gu, "כדי ל"],
  [/יש לך אפשרות ל/gu, "אתה יכול "],
  [/בהצלחה רבה/gu, "בהצלחה"],
  [/אני מבין את התסכול שלך/gu, "מבאס"],
  [/זה נשמע מאתגר/gu, "זה מעצבן"],
  [/כפי שציינת קודם לכן/gu, "כמו שאמרת"],
  [/בנוסף לכך/gu, "וגם"],
  [/יחד עם זאת/gu, "אבל"],
  [/לסיכום/gu, "בקיצור"],
  [/התזכורת נקבעה בהצלחה/gu, "רשמתי"],
  [/הבקשה שלך התקבלה/gu, "סגור"],
];

export function naturalize(text: string): string {
  let out = text;
  for (const [re, rep] of CORPORATE_REPLACEMENTS) out = out.replace(re, rep);

  // Kill emoji spam: keep at most 2.
  const emojiRe = /(\p{Extended_Pictographic})/gu;
  const emojis = out.match(emojiRe) ?? [];
  if (emojis.length > 2) {
    let kept = 0;
    out = out.replace(emojiRe, (m) => (++kept <= 2 ? m : ""));
  }

  // A human doesn't open three sentences in a row with the same word.
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
}

// ---------------------------------------------------------------
// 8) EXTRACTION PASS — what's worth remembering + what to follow up on
// ---------------------------------------------------------------

const EXTRACTION_PROMPT = `אתה שכבת הזיכרון של בוט אישי בעברית. קיבלת חילופי הודעות בין משתמש לבוט.
המשימה: להחליט מה *שווה לזכור לטווח ארוך* — ולא לשמור כלום מעבר לזה.

כן לזכור: עובדות יציבות (עבודה, לימודים, מקום, בן/בת זוג, חיות מחמד, שמות של אנשים קרובים),
העדפות והרגלים ("שונא לקום מוקדם", "עובד עד 18:00", "אימון ביום חמישי"),
פרויקטים ומטרות מתמשכות, בדיחות פנימיות שחוזרות, ובקשות סגנון שהמשתמש ביקש.

לא לזכור: פטפוט חולף, מצב רוח של רגע, תזכורות (הן נשמרות במקום אחר), שאלות טכניות, כל הודעה סתם.

בנוסף: אם המשתמש הזכיר אירוע עתידי שראוי לחזור ולשאול עליו (מבחן, ראיון, עבודה חדשה, פגישה חשובה, דדליין) —
צור follow_up עם שאלה קצרה וטבעית בעברית ומתי לשאול אותה (בשעות מהרגע הזה).

החזר JSON תקין בלבד, בלי טקסט מסביב, במבנה:
{"memories":[{"kind":"fact|preference|habit|relationship|joke|project|request","mem_key":"slug_באנגלית","value":"משפט קצר בעברית","confidence":0.0-1.0}],
 "forget":["mem_key"],
 "follow_ups":[{"topic":"מבחן","question":"נו, איך היה המבחן?","in_hours":20}]}
אם אין מה לזכור — החזר {"memories":[],"forget":[],"follow_ups":[]}.`;

export async function runExtraction(
  callModel: ModelCall,
  args: { userText: string; replyText: string; history: HistoryMsg[]; known: Memory[] },
): Promise<{ memories: Memory[]; forget: string[]; followUps: { topic: string; question: string; in_hours: number }[] }> {
  const empty = { memories: [], forget: [], followUps: [] };
  try {
    const knownList = args.known.map((m) => `${m.mem_key}: ${m.value}`).join("\n") || "(אין עדיין)";
    const convo = [...args.history.slice(-4), { role: "user", content: args.userText }, { role: "assistant", content: args.replyText }]
      .map((m) => `${m.role === "assistant" ? "בוט" : "משתמש"}: ${m.content}`)
      .join("\n");

    const res = await callModel({
      systemInstruction: { parts: [{ text: EXTRACTION_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: `זיכרונות קיימים:\n${knownList}\n\nהשיחה:\n${convo}` }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 512, responseMimeType: "application/json" },
    });
    if (!res.ok) return empty;
    const raw: string =
      res.data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    const jsonText = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(jsonText);
    return {
      memories: Array.isArray(parsed.memories)
        ? parsed.memories
            .filter((m: Memory) => m && m.mem_key && m.value)
            .slice(0, 6)
            .map((m: Memory) => ({ ...m, mem_key: String(m.mem_key).slice(0, 60) }))
        : [],
      forget: Array.isArray(parsed.forget) ? parsed.forget.slice(0, 5) : [],
      followUps: Array.isArray(parsed.follow_ups)
        ? parsed.follow_ups.filter((f: any) => f?.question && f?.in_hours >= 0).slice(0, 2)
        : [],
    };
  } catch (e) {
    console.error("[memory] extraction failed:", e instanceof Error ? e.message : String(e));
    return empty;
  }
}

export async function scheduleFollowUps(
  supabase: Supa,
  chatId: number,
  followUps: { topic: string; question: string; in_hours: number }[],
) {
  if (followUps.length === 0) return;
  const rows = followUps.map((f) => ({
    chat_id: chatId,
    topic: String(f.topic ?? "").slice(0, 120) || "מעקב",
    question: String(f.question).slice(0, 300),
    due_at: new Date(Date.now() + Math.max(0.5, Number(f.in_hours) || 20) * 3600_000).toISOString(),
  }));
  const { error } = await supabase.from("follow_ups").insert(rows);
  if (error) console.error("[followup] insert failed:", error.message);
}

// In-conversation follow-up: should the bot end with an offer instead of a full stop?
export function followUpNudge(text: string): string {
  if (/(מבחן|ראיון|מצגת|דדליין|הגשה|פגישה חשובה|טסט|בוחן)/.test(text)) {
    return "אם מתאים — תציע בסוף ההודעה, במשפט קצר וטבעי, תזכורת אחת קונקרטית שתעזור לו להתכונן (למשל ללמוד הערב). הצעה, לא הרצאה.";
  }
  if (/(מתחיל עבודה|יום ראשון מתחיל|התחלתי ללמוד|מתחיל קורס|עובר דירה)/.test(text)) {
    return "זה אירוע שכדאי לחזור אליו בעתיד — תגיב עכשיו קצר, ותשאיר פתח לחזור ולשאול איך הלך.";
  }
  return "";
}
