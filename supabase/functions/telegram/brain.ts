/* eslint-disable @typescript-eslint/no-explicit-any */

export type Supa = any;
export type ModelCall = (payload: Record<string, unknown>) => Promise<{ ok: boolean; data?: any }>;
export type HistoryMsg = { role: string; content: string; created_at?: string };

export type Memory = {
  id?: string;
  kind: "fact" | "preference" | "habit" | "relationship" | "joke" | "project" | "request" | string;
  mem_key: string;
  value: string;
  confidence?: number;
  importance?: number;
  expires_at?: string | null;
  updated_at?: string;
};

export type Mood = "calm" | "funny" | "serious" | "busy" | "energetic" | "mildly_frustrated" | "warm";

const MEMORY_LIMIT = 25;

function normalizeJson(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseJsonSafely<T>(raw: string, fallback: T, label: string): T {
  try {
    return JSON.parse(normalizeJson(raw)) as T;
  } catch (error) {
    console.error(`[brain] ${label} JSON parse failed:`, error, raw.slice(0, 500));
    return fallback;
  }
}

export async function fetchMemories(supabase: Supa, chatId: number): Promise<Memory[]> {
  try {
    const { data, error } = await supabase
      .from("user_memories")
      .select("id, kind, mem_key, value, confidence, importance, expires_at, updated_at")
      .eq("chat_id", chatId)
      .order("importance", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(MEMORY_LIMIT);

    if (error) {
      console.error("[memory] fetch failed:", error.message);
      return [];
    }

    const now = Date.now();
    return (data ?? []).filter(
      (memory: Memory) => !memory.expires_at || new Date(memory.expires_at).getTime() > now,
    ) as Memory[];
  } catch (error) {
    console.error("[memory] fetch exception:", error);
    return [];
  }
}

export async function upsertMemories(supabase: Supa, chatId: number, memories: Memory[]) {
  if (!memories.length) return;

  const rows = memories
    .filter((memory) => memory.mem_key && memory.value)
    .slice(0, 6)
    .map((memory) => ({
      chat_id: chatId,
      kind: memory.kind || "fact",
      mem_key: String(memory.mem_key).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60),
      value: String(memory.value).trim().slice(0, 300),
      confidence: Math.max(0.1, Math.min(1, Number(memory.confidence ?? 0.75))),
      importance: Math.max(1, Math.min(4, Number(memory.importance ?? 2))),
      expires_at: memory.expires_at ?? null,
      updated_at: new Date().toISOString(),
    }));

  if (!rows.length) return;
  const { error } = await supabase
    .from("user_memories")
    .upsert(rows, { onConflict: "chat_id,mem_key" });
  if (error) console.error("[memory] upsert failed:", error.message);
}

export async function forgetMemories(supabase: Supa, chatId: number, keys: string[]) {
  if (!keys.length) return;
  const { error } = await supabase
    .from("user_memories")
    .delete()
    .eq("chat_id", chatId)
    .in("mem_key", keys.slice(0, 10));
  if (error) console.error("[memory] forget failed:", error.message);
}

const KIND_LABEL: Record<string, string> = {
  fact: "עובדה",
  preference: "העדפה",
  habit: "הרגל",
  relationship: "אדם קרוב",
  joke: "בדיחה פנימית",
  project: "פרויקט",
  request: "בקשה",
};

export function memoryContext(memories: Memory[]): string {
  if (!memories.length) return "";
  return `דברים שאתה יודע על המשתמש מהעבר. השתמש בהם רק כשזה רלוונטי וטבעי, ואל תקריא אותם כרשימה:\n${memories
    .slice(0, 12)
    .map((memory) => `- (${KIND_LABEL[memory.kind] ?? memory.kind}) ${memory.value}`)
    .join("\n")}`;
}

const PRONOUN_RE = /(אליו|אליה|אליהם|אותו|אותה|אותם|לזה|את זה|הדבר הזה|ההוא|ההיא|כמו שאמרתי|הבנאדם הזה)/;

export function coreferenceInstruction(text: string, history: HistoryMsg[]): string {
  if (!PRONOUN_RE.test(text) || !history.length) return "";
  const recent = history.slice(-6).map((message) => `${message.role === "assistant" ? "בוט" : "משתמש"}: ${message.content}`);
  return `בהודעה יש התייחסות עמומה כמו "זה" או "אליו". פענח אותה לפי השיחה האחרונה ולא לפי ניחוש אקראי. אם יש מספיק הקשר, התייחס לדבר בשמו. אם אין הקשר בכלל, שאל שאלה קצרה אחת.\n${recent.join("\n")}`;
}

const PERSONALITY_MOODS: Record<string, Mood[]> = {
  coach: ["energetic", "warm", "serious", "calm"],
  cynic: ["funny", "calm", "mildly_frustrated"],
  friend: ["warm", "funny", "calm"],
  sergeant: ["serious", "energetic", "mildly_frustrated"],
  therapist: ["calm", "warm", "serious"],
  hype: ["energetic", "funny", "warm"],
  grandma: ["warm", "calm"],
  philosopher: ["calm", "serious", "funny"],
  frayer: ["funny", "warm", "mildly_frustrated"],
  neighbor: ["funny", "warm", "busy"],
};

export function pickMood(
  personality: string,
  signals: { mode: string; hourLocal: number; repeatStreak: number; gapMinutes: number; prevMood?: string | null },
): Mood {
  const allowed = PERSONALITY_MOODS[personality] ?? PERSONALITY_MOODS.cynic;
  if (signals.mode === "frustration") return allowed.includes("warm") ? "warm" : "calm";
  if (signals.mode === "success") return allowed.includes("energetic") ? "energetic" : "warm";
  if (signals.repeatStreak >= 3 && allowed.includes("mildly_frustrated")) return "mildly_frustrated";
  if (signals.hourLocal < 7 || signals.hourLocal >= 23) return "calm";
  if (signals.prevMood && allowed.includes(signals.prevMood as Mood) && Math.random() > 0.35) return signals.prevMood as Mood;
  return allowed[Math.floor(Math.random() * allowed.length)];
}

const MOOD_TEXT: Record<Mood, string> = {
  calm: "טון רגוע וקצר. בלי לדחוף.",
  funny: "קלילות ועקיצה אחת לכל היותר אם היא באמת מתאימה.",
  serious: "ישיר וענייני. בלי בדיחות.",
  busy: "משפט קצר בלבד, בלי לפתוח נושא חדש.",
  energetic: "קצב גבוה ודחיפה לצעד קטן אחד.",
  mildly_frustrated: "אפשר להראות חוסר סבלנות קל בחיבה, בלי לפגוע.",
  warm: "תן קרדיט, חום ועידוד אמיתי בלי חנופה.",
};

export function moodInstruction(mood: Mood, repeatStreak: number): string {
  return `מצב הרוח הנוכחי שלך: ${MOOD_TEXT[mood]}${repeatStreak >= 3 ? " המשתמש חזר על עצמו; תכיר בזה בטבעיות ולא כמו טופס." : ""}`;
}

export function moodLabel(mood: Mood): string {
  return ({ calm: "רגוע", funny: "מצחיק", serious: "רציני", busy: "עסוק", energetic: "אנרגטי", mildly_frustrated: "מתוסכל קלות", warm: "מפרגן" } as Record<Mood, string>)[mood];
}

const HEAVY_RE = /(מוות|מת|אובדני|בית חולים|אשפוז|פיטורים|גירושין|דיכאון|חרדה קשה|אלימות|ניתוח)/;

export function humorPolicy(args: { text: string; mode: string; tone: string; intensity: number; mood: Mood; userHumorLevel: number }) {
  if (HEAVY_RE.test(args.text)) return { level: 0, instruction: "אפס הומור. הנושא כבד, הקשב באמת." };
  if (args.mode === "frustration") return { level: 1, instruction: "קודם תן מקום לתסכול; אולי קלילות עדינה, לא בדיחה." };
  if (["joke", "sarcastic", "dark_humor", "hyperbole"].includes(args.tone) && args.userHumorLevel >= 0.45) {
    return { level: 2, instruction: "המשתמש עצמו בהומור. אפשר עקיצה אחת ספציפית וקצרה." };
  }
  return { level: 1, instruction: "הומור נמוך. אל תמציא בדיחה אם אין אחת טבעית." };
}

const ALIASES: Record<string, string> = {
  מאמן: "coach", ציני: "cynic", חבר: "friend", רסר: "sergeant", "רס\"ר": "sergeant",
  מטפל: "therapist", סבתא: "grandma", פילוסוף: "philosopher", פראייר: "frayer", שכן: "neighbor", מעודד: "hype",
};

export function detectSwitchRequest(text: string): { type: "personality"; key: string; scope: "session" | "permanent" } | { type: "tone"; tone: string } | null {
  const t = text.toLowerCase();
  if (/(תהיה רציני|בלי בדיחות|עזוב ציניות|תפסיק להתלוצץ)/.test(t)) return { type: "tone", tone: "serious" };
  if (/(תהיה עדין|יותר בעדינות|תרד ממני)/.test(t)) return { type: "tone", tone: "softer" };
  if (/(תהיה מצחיק|יותר מצחיק|יותר ציני|תעקוץ)/.test(t)) return { type: "tone", tone: "funnier" };
  for (const [alias, key] of Object.entries(ALIASES)) {
    if (t.includes(alias) && /(תהיה|תדבר|דבר|מעכשיו|תעבור)/.test(t)) {
      return { type: "personality", key, scope: /(מעכשיו|תמיד|קבוע|מהיום)/.test(t) ? "permanent" : "session" };
    }
  }
  return null;
}

export function toneOverrideInstruction(tone: string | null | undefined): string {
  if (tone === "serious") return "המשתמש ביקש רצינות. אל תשתמש בציניות או בדיחות עד שיבקש אחרת.";
  if (tone === "softer") return "המשתמש ביקש עדינות. בלי לחץ ובלי עקיצות.";
  if (tone === "funnier") return "אפשר יותר קלילות, אבל עדיין לא להגזים.";
  return "";
}

const ANCHORS: Array<{ re: RegExp; anchor: string; key: string }> = [
  { re: /לפני שאני יוצא|כשאני יוצא|לפני היציאה/, anchor: "leaving_home", key: "leave_home_time" },
  { re: /כשאני מגיע.*עבודה|כשאגיע.*עבודה/, anchor: "arriving_work", key: "arrive_work_time" },
  { re: /כשאני חוזר|כשאחזור/, anchor: "back_home", key: "leave_work_time" },
  { re: /לפני השינה|לפני שאני הולך לישון/, anchor: "bedtime", key: "bedtime" },
];

export function parseSmartHints(text: string): { anchor?: string; leadMinutes?: number; confirmNeeded?: boolean } {
  const result: { anchor?: string; leadMinutes?: number; confirmNeeded?: boolean } = {};
  const found = ANCHORS.find((item) => item.re.test(text));
  if (found) result.anchor = found.anchor;
  if (/שעתיים לפני/.test(text)) result.leadMinutes = 120;
  else if (/שעה לפני/.test(text)) result.leadMinutes = 60;
  else if (/חצי שעה לפני/.test(text)) result.leadMinutes = 30;
  else if (/יום לפני/.test(text)) result.leadMinutes = 1440;
  if (/(אם לא סימנתי|אם לא אישרתי|תרדוף אחריי|תציק לי)/.test(text)) result.confirmNeeded = true;
  return result;
}

export function anchorMemoryKeyFor(anchor: string): string | null {
  return ANCHORS.find((item) => item.anchor === anchor)?.key ?? null;
}

export function anchorQuestion(anchor: string): string {
  return ({ leaving_home: "באיזו שעה אתה בדרך כלל יוצא מהבית?", arriving_work: "מתי אתה בדרך כלל מגיע לעבודה?", back_home: "מתי אתה בדרך כלל חוזר הביתה?", bedtime: "באיזו שעה אתה בדרך כלל הולך לישון?" } as Record<string, string>)[anchor] ?? "באיזו שעה בערך?";
}

export function naturalize(text: string): string {
  let result = text.trim();
  const replacements: Array<[RegExp, string]> = [
    [/^בהחלט[!,.]?\s*/u, ""], [/^כמובן[!,.]?\s*/u, ""], [/אשמח לסייע לך בנושא זה/gu, "מה אתה צריך?"],
    [/אני כאן בשבילך/gu, "אני פה"], [/האם תרצה ש/gu, "רוצה ש"], [/במידה ו/gu, "אם"],
    [/התזכורת נקבעה בהצלחה/gu, "רשמתי"], [/הבקשה שלך התקבלה/gu, "סגור"],
  ];
  for (const [re, replacement] of replacements) result = result.replace(re, replacement);
  let emojiCount = 0;
  result = result.replace(/\p{Extended_Pictographic}/gu, (emoji) => ++emojiCount <= 2 ? emoji : "");
  return result.replace(/\s{2,}/g, " ").trim();
}

const EXTRACTION_PROMPT = `אתה שכבת זיכרון לבוט אישי בעברית. החזר JSON תקין בלבד, בלי markdown:
{"memories":[{"kind":"fact|preference|habit|relationship|joke|project|request","mem_key":"english_key","value":"משפט קצר בעברית","confidence":0.8,"importance":2,"expires_at":null}],"forget":["key"],"follow_ups":[{"topic":"נושא","question":"שאלה קצרה בעברית","in_hours":24}]}
שמור רק מידע ארוך טווח, מטרות, העדפות, הרגלים ואירועים עתידיים. אל תשמור פטפוט חולף או תזכורת רגילה.`;

export async function runExtraction(callModel: ModelCall, args: { userText: string; replyText: string; history: HistoryMsg[]; known: Memory[] }) {
  const empty = { memories: [] as Memory[], forget: [] as string[], followUps: [] as Array<{ topic: string; question: string; in_hours: number }> };
  const history = [...args.history.slice(-4), { role: "user", content: args.userText }, { role: "assistant", content: args.replyText }]
    .map((message) => `${message.role}: ${message.content}`).join("\n");
  const response = await callModel({
    systemInstruction: { parts: [{ text: EXTRACTION_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: `זיכרונות קיימים:\n${args.known.map((m) => m.value).join("\n") || "אין"}\n\nשיחה:\n${history}` }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 512, responseMimeType: "application/json" },
  });
  if (!response.ok) return empty;
  const raw = response.data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("") ?? "";
  const parsed = parseJsonSafely(raw, empty, "memory extraction") as typeof empty;
  return {
    memories: Array.isArray(parsed.memories) ? parsed.memories.filter((m) => m?.mem_key && m?.value).slice(0, 6) : [],
    forget: Array.isArray(parsed.forget) ? parsed.forget.slice(0, 5) : [],
    followUps: Array.isArray(parsed.followUps) ? parsed.followUps.filter((f) => f?.question && Number(f.in_hours) >= 0).slice(0, 2) : [],
  };
}

export async function scheduleFollowUps(supabase: Supa, chatId: number, followUps: Array<{ topic: string; question: string; in_hours: number }>) {
  if (!followUps.length) return;
  const rows = followUps.map((followUp) => ({
    chat_id: chatId,
    topic: String(followUp.topic).slice(0, 120),
    question: String(followUp.question).slice(0, 300),
    due_at: new Date(Date.now() + Math.max(1, Number(followUp.in_hours) || 24) * 3_600_000).toISOString(),
  }));
  const { error } = await supabase.from("follow_ups").insert(rows);
  if (error) console.error("[followup] insert failed:", error.message);
}

export function followUpNudge(text: string): string {
  if (/(מבחן|ראיון|מצגת|דדליין|הגשה|טסט)/.test(text)) return "אפשר להציע תזכורת אחת קונקרטית, בלי ללחוץ.";
  return "";
}
