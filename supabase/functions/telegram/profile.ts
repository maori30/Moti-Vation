// ============================================================
// Moti — dynamic user profile, behaviour learning, pacing,
// goals, memory-linking, self-correction, decision engine and
// per-user evolving personality blends.
// Pure-ish helpers; every DB call is defensive (never throws).
// ============================================================
import type { Memory, Supa, HistoryMsg } from "./brain.ts";

export type Profile = {
  chat_id: number;
  address_style: string | null;      // איך אוהב שמדברים אליו
  humor_level: number;               // 0..1 learned
  topics: string[];
  habits: string[];
  active_hours: number[];            // hours the user actually replies in
  procrastinates: string[];
  reminder_wins: Record<string, number>;   // hour -> score
  reply_len_avg: number;
  prefers_short: boolean;
  blend: Record<string, number>;     // per-personality mix, e.g. {cynic:0.7,friendly:0.2,serious:0.1}
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
    const { data } = await supabase.from("user_profile").select("*").eq("chat_id", chatId).maybeSingle();
    if (!data) return { ...EMPTY, chat_id: chatId };
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
  try {
    await supabase
      .from("user_profile")
      .upsert({ chat_id: chatId, ...patch, updated_at: new Date().toISOString() }, { onConflict: "chat_id" });
  } catch (e) {
    console.error("[profile] save failed:", e instanceof Error ? e.message : String(e));
  }
}

// ---------- behaviour log ------------------------------------
export type BehaviorKind =
  | "message"          // user wrote something
  | "laughed"          // חחח / 😂 right after our reply
  | "reminder_done"
  | "reminder_snoozed"
  | "reminder_cancelled"
  | "reminder_rescheduled"
  | "short_reply"      // one word / emoji only
  | "ignored_long";    // we sent a long message, user gave a one-word answer

export async function logBehavior(
  supabase: Supa,
  chatId: number,
  kind: BehaviorKind,
  payload: Record<string, unknown> = {}
) {
  try {
    await supabase.from("behavior_events").insert({ chat_id: chatId, kind, payload });
  } catch {
    /* logging must never break a conversation */
  }
}

