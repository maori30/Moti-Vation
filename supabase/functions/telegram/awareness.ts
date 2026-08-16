// ============================================================
// Moti "awareness" layer:
// intent-under-the-words, event detection, priorities, forgetting,
// confidence, surprise, inside jokes, deep mode, anti-repetition,
// humanity check, and the Life Loop scorer.
// Every DB call is defensive — awareness must never break a chat.
// ============================================================
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Memory, ModelCall, Supa, HistoryMsg } from "./brain.ts";
import type { Goal } from "./profile.ts";

// ---------------------------------------------------------------
// 3+5) PRIORITY + CONFIDENCE
// ---------------------------------------------------------------

export const IMPORTANCE_ICON: Record<number, string> = { 4: "🔴", 3: "🟠", 2: "🟡", 1: "⚪" };

export function importanceOf(m: Memory & { importance?: number }): number {
  if (typeof m.importance === "number") return Math.min(4, Math.max(1, m.importance));
  if (m.kind === "relationship" || m.kind === "project") return 3;
  if (m.kind === "joke") return 1;
  return 2;
}

// Only surface memories that earn their place in the prompt.
export function rankMemories<T extends Memory & { importance?: number; confidence?: number; updated_at?: string }>(
  memories: T[],
  limit = 12,
): T[] {
  const now = Date.now();
  return [...memories]
    .map((m) => {
      const age = m.updated_at ? (now - new Date(m.updated_at).getTime()) / 86_400_000 : 30;
      const score = importanceOf(m) * 2 + (m.confidence ?? 0.7) * 2 - Math.min(3, age / 30);
      return { m, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.m);
}

// Confidence changes *how* the bot may use a memory.
export function confidenceContext(memories: (Memory & { confidence?: number; importance?: number })[]): string {
  if (!memories.length) return "";
  const shaky = memories.filter((m) => (m.confidence ?? 0.7) < 0.55);
  const solid = memories.filter((m) => (m.confidence ?? 0.7) >= 0.85);
  const lines: string[] = [];
  if (solid.length) lines.push(`דברים שאתה בטוח בהם (מותר להתייחס אליהם כעובדה): ${solid.map((m) => m.value).slice(0, 5).join(" | ")}`);
  if (shaky.length)
    lines.push(
      `דברים שאתה רק *משער* (אסור להציג כעובדה — או לשאול בקצרה, או לא להזכיר בכלל): ${shaky
        .map((m) => m.value)
        .slice(0, 5)
        .join(" | ")}`,
    );
  if (!lines.length) return "";
  return `רמות ודאות:\n${lines.join("\n")}\nאם משהו לא ודאי — תגיד "נדמה לי ש..." או פשוט תשאל, בלי להמציא ביטחון.`;
}

// ---------------------------------------------------------------
// 2) EVENTS the bot notices by itself
// ---------------------------------------------------------------

export type UserEvent = {
  id?: string;
  title: string;
  kind: string;
  when_at?: string | null;
  when_text?: string | null;
  importance?: number;
  confidence?: number;
  status?: string;
  offered_at?: string | null;
  asked_after_at?: string | null;
};

const EVENT_HINT_RE =
  /(יום הולדת|חתונה|ברית|פגישה|ראיון|מבחן|בוחן|מצגת|טיסה|נסיעה|חופש|חופשה|דדליין|הגשה|עבודה חדשה|מתחיל עבודה|רופא|תור ל|בדיקה|ניתוח|מסיבה|אירוע|קונצרט|הופעה|מרוץ|תחרות)/;

export function mentionsEvent(text: string): boolean {
  return EVENT_HINT_RE.test(text);
}

export async function fetchEvents(supabase: Supa, chatId: number): Promise<UserEvent[]> {
  try {
    const { data } = await supabase
      .from("user_events")
      .select("id, title, kind, when_at, when_text, importance, confidence, status, offered_at, asked_after_at")
      .eq("chat_id", chatId)
      .eq("status", "open")
      .order("importance", { ascending: false })
      .limit(15);
    return (data ?? []) as UserEvent[];
  } catch {
    return [];
  }
}

export async function upsertEvents(supabase: Supa, chatId: number, events: UserEvent[]) {
  if (!events.length) return;
  try {
    for (const e of events) {
      const title = String(e.title ?? "").trim().slice(0, 140);
      if (!title) continue;
      const { data: existing } = await supabase
        .from("user_events")
        .select("id")
        .eq("chat_id", chatId)
        .ilike("title", title)
        .maybeSingle();
      const row = {
        chat_id: chatId,
        title,
        kind: e.kind || "event",
        when_at: e.when_at ?? null,
        when_text: e.when_text ?? null,
        importance: Math.min(4, Math.max(1, Number(e.importance) || 2)),
        confidence: typeof e.confidence === "number" ? e.confidence : 0.7,
        updated_at: new Date().toISOString(),
      };
      if (existing?.id) await supabase.from("user_events").update(row).eq("id", existing.id);
      else await supabase.from("user_events").insert(row);
    }
  } catch (err) {
    console.error("[events] upsert failed:", err instanceof Error ? err.message : String(err));
  }
}

export function eventContext(events: UserEvent[]): string {
  if (!events.length) return "";
  const now = Date.now();
  const lines = events.map((e) => {
    const icon = IMPORTANCE_ICON[e.importance ?? 2];
    const when = e.when_at
      ? relativeHe(new Date(e.when_at).getTime() - now)
      : e.when_text
        ? e.when_text
        : "מתי? לא ידוע";
    return `- ${icon} ${e.title} (${when})`;
  });
  return `אירועים שהמשתמש הזכיר ואתה עוקב אחריהם:
${lines.join("\n")}
אם אחד מהם ממש קרוב (היום/מחר) — מותר להזכיר אותו בטבעיות. אם למשהו חסרה שעה ואתה חושב שכדאי — הצע *פעם אחת* לשמור תזכורת, בשאלה קצרה, בלי לחזור על ההצעה בכל הודעה.`;
}

function relativeHe(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 0) return "כבר עבר";
  if (h < 2) return "עוד פחות משעתיים";
  if (h < 24) return `עוד ${Math.round(h)} שעות`;
  const d = Math.round(h / 24);
  if (d === 1) return "מחר";
  if (d < 8) return `עוד ${d} ימים`;
  return `בעוד ${Math.round(d / 7)} שבועות`;
}

// ---------------------------------------------------------------
// 1) INTENT UNDER THE WORDS
// ---------------------------------------------------------------

const IMPLICIT_RE =
  /(אין לי כוח|לא בא לי|נמאס|אולי מחר|לא היום|בא לי לוותר|לא מצליח|שכחתי|לא הספקתי|קשה לי|מתחרט|לא בטוח שאני)/;

export function implicitIntentLayer(
  text: string,
  opts: { events: UserEvent[]; goals: Goal[]; reminders: string[] },
): string {
  if (!IMPLICIT_RE.test(text)) return "";
  const open = [
    ...opts.events.map((e) => e.title),
    ...opts.goals.map((g) => g.title),
    ...opts.reminders,
  ]
    .filter(Boolean)
    .slice(0, 8);
  return `כוונה מתחת למילים: המשתמש לא אמר במפורש על מה מדובר, אבל כנראה הוא מתייחס למשהו פתוח שכבר דיברתם עליו${
    open.length ? `: ${open.join(" | ")}` : ""
  }.
תנחש את הדבר הכי סביר ותתייחס אליו בשם ("זה בגלל המבחן ביום שלישי?"), במקום לענות תשובה כללית כמו "אני מבין".
אם באמת אין רמז — תשאל שאלה קצרה אחת "על מה מדובר?", לא משפט ריק.`;
}

// ---------------------------------------------------------------
// 6) SURPRISE ENGINE — natural variation instead of a predictable bot
// ---------------------------------------------------------------

export type SurpriseMode = "none" | "mention" | "tease" | "callback";

export function rollSurprise(hasMaterial: boolean, deepMode: boolean): SurpriseMode {
  if (!hasMaterial || deepMode) return "none";
  const r = Math.random();
  if (r < 0.55) return "none";
  if (r < 0.78) return "mention";
  if (r < 0.93) return "tease";
  return "callback";
}

export function surpriseInstruction(mode: SurpriseMode, material: string[]): string {
  if (mode === "none" || !material.length) return "";
  const pick = material[Math.floor(Math.random() * material.length)];
  switch (mode) {
    case "mention":
      return `וריאציה: מותר לשתול משפט קצר בטבעיות בסוף — "אגב, נזכרתי שאמרת ${pick}". לא לפתוח על זה דיון.`;
    case "tease":
      return `וריאציה: מותר לעקוץ בקטנה על ${pick} ("נו, מה נסגר עם זה? 😏") — משפט אחד, ואז לחזור לנושא.`;
    default:
      return `וריאציה: אפשר לחזור בחצי משפט למשהו ישן ("כמו הפעם ההיא עם ${pick}") אם זה מתחבר. אם לא מתחבר — תוותר.`;
  }
}

// ---------------------------------------------------------------
// 7) INSIDE JOKES
// ---------------------------------------------------------------

export type InsideJoke = { id?: string; phrase: string; meaning?: string | null; hits: number };

export async function fetchInsideJokes(supabase: Supa, chatId: number): Promise<InsideJoke[]> {
  try {
    const { data } = await supabase
      .from("inside_jokes")
      .select("id, phrase, meaning, hits")
      .eq("chat_id", chatId)
      .gte("hits", 2)
      .order("hits", { ascending: false })
      .limit(5);
    return (data ?? []) as InsideJoke[];
  } catch {
    return [];
  }
}

export async function bumpInsideJokes(supabase: Supa, chatId: number, phrases: { phrase: string; meaning?: string }[]) {
  if (!phrases.length) return;
  try {
    for (const p of phrases) {
      const phrase = String(p.phrase ?? "").trim().slice(0, 80);
      if (!phrase) continue;
      const { data: existing } = await supabase
        .from("inside_jokes")
        .select("id, hits")
        .eq("chat_id", chatId)
        .ilike("phrase", phrase)
        .maybeSingle();
      if (existing?.id) {
        await supabase
          .from("inside_jokes")
          .update({ hits: (existing.hits ?? 1) + 1, last_used_at: new Date().toISOString() })
          .eq("id", existing.id);
      } else {
        await supabase.from("inside_jokes").insert({ chat_id: chatId, phrase, meaning: p.meaning ?? null });
      }
    }
  } catch (e) {
    console.error("[jokes] bump failed:", e instanceof Error ? e.message : String(e));
  }
}

export function insideJokeContext(jokes: InsideJoke[]): string {
  if (!jokes.length) return "";
  const lines = jokes.map((j) => `- "${j.phrase}"${j.meaning ? ` — ${j.meaning}` : ""} (חזר ${j.hits} פעמים)`);
  return `בדיחות פנימיות שיש לכם:
${lines.join("\n")}
מותר לרמוז לאחת מהן *לפעמים* בחצי משפט ("טוב, לפחות הפעם לא האשמת את ה-WiFi 😏") — לא בכל הודעה, ורק כשזה נופל טבעי. בדיחה פנימית ששוחקים אותה מתה.`;
}

// ---------------------------------------------------------------
// 8) DEEP CONVERSATION MODE
// ---------------------------------------------------------------

const HEAVY_RE =
  /(מרגיש|קשה לי|לבד|בודד|פוחד|חרד|לחוץ|שחוק|מדוכא|עצוב|כועס|באמת מפריע|לא מספר לאף אחד|נשבר לי|מתוסכל)/;

export function detectDeepMode(text: string, history: HistoryMsg[]): { deep: boolean; topic: string | null } {
  const recentUser = history.filter((m) => m.role === "user").slice(-4);
  const longNow = text.length > 180;
  const heavyNow = HEAVY_RE.test(text);
  const sustained = recentUser.filter((m) => m.content.length > 120 || HEAVY_RE.test(m.content)).length >= 2;
  const deep = (heavyNow && (longNow || sustained)) || (longNow && sustained);
  if (!deep) return { deep: false, topic: null };
  const topic = text.split(/[.!?\n]/).map((s) => s.trim()).filter((s) => s.length > 12)[0] ?? null;
  return { deep: true, topic: topic ? topic.slice(0, 120) : null };
}

export function deepModeInstruction(topic: string | null): string {
  return `מצב שיחה עמוקה: השיחה הפכה משמעותית${topic ? ` (הנושא: ${topic})` : ""}.
- אסור "👍" או תשובה של שתי מילים כאן.
- תאט. תשקף מה שהבנת במילים שלך, ותנסה לחדד מה באמת מפריע ("רגע, אז מה שהכי מפריע לך זה לא X אלא Y?").
- הומור רק אם הוא משרת את הרגע, ולא כדי לברוח ממנו.
- 2-4 משפטים, שאלה אחת בסוף, בלי עצות מהירות ובלי רשימות.`;
}

// ---------------------------------------------------------------
// 9) ANTI-REPETITION
// ---------------------------------------------------------------

const STOP = new Set(["את", "של", "עם", "זה", "אתה", "אני", "לא", "כן", "על", "כמו", "מה", "אבל", "יש"]);

export function fingerprint(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(words)].sort().slice(0, 8).join(" ");
}

