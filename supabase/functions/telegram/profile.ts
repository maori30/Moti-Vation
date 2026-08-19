import type { HistoryMsg, Supa } from "./brain.ts";

export type Goal = {
  id?: string;
  title: string;
  deadline?: string | null;
  progress?: string | null;
  status?: string;
};

export type Profile = {
  chat_id: number;
  address_style: string | null;
  humor_level: number;
  topics: string[];
  habits: string[];
  active_hours: number[];
  procrastinates: string[];
  reminder_wins: Record<string, number>;
  reply_len_avg: number;
  prefers_short: boolean;
  blend: Record<string, Record<string, number>>;
};

const EMPTY: Profile = {
  chat_id: 0,
  address_style: null,
  humor_level: 0.5,
  topics: [],
  habits: [],
  active_hours: [],
  procrastinates: [],
  reminder_wins: {},
  reply_len_avg: 0,
  prefers_short: false,
  blend: {},
};

export async function fetchProfile(supabase: Supa, chatId: number): Promise<Profile> {
  try {
    const { data, error } = await supabase.from("user_profile").select("*").eq("chat_id", chatId).maybeSingle();
    if (error || !data) return { ...EMPTY, chat_id: chatId };
    return {
      ...EMPTY,
      ...data,
      chat_id: chatId,
      topics: data.topics ?? [],
      habits: data.habits ?? [],
      active_hours: data.active_hours ?? [],
      procrastinates: data.procrastinates ?? [],
      reminder_wins: data.reminder_wins ?? {},
      blend: data.blend ?? {},
    } as Profile;
  } catch {
    return { ...EMPTY, chat_id: chatId };
  }
}

export async function saveProfile(supabase: Supa, chatId: number, patch: Partial<Profile>) {
  const { error } = await supabase
    .from("user_profile")
    .upsert({ chat_id: chatId, ...patch, updated_at: new Date().toISOString() }, { onConflict: "chat_id" });
  if (error) console.error("[profile] save failed:", error.message);
}

export type BehaviorKind = "message" | "laughed" | "reminder_done" | "reminder_snoozed" | "short_reply" | "ignored_long";