// Learns from the last ~200 events. Cheap: one select + one upsert, runs after the reply.
export async function learnFromBehavior(supabase: Supa, chatId: number, profile: Profile) {
  try {
    const { data } = await supabase
      .from("behavior_events")
      .select("kind, payload, created_at")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(200);
    const events = data ?? [];
    if (events.length < 5) return;

    const hourCount: Record<number, number> = {};
    let laughs = 0;
    let shorts = 0;
    let ignoredLong = 0;
    let lens: number[] = [];
    const wins: Record<string, number> = { ...profile.reminder_wins };

    for (const e of events) {
      const created = new Date(e.created_at as string);
      const hour = Number(
        new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", hour12: false }).format(created)
      );
      if (e.kind === "message") {
        hourCount[hour] = (hourCount[hour] ?? 0) + 1;
        const len = Number((e.payload as Record<string, unknown>)?.len ?? 0);
        if (len > 0) lens.push(len);
      }
      if (e.kind === "laughed") laughs++;
      if (e.kind === "short_reply") shorts++;
      if (e.kind === "ignored_long") ignoredLong++;
      const h = String((e.payload as Record<string, unknown>)?.hour ?? "");
      if (h) {
        if (e.kind === "reminder_done") wins[h] = (wins[h] ?? 0) + 1;
        if (e.kind === "reminder_snoozed" || e.kind === "reminder_cancelled") wins[h] = (wins[h] ?? 0) - 1;
      }
    }

    const activeHours = Object.entries(hourCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([h]) => Number(h));
    const total = events.length;
    const laughRatio = laughs / total;
    const humor = clamp(profile.humor_level + (laughRatio > 0.12 ? 0.08 : laughRatio < 0.03 ? -0.05 : 0), 0.15, 1);
    const replyLenAvg = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : profile.reply_len_avg;
    const prefersShort = ignoredLong >= 3 || shorts / total > 0.35 || (replyLenAvg > 0 && replyLenAvg < 25);

    await saveProfile(supabase, chatId, {
      active_hours: activeHours,
      humor_level: humor,
      reply_len_avg: replyLenAvg,
      prefers_short: prefersShort,
      reminder_wins: wins,
    });
  } catch (e) {
    console.error("[profile] learn failed:", e instanceof Error ? e.message : String(e));
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export function profileContext(p: Profile): string {
  const parts: string[] = [];
  if (p.address_style) parts.push(`סגנון פנייה שהמשתמש אוהב: ${p.address_style}`);
  if (p.topics.length) parts.push(`נושאים שמעניינים אותו: ${p.topics.slice(0, 6).join(", ")}`);
  if (p.habits.length) parts.push(`הרגלים: ${p.habits.slice(0, 5).join(", ")}`);
  if (p.active_hours.length) parts.push(`שעות שהוא באמת פעיל בהן: ${p.active_hours.map((h) => `${h}:00`).join(", ")}`);
  if (p.procrastinates.length) parts.push(`נוטה לדחות: ${p.procrastinates.slice(0, 5).join(", ")}`);
  const best = bestReminderHour(p);
  if (best) parts.push(`תזכורות עובדות עליו בעיקר סביב ${best}:00 — הצע את זה אם צריך לקבוע שעה`);
  const worst = worstReminderHour(p);
  if (worst) parts.push(`תזכורות בשעה ${worst}:00 בדרך כלל לא עובדות עליו — אל תציע אותה`);
  if (!parts.length) return "";
  return `פרופיל משתמש (נלמד מהתנהגות, לא להקריא לו את זה):\n${parts.map((s) => `- ${s}`).join("\n")}`;
}

export function bestReminderHour(p: Profile): string | null {
  const e = Object.entries(p.reminder_wins).filter(([, v]) => v >= 2).sort((a, b) => b[1] - a[1])[0];
  return e ? e[0] : null;
}
export function worstReminderHour(p: Profile): string | null {
  const e = Object.entries(p.reminder_wins).filter(([, v]) => v <= -2).sort((a, b) => a[1] - b[1])[0];
  return e ? e[0] : null;
}

// ---------- 3+4. conversation pacing / when not to talk ------
export type Pacing = {
  kind: "micro" | "short" | "normal";
  instantReply?: string;   // if set — send this instead of calling the model
  instruction: string;
};

const LAUGH_RE = /^(ח{3,}|חח|😂+|🤣+|לול|lol|haha+)[!\s.]*$/i;
const ACK_RE = /^(סבבה|אוקיי|אוקי|ok|okay|כן|יאללה|טוב|בסדר|מגניב|יופי|תודה|אחלה|סגור|👍+|🙏+|❤️+|💪+)[!\s.]*$/i;

export function pacing(text: string, lastBotReply: string, p: Profile): Pacing {
  const t = text.trim();
  if (LAUGH_RE.test(t)) {
    const options = ["😂", "ידעתי.", "😏", "חח כן."];
    return {
      kind: "micro",
      instantReply: options[Math.floor(Math.random() * options.length)],
      instruction: "המשתמש רק צחק. תגובה של תו-שניים מקסימום. לא לפתוח נושא חדש.",
    };
  }
  if (ACK_RE.test(t)) {
    const endedWithQuestion = /[?？]\s*$/.test(lastBotReply ?? "");
    if (!endedWithQuestion) {
      const options = ["👍", "סגור.", "אוקיי 👌"];
      return {
        kind: "micro",
        instantReply: options[Math.floor(Math.random() * options.length)],
        instruction: "המשתמש רק אישר. לא לפתוח שיחה חדשה.",
      };
    }
    return { kind: "short", instruction: "המשתמש אישר בקצרה — תענה במשפט אחד קצר בלבד, בלי לפתוח נושא חדש." };
  }
  if (t.length <= 12) {
    return { kind: "short", instruction: "ההודעה קצרה מאוד — תענה משפט אחד. אורך התשובה מתאים לאורך ההודעה." };
  }
  if (p.prefers_short) {
    return { kind: "short", instruction: "המשתמש הזה מתעלם מהודעות ארוכות. משפט אחד עד שניים, בלי הקדמות." };
  }
  return { kind: "normal", instruction: "" };
}

export function isLaugh(text: string): boolean {
  return LAUGH_RE.test(text.trim());
}
export function isShortReply(text: string): boolean {
  return text.trim().length <= 12;
}

// ---------- 6. goals ----------------------------------------
export type Goal = {
  id?: string;
  title: string;
  deadline?: string | null;   // ISO or free text
  progress?: string | null;
  status?: string;
};

const GOAL_RE =
  /(אני רוצה ל|המטרה שלי|אני מתכוון ל|שמתי לי למטרה|אני חייב לסיים|אני רוצה לסיים|מטרה שלי)/;

export function detectGoalStatement(text: string): boolean {
  return GOAL_RE.test(text);
}

export async function fetchGoals(supabase: Supa, chatId: number): Promise<Goal[]> {
  try {
    const { data } = await supabase
      .from("goals")
      .select("id, title, deadline, progress, status")
      .eq("chat_id", chatId)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(8);
    return (data ?? []) as Goal[];
  } catch {
    return [];
  }
}

export async function upsertGoals(supabase: Supa, chatId: number, goals: Goal[]) {
  if (!goals.length) return;
  try {
    for (const g of goals) {
      const { data: existing } = await supabase
        .from("goals")
        .select("id")
        .eq("chat_id", chatId)
        .eq("title", g.title)
        .maybeSingle();
      if (existing?.id) {
        await supabase
          .from("goals")
          .update({
            deadline: g.deadline ?? null,
            progress: g.progress ?? null,
            status: g.status ?? "open",
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      } else {
        await supabase.from("goals").insert({
          chat_id: chatId,
          title: g.title,
          deadline: g.deadline ?? null,
          progress: g.progress ?? null,
          status: g.status ?? "open",
        });
      }
    }
  } catch (e) {
    console.error("[goals] upsert failed:", e instanceof Error ? e.message : String(e));
  }
}

export function goalContext(goals: Goal[]): string {
  if (!goals.length) return "";
  const lines = goals.map((g) => {
    const dl = g.deadline ? ` (עד ${g.deadline})` : "";
    const pr = g.progress ? ` — התקדמות: ${g.progress}` : " — התקדמות: לא ידועה";
    return `- ${g.title}${dl}${pr}`;
  });
  return `מטרות ארוכות טווח של המשתמש:\n${lines.join(
    "\n"
  )}\nמותר ואף מומלץ להזכיר מטרה רלוונטית בטבעיות באמצע שיחה ("אגב, מה עם X?"), אבל לא יותר ממטרה אחת בהודעה ולא בכל הודעה.`;
}

// ---------- 7. memory linking / reasoning --------------------
export function linkedReasoning(text: string, memories: Memory[], goals: Goal[], p: Profile): string {
  if (!memories.length && !goals.length) return "";
  const freeHint = memories.find((m) => /עד\s?\d{1,2}[:.]?\d{0,2}|שעות עבודה|עובד/.test(m.value));
  const hints: string[] = [];
  if (freeHint) hints.push(`אילוץ זמן ידוע: ${freeHint.value}`);
  const best = bestReminderHour(p);
  if (best) hints.push(`שעה שעובדת עליו: ${best}:00`);
  return `חיבור זיכרונות (Reasoning): לפני שאתה עונה, בדוק אם אפשר לחבר את מה שהמשתמש אמר עכשיו עם משהו שאתה כבר יודע עליו (${hints.join(
    "; "
  ) || "זיכרונות ומטרות למעלה"}). אם החיבור מוליד הצעה קונקרטית — הצע אותה כשאלה אחת קצרה, למשל "רוצה שאשים תזכורת ללמוד היום ב-19:30?". אם אין חיבור אמיתי — אל תמציא.`;
}

// ---------- 5. self-correction / contradictions --------------
export function selfCorrectionLayer(text: string, memories: Memory[], goals: Goal[]): string {
  if (!memories.length && !goals.length) return "";
  return `תיקון עצמי וסתירות: אם מה שהמשתמש אומר עכשיו סותר משהו שאתה יודע עליו (זיכרון או מטרה למעלה) — ציין את זה בקצרה ובטון שלך ותשאל מה השתנה, למשל "רגע, אמרת שזה ביום חמישי. השתנה משהו?". אם אתה מבין שטעית בהודעה קודמת שלך — תתקן את עצמך בפתיחות ("רגע, לא — התכוונתי ל...") במקום להתעלם.`;
}

// ---------- 8. decision engine -------------------------------
export type Decision = {
  needAction: boolean;
  lengthTarget: string;
  askQuestion: boolean;
  layer: string;
};

export function decisionEngine(opts: {
  text: string;
  pacing: Pacing;
  hasMemory: boolean;
  hasGoals: boolean;
  humorLevel: number;
  mood: string;
}): Decision {
  const { text, pacing: pc, hasMemory, hasGoals, humorLevel, mood } = opts;
  const lengthTarget =
    pc.kind === "micro" ? "עד 3 מילים" : pc.kind === "short" ? "משפט אחד" : "1-2 משפטים קצרים";
  const askQuestion = pc.kind === "normal" && /\?|לא יודע|מה לעשות|תעזור|איך/.test(text);
  const needAction = /תזכיר|תזכורת|תקבע|תמחק|תעדכן/.test(text);
  const layer = `מנוע החלטות (עבור על זה בראש לפני שאתה כותב, ואל תכתוב את השלבים):
1) מה המשתמש רוצה בהודעה הזאת? (מידע / רגש / פעולה / סתם ג'יבריש)
2) יש זיכרון או מטרה רלוונטיים? ${hasMemory || hasGoals ? "כן — השתמש רק אם זה באמת מתאים" : "לא — אל תמציא"}
3) האם המצב מתאים להומור? רמת הומור נוכחית: ${Math.round(humorLevel * 100)}%, מצב רוח: ${mood}
4) האם צריך לשאול שאלה? ${askQuestion ? "כן — שאלה אחת קונקרטית" : "לא בהכרח — אל תדחוף שאלה בכוח"}
5) האם צריך לבצע פעולה (תזכורת/מטרה)? ${needAction ? "כן" : "לא"}
6) אורך התשובה הנדרש: ${lengthTarget}
ואז — תכתוב את התשובה עצמה בלבד.`;
  return { needAction, lengthTarget, askQuestion, layer };
}

// ---------- ⭐ evolving personality blend --------------------
const DEFAULT_BLEND: Record<string, number> = { core: 0.7, friendly: 0.2, serious: 0.1 };

export function currentBlend(p: Profile, personalityKey: string): Record<string, number> {
  const b = p.blend?.[personalityKey] as unknown;
  if (b && typeof b === "object") return b as Record<string, number>;
  return DEFAULT_BLEND;
}

export function blendInstruction(personalityName: string, blend: Record<string, number>): string {
  const label: Record<string, string> = {
    core: "האופי הבסיסי של האישיות",
    friendly: "חברי וחם",
    serious: "רציני ומעשי",
    silly: "שטויות והשתטות",
  };
  const mix = Object.entries(blend)
    .filter(([, v]) => v > 0.02)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${Math.round(v * 100)}% ${label[k] ?? k}`)
    .join(", ");
  return `כיול אישיות למשתמש הזה (${personalityName}): ${mix}. זו אותה אישיות, רק בגרסה שהתאימה את עצמה למשתמש הספציפי הזה לאורך זמן.`;
}

// Nudges the blend a little each turn — slow, so the personality "grows".
export function evolveBlend(
  blend: Record<string, number>,
  signals: { laughed: boolean; serious: boolean; shortMode: boolean }
): Record<string, number> {
  const next = { core: 0, friendly: 0, serious: 0, silly: 0, ...blend };
  const step = 0.02;
  if (signals.laughed) {
    next.silly += step;
    next.core += step / 2;
    next.serious -= step;
  }
  if (signals.serious) {
    next.serious += step;
    next.silly -= step;
  }
  if (signals.shortMode) {
    next.core += step / 2;
    next.friendly -= step / 4;
  }
  for (const k of Object.keys(next)) next[k] = clamp(next[k], 0, 1);
  const sum = Object.values(next).reduce((a, b) => a + b, 0) || 1;
  for (const k of Object.keys(next)) next[k] = Number((next[k] / sum).toFixed(3));
  return next;
}

// ---------- 1+2 profile extraction (model-assisted) ---------
export async function runProfileExtraction(
  call: (payload: Record<string, unknown>) => Promise<{ ok: boolean; data?: any }>,
  args: { userText: string; replyText: string; history: HistoryMsg[]; profile: Profile }
): Promise<{ patch: Partial<Profile>; goals: Goal[] }> {
  const prompt = `נתח את השיחה והחזר JSON בלבד (בלי הסברים):
{"address_style":string|null,"topics":string[],"habits":string[],"procrastinates":string[],"goals":[{"title":string,"deadline":string|null,"progress":string|null,"status":"open"|"done"}]}
חוקים: רק דברים שנאמרו במפורש או ברורים לחלוטין. אם אין מה להוסיף — החזר מערכים ריקים ו-null.
נושאים/הרגלים/דחיינות = מקסימום 3 חדשים כל אחד, בעברית קצרה.
מטרה = יעד ארוך טווח ("לסיים את האתר החודש"), לא מטלה קטנה.

ידוע כבר: נושאים=${JSON.stringify(args.profile.topics)} הרגלים=${JSON.stringify(
    args.profile.habits
  )} דחיינות=${JSON.stringify(args.profile.procrastinates)}
משתמש: ${args.userText}
בוט: ${args.replyText}`;

  try {
    const res = await call({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 400, responseMimeType: "application/json" },
    });
    if (!res.ok) return { patch: {}, goals: [] };
    const raw =
      res.data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    const json = JSON.parse(raw.replace(/```json|```/g, "").trim());
    const merge = (a: string[], b: unknown) =>
      Array.from(new Set([...(a ?? []), ...(Array.isArray(b) ? (b as string[]) : [])])).slice(-12);
    return {
      patch: {
        address_style: typeof json.address_style === "string" ? json.address_style : args.profile.address_style,
        topics: merge(args.profile.topics, json.topics),
        habits: merge(args.profile.habits, json.habits),
        procrastinates: merge(args.profile.procrastinates, json.procrastinates),
      },
      goals: Array.isArray(json.goals)
        ? json.goals.filter((g: Goal) => g && typeof g.title === "string" && g.title.length > 2).slice(0, 3)
        : [],
    };
  } catch {
    return { patch: {}, goals: [] };
  }
}
