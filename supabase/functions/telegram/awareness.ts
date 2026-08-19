/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Goal } from "./profile.ts";
import type { HistoryMsg, Memory, ModelCall, Supa } from "./brain.ts";

export type UserEvent = {
  id?: string;
  title: string;
  kind: string;
  when_at?: string | null;
  when_text?: string | null;
  importance?: number;
  confidence?: number;
  status?: string;
  asked_after_at?: string | null;
};

export type InsideJoke = { id?: string; phrase: string; meaning?: string | null; hits: number };
export type SurpriseMode = "none" | "mention" | "tease" | "callback";

const EVENT_RE = /(יום הולדת|חתונה|ברית|פגישה|ראיון|מבחן|בוחן|מצגת|טיסה|נסיעה|חופשה|דדליין|הגשה|עבודה חדשה|מתחיל עבודה|רופא|תור ל|בדיקה|ניתוח|מסיבה|אירוע|הופעה|תחרות)/;
const HEAVY_RE = /(מרגיש|קשה לי|לבד|בודד|פוחד|חרד|לחוץ|שחוק|מדוכא|עצוב|כועס|לא מספר לאף אחד|נשבר לי|מתוסכל)/;
const STOP = new Set(["את", "של", "עם", "זה", "אתה", "אני", "לא", "כן", "על", "כמו", "מה", "אבל", "יש"]);

export const IMPORTANCE_ICON: Record<number, string> = { 4: "🔴", 3: "🟠", 2: "🟡", 1: "⚪" };

export function importanceOf(memory: Memory): number {
  if (typeof memory.importance === "number") return Math.max(1, Math.min(4, memory.importance));
  if (memory.kind === "relationship" || memory.kind === "project") return 3;
  return memory.kind === "joke" ? 1 : 2;
}