function jaccard(a: string, b: string): number {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export async function fetchRecentPhrases(supabase: Supa, chatId: number, limit = 12): Promise<{ text: string; fingerprint: string }[]> {
  try {
    const { data } = await supabase
      .from("bot_phrases")
      .select("text, fingerprint")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(limit);
    return (data ?? []) as { text: string; fingerprint: string }[];
  } catch {
    return [];
  }
}

export async function rememberPhrase(supabase: Supa, chatId: number, text: string) {
  try {
    await supabase.from("bot_phrases").insert({ chat_id: chatId, text: text.slice(0, 400), fingerprint: fingerprint(text) });
    const { data } = await supabase
      .from("bot_phrases")
      .select("id")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .range(40, 200);
    const ids = (data ?? []).map((r: { id: number }) => r.id);
    if (ids.length) await supabase.from("bot_phrases").delete().in("id", ids);
  } catch {
    /* never break the chat */
  }
}

export function antiRepetitionInstruction(recent: { text: string }[]): string {
  if (!recent.length) return "";
  const sample = recent.slice(0, 8).map((p) => `- ${p.text.slice(0, 90)}`);
  return `ניסוחים שכבר אמרת לאחרונה — אסור לחזור עליהם או על משהו דומה להם (לא באותן מילים ולא באותו מבנה):
${sample.join("\n")}
אם עולה לך משפט שנשמע כמו אחד מהם — תזרוק אותו ותמצא זווית אחרת.`;
}

export function isRepetitive(reply: string, recent: { fingerprint: string }[]): boolean {
  const fp = fingerprint(reply);
  if (!fp) return false;
  return recent.some((p) => jaccard(fp, p.fingerprint ?? "") >= 0.55);
}

// ---------------------------------------------------------------
// 10) HUMANITY CHECK (fast local pass + optional model rewrite)
// ---------------------------------------------------------------

const AI_SMELL: RegExp[] = [
  /אני כאן (כדי|בשבילך)/,
  /אשמח לסייע/,
  /חשוב לזכור ש/,
  /כפי ש(ציינת|אמרת) קודם/,
  /באופן כללי/,
  /ראשית[,\s]/,
  /לסיכום/,
  /אני מבין את התסכול/,
  /יש לך אפשרות/,
];

export type HumanityVerdict = { ok: boolean; problems: string[] };

export function humanityCheck(
  reply: string,
  ctx: { lengthTarget: string; deepMode: boolean; recent: { fingerprint: string }[]; userText: string },
): HumanityVerdict {
  const problems: string[] = [];
  const emojis = (reply.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  if (AI_SMELL.some((re) => re.test(reply))) problems.push("נשמע כמו AI/תמיכה טכנית");
  if (!ctx.deepMode && reply.length > 320) problems.push("ארוך מדי להודעת וואטסאפ");
  if (emojis > 2) problems.push("יותר מדי אימוג'ים");
  if (isRepetitive(reply, ctx.recent)) problems.push("חזרה על ניסוח שכבר אמרת לאחרונה");
  const questions = (reply.match(/\?/g) ?? []).length;
  if (questions > 1) problems.push("יותר משאלה אחת");
  if (!ctx.deepMode && questions === 1 && ctx.userText.trim().length <= 12)
    problems.push("שאלה מיותרת על הודעה זעירה");
  if (/^(בהחלט|כמובן|ללא ספק|מצוין|נהדר)/.test(reply.trim())) problems.push("פתיחה רשמית מדי");
  return { ok: problems.length === 0, problems };
}

export async function rewriteForHumanity(
  callModel: ModelCall,
  args: { reply: string; problems: string[]; personalityPrompt: string; userText: string; lengthTarget: string },
): Promise<string | null> {
  try {
    const res = await callModel({
      systemInstruction: {
        parts: [
          {
            text: `אתה עורך פנימי של בוט וואטסאפ בעברית. קיבלת טיוטה של תשובה ורשימת בעיות.
תפקידך: לשכתב אותה כך שתישמע כמו הודעה של בן אדם אמיתי, באותה אישיות בדיוק.
כללים: ${args.lengthTarget}. מקסימום אימוג'י אחד. מקסימום שאלה אחת. בלי ניסוחים רשמיים. בלי להסביר דברים שהמשתמש כבר יודע.
החזר אך ורק את הטקסט המשוכתב, בלי הקדמה ובלי מרכאות.

האישיות:
${args.personalityPrompt.slice(0, 900)}`,
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `הודעת המשתמש: ${args.userText}\n\nהטיוטה:\n${args.reply}\n\nבעיות שנמצאו: ${args.problems.join(", ")}`,
            },
          ],
        },
      ],
      generationConfig: { temperature: 0.7, maxOutputTokens: 220 },
    });
    if (!res.ok) return null;
    const raw: string =
      res.data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    const out = raw.trim().replace(/^["'׳״]|["'׳״]$/g, "").trim();
    return out.length > 1 ? out : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------
// 4) FORGETTING ENGINE
// ---------------------------------------------------------------

export async function runForgettingEngine(supabase: Supa, chatId: number) {
  const nowIso = new Date().toISOString();
  try {
    // Events that already happened stop being "upcoming".
    await supabase
      .from("user_events")
      .update({ status: "passed", updated_at: nowIso })
      .eq("chat_id", chatId)
      .eq("status", "open")
      .lt("when_at", nowIso);

    // Expired memories go away entirely.
    await supabase.from("user_memories").delete().eq("chat_id", chatId).not("expires_at", "is", null).lt("expires_at", nowIso);

    // Old, low-importance, unused memories decay and eventually drop.
    const cutoff = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const { data: stale } = await supabase
      .from("user_memories")
      .select("id, confidence, importance, kind")
      .eq("chat_id", chatId)
      .lt("updated_at", cutoff)
      .limit(50);
    for (const m of stale ?? []) {
      if ((m.importance ?? 2) >= 3) continue;
      const next = Number(((m.confidence ?? 0.7) - 0.15).toFixed(2));
      if (next < 0.3) await supabase.from("user_memories").delete().eq("id", m.id);
      else await supabase.from("user_memories").update({ confidence: next, decayed_at: nowIso }).eq("id", m.id);
    }
  } catch (e) {
    console.error("[forget] failed:", e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------
// 2b) AWARENESS EXTRACTION — events, priorities, inside jokes
// ---------------------------------------------------------------

const AWARENESS_PROMPT = `אתה שכבת מודעות של בוט אישי בעברית. קיבלת חילופי הודעות.
המשימה: לזהות (א) אירועים שראוי לעקוב אחריהם, (ב) בדיחות פנימיות שחוזרות.

אירוע = יום הולדת, פגישה, ראיון, מבחן, טיסה/נסיעה, עבודה חדשה, דדליין, תור לרופא, אירוע שהמשתמש מחכה לו, יעד עם תאריך.
דירוג חשיבות: 4=קריטי (משנה חיים/דדליין קשיח), 3=חשוב, 2=רגיל, 1=זניח.
when_at = ISO מלא רק אם ברור מהשיחה; אחרת null, ולשים את הניסוח החופשי ב-when_text ("יום שלישי הבא").
בדיחה פנימית = ניסוח/מוטיב שחוזר בין השניים ומצחיק אותם, לא בדיחה חד־פעמית.

החזר JSON תקין בלבד:
{"events":[{"title":"מבחן בסטטיסטיקה","kind":"exam","when_at":null,"when_text":"יום שלישי","importance":3,"confidence":0.8}],
 "jokes":[{"phrase":"האשמת את ה-WiFi","meaning":"תירוץ קבוע שלו"}]}
אם אין כלום — {"events":[],"jokes":[]}.`;

export async function runAwarenessExtraction(
  callModel: ModelCall,
  args: { userText: string; replyText: string; history: HistoryMsg[] },
): Promise<{ events: UserEvent[]; jokes: { phrase: string; meaning?: string }[] }> {
  const empty = { events: [], jokes: [] };
  try {
    const convo = [...args.history.slice(-4), { role: "user", content: args.userText }, { role: "assistant", content: args.replyText }]
      .map((m) => `${m.role === "assistant" ? "בוט" : "משתמש"}: ${m.content}`)
      .join("\n");
    const res = await callModel({
      systemInstruction: { parts: [{ text: AWARENESS_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: `הזמן עכשיו: ${new Date().toISOString()}\n\nהשיחה:\n${convo}` }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 512, responseMimeType: "application/json" },
    });
    if (!res.ok) return empty;
    const raw: string =
      res.data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
    return {
      events: Array.isArray(parsed.events) ? parsed.events.filter((e: any) => e?.title).slice(0, 4) : [],
      jokes: Array.isArray(parsed.jokes) ? parsed.jokes.filter((j: any) => j?.phrase).slice(0, 3) : [],
    };
  } catch (e) {
    console.error("[awareness] extraction failed:", e instanceof Error ? e.message : String(e));
    return empty;
  }
}

// ---------------------------------------------------------------
// 🧨 LIFE LOOP — should the bot reach out on its own, and why?
// ---------------------------------------------------------------

export type LifeLoopReason = {
  score: number;
  kind: "event_soon" | "event_passed" | "goal_stale" | "memory_callback" | "habit" | "silence";
  message: string;
};

export async function lifeLoopDecide(
  supabase: Supa,
  chatId: number,
  opts: { hoursSinceLastUser: number; hoursSinceLastProactive: number },
): Promise<LifeLoopReason | null> {
  const reasons: LifeLoopReason[] = [];
  const now = Date.now();
  try {
    const [{ data: events }, { data: goals }, { data: mems }] = await Promise.all([
      supabase.from("user_events").select("id, title, when_at, when_text, importance, status, asked_after_at").eq("chat_id", chatId).limit(20),
      supabase.from("goals").select("id, title, progress, updated_at").eq("chat_id", chatId).eq("status", "open").limit(10),
      supabase.from("user_memories").select("value, kind, created_at, importance").eq("chat_id", chatId).in("kind", ["project", "request"]).limit(10),
    ]);

    for (const e of events ?? []) {
      const imp = e.importance ?? 2;
      if (e.status === "open" && e.when_at) {
        const h = (new Date(e.when_at).getTime() - now) / 3_600_000;
        if (h > 2 && h < 30) {
          reasons.push({
            score: 6 + imp,
            kind: "event_soon",
            message: pick([
              `מחר יש לך את ${e.title}. רק אומר 😏`,
              `${e.title} מתקרב. מוכן, או שנעשה כאילו לא דיברנו?`,
              `תזכורת שקטה: ${e.title}. זהו, לא מציק יותר.`,
            ]),
          });
        }
      }
      if (e.status === "passed" && !e.asked_after_at) {
        reasons.push({
          score: 7 + imp,
          kind: "event_passed",
          message: pick([`נו? איך הלך עם ${e.title}?`, `לא סיפרת לי מה קרה עם ${e.title}. 👀`, `${e.title} — עבר. חי לספר?`]),
        });
      }
    }

    for (const g of goals ?? []) {
      const days = (now - new Date(g.updated_at ?? Date.now()).getTime()) / 86_400_000;
      if (days >= 12) {
        reasons.push({
          score: 5,
          kind: "goal_stale",
          message: pick([
            `עברו כמעט שבועיים מאז שאמרת שאתה רוצה ${g.title}. התקדמת?`,
            `${g.title} — עדיין על השולחן, או שעברנו לשלב ההכחשה?`,
          ]),
        });
      }
    }

    for (const m of mems ?? []) {
      const days = (now - new Date(m.created_at).getTime()) / 86_400_000;
      if (days >= 5) {
        reasons.push({
          score: 3 + (m.importance ?? 2) / 2,
          kind: "memory_callback",
          message: pick([`רגע, לא אמרת לי איך הלך עם "${m.value}".`, `"${m.value}" — עדיין רלוונטי, או שנשכח מזה יפה?`]),
        });
      }
    }

    if (opts.hoursSinceLastUser >= 60) {
      reasons.push({
        score: 2,
        kind: "silence",
        message: pick(["נעלמת. הכל טוב?", "יומיים שקט. או שסידרת הכל, או שאתה מתחבא 👀"]),
      });
    }

    if (!reasons.length) return null;
    if (opts.hoursSinceLastProactive < 20) return null;
    reasons.sort((a, b) => b.score - a.score);
    // A little randomness so it doesn't feel like a scheduler.
    const top = reasons.slice(0, 2);
    return top[Math.floor(Math.random() * top.length)];
  } catch (e) {
    console.error("[lifeloop] failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

export async function markLifeLoopSent(supabase: Supa, chatId: number, reason: LifeLoopReason) {
  try {
    if (reason.kind === "event_passed") {
      await supabase
        .from("user_events")
        .update({ asked_after_at: new Date().toISOString() })
        .eq("chat_id", chatId)
        .eq("status", "passed")
        .is("asked_after_at", null);
    }
  } catch {
    /* ignore */
  }
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