export async function logBehavior(supabase: Supa, chatId: number, kind: BehaviorKind, payload: Record<string, unknown> = {}) {
  try {
    await supabase.from("behavior_events").insert({ chat_id: chatId, kind, payload });
  } catch (error) {
    console.error("[profile] behavior log failed:", error);
  }
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export async function learnFromBehavior(supabase: Supa, chatId: number, profile: Profile) {
  try {
    const { data } = await supabase
      .from("behavior_events")
      .select("kind, payload, created_at")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(100);
    const events = data ?? [];
    if (events.length < 5) return;

    const activeHourCounts: Record<number, number> = {};
    const wins = { ...profile.reminder_wins };
    let laughs = 0;
    let shorts = 0;
    let longIgnored = 0;
    const messageLengths: number[] = [];

    for (const event of events) {
      const payload = event.payload ?? {};
      if (event.kind === "message") {
        const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", hour12: false }).format(new Date(event.created_at)));
        activeHourCounts[hour] = (activeHourCounts[hour] ?? 0) + 1;
        const length = Number(payload.len ?? 0);
        if (length > 0) messageLengths.push(length);
      }
      if (event.kind === "laughed") laughs++;
      if (event.kind === "short_reply") shorts++;
      if (event.kind === "ignored_long") longIgnored++;
      const reminderHour = String(payload.hour ?? "");
      if (reminderHour) {
        if (event.kind === "reminder_done") wins[reminderHour] = (wins[reminderHour] ?? 0) + 1;
        if (event.kind === "reminder_snoozed") wins[reminderHour] = (wins[reminderHour] ?? 0) - 1;
      }
    }

    const activeHours = Object.entries(activeHourCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([hour]) => Number(hour));
    const average = messageLengths.length ? Math.round(messageLengths.reduce((a, b) => a + b, 0) / messageLengths.length) : profile.reply_len_avg;
    const humorLevel = clamp(profile.humor_level + (laughs / events.length > 0.12 ? 0.05 : laughs / events.length < 0.03 ? -0.03 : 0), 0.15, 0.95);

    await saveProfile(supabase, chatId, {
      active_hours: activeHours,
      reminder_wins: wins,
      reply_len_avg: average,
      // Do not overreact to one-word replies. Require a meaningful pattern.
      prefers_short: longIgnored >= 4 || (events.length >= 20 && shorts / events.length > 0.5),
      humor_level: humorLevel,
    });
  } catch (error) {
    console.error("[profile] learning failed:", error);
  }
}

export function profileContext(profile: Profile): string {
  const lines: string[] = [];
  if (profile.address_style) lines.push(`סגנון פנייה מועדף: ${profile.address_style}`);
  if (profile.topics.length) lines.push(`נושאים שמעניינים אותו: ${profile.topics.slice(0, 5).join(", ")}`);
  if (profile.habits.length) lines.push(`הרגלים: ${profile.habits.slice(0, 5).join(", ")}`);
  if (profile.procrastinates.length) lines.push(`נוטה לדחות: ${profile.procrastinates.slice(0, 4).join(", ")}`);
  if (profile.prefers_short) lines.push("הוא מעדיף תשובות קצרות. זה לא אומר לענות ביבש; משפט או שניים מספיקים.");
  return lines.length ? `פרופיל משתמש, לשימוש פנימי בלבד:\n${lines.map((line) => `- ${line}`).join("\n")}` : "";
}

export function bestReminderHour(profile: Profile): string | null {
  const item = Object.entries(profile.reminder_wins).filter(([, score]) => score >= 2).sort((a, b) => b[1] - a[1])[0];
  return item?.[0] ?? null;
}

export function goalContext(goals: Goal[]): string {
  if (!goals.length) return "";
  return `מטרות פתוחות:\n${goals.slice(0, 5).map((goal) => `- ${goal.title}${goal.deadline ? ` (עד ${goal.deadline})` : ""}${goal.progress ? ` — ${goal.progress}` : ""}`).join("\n")}\nהזכר מטרה רק אם היא קשורה ישירות למה שנאמר עכשיו.`;
}

export async function fetchGoals(supabase: Supa, chatId: number): Promise<Goal[]> {
  try {
    const { data } = await supabase.from("goals").select("id, title, deadline, progress, status").eq("chat_id", chatId).eq("status", "open").order("updated_at", { ascending: false }).limit(8);
    return (data ?? []) as Goal[];
  } catch { return []; }
}

export async function upsertGoals(supabase: Supa, chatId: number, goals: Goal[]) {
  for (const goal of goals.slice(0, 3)) {
    if (!goal.title?.trim()) continue;
    const { data: existing } = await supabase.from("goals").select("id").eq("chat_id", chatId).eq("title", goal.title.trim()).maybeSingle();
    const values = { deadline: goal.deadline ?? null, progress: goal.progress ?? null, status: goal.status ?? "open", updated_at: new Date().toISOString() };
    if (existing?.id) await supabase.from("goals").update(values).eq("id", existing.id);
    else await supabase.from("goals").insert({ chat_id: chatId, title: goal.title.trim(), ...values });
  }
}

export type Pacing = { kind: "micro" | "short" | "normal"; instantReply?: string; instruction: string };
const LAUGH = /^(ח{3,}|חח|😂+|🤣+|לול|lol|haha+)[!\s.]*$/i;
const ACK = /^(סבבה|אוקיי|אוקי|ok|okay|כן|יאללה|טוב|בסדר|מגניב|יופי|תודה|אחלה|סגור|👍+|🙏+|❤️+|💪+)[!\s.]*$/i;

export function isLaugh(text: string) { return LAUGH.test(text.trim()); }
export function isShortReply(text: string) { return text.trim().length <= 12; }

export function pacing(text: string, lastBotReply: string, profile: Profile): Pacing {
  const value = text.trim();
  if (LAUGH.test(value)) return { kind: "micro", instantReply: ["😂", "חח כן.", "ידעתי."][Math.floor(Math.random() * 3)], instruction: "המשתמש רק צחק. אל תפתח נושא חדש." };
  if (ACK.test(value) && !/[?？]\s*$/.test(lastBotReply)) return { kind: "micro", instantReply: ["👍", "סגור.", "אוקיי 👌"][Math.floor(Math.random() * 3)], instruction: "המשתמש רק אישר. אל תפתח נושא חדש." };
  if (value.length <= 12 || profile.prefers_short) return { kind: "short", instruction: "תשובה קצרה: משפט אחד או שניים. אל תהיה יבש." };
  return { kind: "normal", instruction: "" };
}

export function linkedReasoning(text: string, memories: Memory[], goals: Goal[], profile: Profile): string {
  if (!memories.length && !goals.length) return "";
  const bestHour = bestReminderHour(profile);
  return `בדוק אם יש חיבור אמיתי בין ההודעה לבין זיכרון או מטרה קיימים. אם יש, אפשר להזכיר אותו בטבעיות או להציע פעולה אחת. אם אין חיבור אמיתי, אל תמציא. ${bestHour ? `שעת תזכורת שעבדה בעבר: ${bestHour}:00.` : ""}`;
}

export function selfCorrectionLayer(_: string, memories: Memory[], goals: Goal[]): string {
  if (!memories.length && !goals.length) return "";
  return "אם המשתמש סותר משהו שידוע לך, שאל בעדינות מה השתנה. אם אין סתירה, אל תעלה את זה סתם.";
}

export function detectGoalStatement(text: string): boolean {
  return /(אני רוצה ל|המטרה שלי|שמתי לי למטרה|אני חייב לסיים|אני רוצה לסיים)/.test(text);
}

export function decisionEngine(args: { text: string; pacing: Pacing; hasMemory: boolean; hasGoals: boolean; humorLevel: number; mood: string }) {
  const lengthTarget = args.pacing.kind === "micro" ? "עד 3 מילים" : args.pacing.kind === "short" ? "משפט אחד" : "1-2 משפטים";
  return {
    lengthTarget,
    layer: `לפני התשובה, הבן מה המשתמש רוצה עכשיו. אורך יעד: ${lengthTarget}. אל תדחוף שאלה אם לא צריך. אל תזכיר זיכרון או מטרה אם זה לא קשור.`,
  };
}

export function currentBlend(profile: Profile, personality: string): Record<string, number> {
  return profile.blend[personality] ?? { core: 0.75, friendly: 0.15, serious: 0.1 };
}

export function evolveBlend(blend: Record<string, number>, signals: { laughed: boolean; serious: boolean; shortMode: boolean }): Record<string, number> {
  const next = { core: 0, friendly: 0, serious: 0, silly: 0, ...blend };
  if (signals.laughed) { next.silly += 0.02; next.serious -= 0.01; }
  if (signals.serious) { next.serious += 0.02; next.silly -= 0.01; }
  const sum = Object.values(next).reduce((a, b) => a + Math.max(0, b), 0) || 1;
  for (const key of Object.keys(next)) next[key] = Number((Math.max(0, next[key]) / sum).toFixed(3));
  return next;
}

export function blendInstruction(name: string, blend: Record<string, number>): string {
  return `כיול האישיות ${name}: שמור על האישיות עצמה. התמהיל הנוכחי הוא ${Object.entries(blend).map(([key, value]) => `${key} ${Math.round(value * 100)}%`).join(", ")}.`;
}

export async function runProfileExtraction(call: (payload: Record<string, unknown>) => Promise<{ ok: boolean; data?: any }>, args: { userText: string; replyText: string; history: HistoryMsg[]; profile: Profile }) {
  const empty = { patch: {} as Partial<Profile>, goals: [] as Goal[] };
  const response = await call({
    systemInstruction: { parts: [{ text: "החזר JSON בלבד: {\"address_style\":null,\"topics\":[],\"habits\":[],\"procrastinates\":[],\"goals\":[]}. שמור רק מידע מפורש ויציב." }] },
    contents: [{ role: "user", parts: [{ text: `משתמש: ${args.userText}\nבוט: ${args.replyText}` }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 400, responseMimeType: "application/json" },
  });
  if (!response.ok) return empty;
  try {
    const raw = response.data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("") ?? "";
    const json = JSON.parse(raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, ""));
    const merge = (a: string[], b: unknown) => [...new Set([...(a ?? []), ...(Array.isArray(b) ? b.filter((x): x is string => typeof x === "string") : [])])].slice(-12);
    return {
      patch: {
        address_style: typeof json.address_style === "string" ? json.address_style : args.profile.address_style,
        topics: merge(args.profile.topics, json.topics),
        habits: merge(args.profile.habits, json.habits),
        procrastinates: merge(args.profile.procrastinates, json.procrastinates),
      },
      goals: Array.isArray(json.goals) ? json.goals.filter((goal: Goal) => goal?.title?.length > 2).slice(0, 3) : [],
    };
  } catch (error) {
    console.error("[profile] extraction JSON failed:", error);
    return empty;
  }
}