export function rankMemories<T extends Memory>(memories: T[], limit = 12): T[] {
  const now = Date.now();
  return [...memories]
    .map((memory) => {
      const ageDays = memory.updated_at ? (now - new Date(memory.updated_at).getTime()) / 86_400_000 : 30;
      const score = importanceOf(memory) * 2 + (memory.confidence ?? 0.7) * 2 - Math.min(3, ageDays / 30);
      return { memory, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.memory);
}

export function confidenceContext(memories: Memory[]): string {
  const solid = memories.filter((memory) => (memory.confidence ?? 0.7) >= 0.85);
  const uncertain = memories.filter((memory) => (memory.confidence ?? 0.7) < 0.55);
  const lines: string[] = [];
  if (solid.length) lines.push(`דברים ודאיים: ${solid.slice(0, 5).map((m) => m.value).join(" | ")}`);
  if (uncertain.length) lines.push(`דברים לא ודאיים: ${uncertain.slice(0, 4).map((m) => m.value).join(" | ")}. אל תציג אותם כעובדה.`);
  return lines.length ? `רמות ודאות:\n${lines.join("\n")}` : "";
}

export async function fetchEvents(supabase: Supa, chatId: number): Promise<UserEvent[]> {
  try {
    const { data } = await supabase
      .from("user_events")
      .select("id, title, kind, when_at, when_text, importance, confidence, status, asked_after_at")
      .eq("chat_id", chatId)
      .eq("status", "open")
      .order("importance", { ascending: false })
      .limit(15);
    return (data ?? []) as UserEvent[];
  } catch { return []; }
}

export async function upsertEvents(supabase: Supa, chatId: number, events: UserEvent[]) {
  for (const event of events.slice(0, 4)) {
    const title = String(event.title ?? "").trim().slice(0, 140);
    if (!title) continue;
    const { data: existing } = await supabase.from("user_events").select("id").eq("chat_id", chatId).ilike("title", title).maybeSingle();
    const row = {
      chat_id: chatId,
      title,
      kind: event.kind || "event",
      when_at: event.when_at ?? null,
      when_text: event.when_text ?? null,
      importance: Math.max(1, Math.min(4, Number(event.importance ?? 2))),
      confidence: Math.max(0.1, Math.min(1, Number(event.confidence ?? 0.7))),
      updated_at: new Date().toISOString(),
    };
    if (existing?.id) await supabase.from("user_events").update(row).eq("id", existing.id);
    else await supabase.from("user_events").insert(row);
  }
}

function relativeTime(when: string): string {
  const hours = (new Date(when).getTime() - Date.now()) / 3_600_000;
  if (hours < 0) return "כבר עבר";
  if (hours < 2) return "עוד פחות משעתיים";
  if (hours < 24) return `עוד ${Math.round(hours)} שעות`;
  const days = Math.round(hours / 24);
  return days === 1 ? "מחר" : `עוד ${days} ימים`;
}

export function eventContext(events: UserEvent[]): string {
  if (!events.length) return "";
  const lines = events.map((event) => `- ${IMPORTANCE_ICON[event.importance ?? 2]} ${event.title} (${event.when_at ? relativeTime(event.when_at) : event.when_text ?? "מועד לא ידוע"})`);
  return `אירועים פתוחים של המשתמש:\n${lines.join("\n")}\nהזכר אירוע רק אם הוא קשור לשיחה או קרוב בזמן. אל תחזור עליו בכל הודעה.`;
}

export function implicitIntentLayer(text: string, context: { events: UserEvent[]; goals: Goal[]; reminders: string[] }): string {
  if (!/(אין לי כוח|לא בא לי|נמאס|אולי מחר|לא היום|לא מצליח|שכחתי|לא הספקתי|קשה לי)/.test(text)) return "";
  const open = [...context.events.map((e) => e.title), ...context.goals.map((g) => g.title), ...context.reminders].filter(Boolean).slice(0, 6);
  return `ייתכן שיש כוונה מרומזת מאחורי ההודעה. אם יש קשר ברור לאחד מהנושאים האלה: ${open.join(" | ") || "אין נושא פתוח ידוע"}, התייחס אליו באופן טבעי. אם אין קשר ברור, אל תנחש.`;
}

export function detectDeepMode(text: string, history: HistoryMsg[]): { deep: boolean; topic: string | null } {
  const recent = history.filter((m) => m.role === "user").slice(-4);
  const sustained = recent.filter((m) => HEAVY_RE.test(m.content) || m.content.length > 120).length >= 2;
  const deep = HEAVY_RE.test(text) && (text.length > 100 || sustained);
  const topic = text.split(/[.!?\n]/).map((s) => s.trim()).find((s) => s.length > 12) ?? null;
  return { deep, topic: deep ? topic.slice(0, 120) : null };
}

export function deepModeInstruction(topic: string | null): string {
  return `השיחה עמוקה${topic ? `, בנושא: ${topic}` : ""}. האט, אל תצחיק בכוח, אל תיתן רשימת עצות. שיקוף קצר ושאלה אחת עדיפה.`;
}

export async function fetchInsideJokes(supabase: Supa, chatId: number): Promise<InsideJoke[]> {
  try {
    const { data } = await supabase.from("inside_jokes").select("id, phrase, meaning, hits").eq("chat_id", chatId).gte("hits", 2).order("hits", { ascending: false }).limit(5);
    return (data ?? []) as InsideJoke[];
  } catch { return []; }
}

export async function bumpInsideJokes(supabase: Supa, chatId: number, jokes: Array<{ phrase: string; meaning?: string }>) {
  for (const joke of jokes.slice(0, 3)) {
    const phrase = String(joke.phrase ?? "").trim().slice(0, 80);
    if (!phrase) continue;
    const { data: existing } = await supabase.from("inside_jokes").select("id, hits").eq("chat_id", chatId).ilike("phrase", phrase).maybeSingle();
    if (existing?.id) await supabase.from("inside_jokes").update({ hits: (existing.hits ?? 1) + 1, last_used_at: new Date().toISOString() }).eq("id", existing.id);
    else await supabase.from("inside_jokes").insert({ chat_id: chatId, phrase, meaning: joke.meaning ?? null });
  }
}

export function insideJokeContext(jokes: InsideJoke[]): string {
  if (!jokes.length) return "";
  return `בדיחות פנימיות: ${jokes.map((j) => `"${j.phrase}"`).join(" | ")}. השתמש באחת רק אם זה נופל טבעי, ולא בכל הודעה.`;
}

export function rollSurprise(hasMaterial: boolean, deepMode: boolean): SurpriseMode {
  if (!hasMaterial || deepMode) return "none";
  const roll = Math.random();
  if (roll < 0.7) return "none";
  if (roll < 0.85) return "mention";
  if (roll < 0.95) return "tease";
  return "callback";
}

export function surpriseInstruction(mode: SurpriseMode, material: string[]): string {
  if (mode === "none" || !material.length) return "";
  const item = material[Math.floor(Math.random() * material.length)];
  if (mode === "mention") return `אפשר להזכיר בעדינות את ${item} רק אם זה מתחבר לשיחה.`;
  if (mode === "tease") return `אפשר עקיצה חיבתית אחת על ${item}, רק אם היא טבעית.`;
  return `אפשר callback קצר ל-${item}, רק אם הוא קשור.`;
}

export function fingerprint(text: string): string {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(words)].sort().slice(0, 8).join(" ");
}

function jaccard(a: string, b: string): number {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  const intersection = [...A].filter((word) => B.has(word)).length;
  return intersection / (A.size + B.size - intersection);
}

export async function fetchRecentPhrases(supabase: Supa, chatId: number): Promise<Array<{ text: string; fingerprint: string }>> {
  try {
    const { data } = await supabase.from("bot_phrases").select("text, fingerprint").eq("chat_id", chatId).order("created_at", { ascending: false }).limit(12);
    return data ?? [];
  } catch { return []; }
}

export async function rememberPhrase(supabase: Supa, chatId: number, text: string) {
  try {
    await supabase.from("bot_phrases").insert({ chat_id: chatId, text: text.slice(0, 400), fingerprint: fingerprint(text) });
  } catch (error) { console.error("[phrases] save failed:", error); }
}

export function isRepetitive(reply: string, recent: Array<{ fingerprint: string }>): boolean {
  const current = fingerprint(reply);
  return Boolean(current) && recent.some((item) => jaccard(current, item.fingerprint ?? "") >= 0.55);
}

export function antiRepetitionInstruction(recent: Array<{ text: string }>): string {
  if (!recent.length) return "";
  return `ניסוחים שכבר אמרת לאחרונה ואסור לחזור עליהם: ${recent.slice(0, 8).map((item) => item.text.slice(0, 80)).join(" | ")}`;
}

const AI_SMELL = [/אני כאן (כדי|בשבילך)/, /אשמח לסייע/, /לסיכום/, /באופן כללי/, /אני מבין את התסכול/, /כפי שציינת/];

export function humanityCheck(reply: string, context: { deepMode: boolean; recent: Array<{ fingerprint: string }>; userText: string; lengthTarget: string }) {
  const problems: string[] = [];
  if (AI_SMELL.some((pattern) => pattern.test(reply))) problems.push("ניסוח רובוטי");
  if (!context.deepMode && reply.length > 320) problems.push("ארוך מדי");
  if ((reply.match(/\p{Extended_Pictographic}/gu) ?? []).length > 2) problems.push("יותר מדי אימוג'ים");
  if (isRepetitive(reply, context.recent)) problems.push("חזרה על ניסוח");
  if ((reply.match(/\?/g) ?? []).length > 1) problems.push("יותר משאלה אחת");
  return { ok: !problems.length, problems };
}

export async function rewriteForHumanity(callModel: ModelCall, args: { reply: string; problems: string[]; personalityPrompt: string; userText: string; lengthTarget: string }): Promise<string | null> {
  const response = await callModel({
    systemInstruction: { parts: [{ text: `שכתב הודעת וואטסאפ בעברית טבעית. בעיות: ${args.problems.join(", ")}. אורך: ${args.lengthTarget}. בלי שפה רשמית, עד שני אימוג'ים, עד שאלה אחת. החזר רק הודעה.` }] },
    contents: [{ role: "user", parts: [{ text: `הודעת משתמש: ${args.userText}\nטיוטה: ${args.reply}\nאישיות: ${args.personalityPrompt.slice(0, 500)}` }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 220 },
  });
  if (!response.ok) return null;
  const text = response.data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("").trim();
  return text?.length > 1 ? text : null;
}

export async function runForgettingEngine(supabase: Supa, chatId: number) {
  const now = new Date().toISOString();
  try {
    await supabase.from("user_events").update({ status: "passed", updated_at: now }).eq("chat_id", chatId).eq("status", "open").lt("when_at", now);
    await supabase.from("user_memories").delete().eq("chat_id", chatId).not("expires_at", "is", null).lt("expires_at", now);
  } catch (error) { console.error("[forget] failed:", error); }
}

const AWARENESS_PROMPT = `החזר JSON בלבד: {"events":[{"title":"","kind":"event","when_at":null,"when_text":null,"importance":2,"confidence":0.7}],"jokes":[{"phrase":"","meaning":""}]}. חלץ רק אירועים עתידיים אמיתיים ובדיחות פנימיות חוזרות.`;

export async function runAwarenessExtraction(callModel: ModelCall, args: { userText: string; replyText: string; history: HistoryMsg[] }) {
  const empty = { events: [] as UserEvent[], jokes: [] as Array<{ phrase: string; meaning?: string }> };
  const response = await callModel({
    systemInstruction: { parts: [{ text: AWARENESS_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: `משתמש: ${args.userText}\nבוט: ${args.replyText}` }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 512, responseMimeType: "application/json" },
  });
  if (!response.ok) return empty;
  try {
    const raw = response.data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, ""));
    return {
      events: Array.isArray(parsed.events) ? parsed.events.filter((event: UserEvent) => event?.title).slice(0, 4) : [],
      jokes: Array.isArray(parsed.jokes) ? parsed.jokes.filter((joke: InsideJoke) => joke?.phrase).slice(0, 3) : [],
    };
  } catch (error) {
    console.error("[awareness] extraction JSON failed:", error);
    return empty;
  }
}
