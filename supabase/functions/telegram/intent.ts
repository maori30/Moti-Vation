/* eslint-disable @typescript-eslint/no-explicit-any */
// AI intent router: one fast Gemini call that turns a free-form Hebrew message into a
// structured action (create/reschedule/delete a reminder, habits, notes, settings, or plain chat).
//
// Design:
// - The model returns LOCAL date/time parts ("2026-11-13", "08:30") or "in N minutes";
//   converting to an absolute time is done here, in Israel time, by tested code.
// - The model may only reference reminder/habit IDs that we gave it; unknown IDs are dropped.
// - Any failure returns null and the caller falls back to the legacy regex pipeline.
import { advanceRecurring, israelParts, israelTime } from "../_shared/util.ts";

export type RecurrenceType = "once" | "daily" | "weekly" | "yearly";

export type IntentContext = {
  now: Date;
  reminders: Array<{ id: string; text: string; type: string; time: string }>;
  habits: Array<{ id: number | string; title: string }>;
  recent: Array<{ role: string; content: string }>;
};

export type Action =
  | { kind: "chat" }
  | {
    kind: "create_reminder";
    task: string;
    dueAt: Date | null; // null => we still need to ask "when?"
    recurrence: RecurrenceType;
    weather: string | null;
    confirmNeeded: boolean;
    guessed: boolean;
    reason: string | null;
    complexDate: boolean; // holiday-relative etc. -> use the slower reasoning scheduler
  }
  | { kind: "reschedule_reminder"; reminderId: string | null; dueAt: Date | null; complexDate: boolean }
  | { kind: "delete_reminder"; reminderId: string | null }
  | { kind: "list_reminders" }
  | { kind: "mark_done"; reminderId: string | null }
  | { kind: "add_habit"; title: string }
  | { kind: "log_habit"; habitId: string | null; title: string | null }
  | { kind: "list_habits" }
  | { kind: "add_note"; text: string }
  | { kind: "list_notes" }
  | { kind: "countdown"; title: string; targetAt: Date | null }
  | { kind: "status" }
  | { kind: "set_name"; name: string }
  | { kind: "set_gender"; gender: "male" | "female" }
  | { kind: "set_personality"; personality: string; permanent: boolean }
  | { kind: "set_tone"; tone: "serious" | "softer" | "funnier" };

export const INTENTS = [
  "chat", "create_reminder", "reschedule_reminder", "delete_reminder", "list_reminders", "mark_done",
  "add_habit", "log_habit", "list_habits", "add_note", "list_notes", "countdown", "status",
  "set_name", "set_gender", "set_personality", "set_tone",
] as const;

export const PERSONALITY_KEYS = ["coach", "cynic", "friend", "sergeant", "therapist", "hype", "grandma", "philosopher", "frayer", "neighbor"];

// Gemini responseSchema (OpenAPI subset). Flat on purpose: small models fill flat objects reliably.
export const ROUTER_SCHEMA = {
  type: "OBJECT",
  properties: {
    intent: { type: "STRING", enum: [...INTENTS] },
    confidence: { type: "NUMBER" },
    task: { type: "STRING", nullable: true },
    reminder_id: { type: "STRING", nullable: true },
    habit_id: { type: "STRING", nullable: true },
    recurrence: { type: "STRING", enum: ["once", "daily", "weekly", "yearly"], nullable: true },
    date: { type: "STRING", nullable: true, description: "YYYY-MM-DD in Israel" },
    time: { type: "STRING", nullable: true, description: "HH:MM 24h in Israel" },
    in_minutes: { type: "INTEGER", nullable: true },
    weekday: { type: "INTEGER", nullable: true, description: "0=Sunday ... 6=Saturday" },
    complex_date: { type: "BOOLEAN", nullable: true },
    year_given: { type: "BOOLEAN", nullable: true, description: "true only if the user wrote the year explicitly" },
    weather: { type: "STRING", enum: ["rain", "clear", "hot", "cold"], nullable: true },
    confirm_needed: { type: "BOOLEAN", nullable: true },
    guessed_time: { type: "BOOLEAN", nullable: true },
    reason: { type: "STRING", nullable: true },
    text: { type: "STRING", nullable: true },
    name: { type: "STRING", nullable: true },
    gender: { type: "STRING", enum: ["male", "female"], nullable: true },
    personality: { type: "STRING", enum: PERSONALITY_KEYS, nullable: true },
    permanent: { type: "BOOLEAN", nullable: true },
    tone: { type: "STRING", enum: ["serious", "softer", "funnier"], nullable: true },
  },
};
// Every field is required (nullable): with optional fields the model tends to skip time details.
(ROUTER_SCHEMA as any).required = Object.keys(ROUTER_SCHEMA.properties);
(ROUTER_SCHEMA as any).propertyOrdering = Object.keys(ROUTER_SCHEMA.properties);

const WEEKDAY_HE = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

export function buildRouterPrompt(ctx: IntentContext): string {
  const p = israelParts(ctx.now);
  const hhmm = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const reminders = ctx.reminders.length
    ? ctx.reminders.map((r) => {
      const t = israelParts(new Date(r.time));
      return `- id=${r.id} | "${r.text}" | ${r.type} | ${t.date} ${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
    }).join("\n")
    : "(none)";
  const habits = ctx.habits.length ? ctx.habits.map((h) => `- id=${h.id} | "${h.title}"`).join("\n") : "(none)";
  const recent = ctx.recent.length
    ? ctx.recent.map((m) => `${m.role === "assistant" ? "bot" : "user"}: ${String(m.content).slice(0, 300)}`).join("\n")
    : "(none)";

  return `You classify messages sent to a Hebrew Telegram productivity bot ("מוטי") and extract structured fields.
Now in Israel: ${p.date} ${hhmm}, day ${WEEKDAY_HE[p.weekday]} (weekday=${p.weekday}).

The user's active reminders:
${reminders}

The user's habits:
${habits}

Recent conversation (oldest first):
${recent}

Intents:
- create_reminder: the user asks to be reminded / not to forget something at some time ("תזכיר לי", "אל תשכח", "תעיר אותי", "כל יום ב-8 לקחת כדור", "מחר יש לי תור לרופא ב-10, תזכיר לי"). Also when the bot just asked "מתי?" and the user answers with a time for a task discussed in the conversation.
  task = short Hebrew task without time words ("לקחת כדור"). If the user says "עוד פעם"/"שוב"/"אותו דבר", take the task from the conversation.
  Time: use in_minutes for relative times ("עוד 20 דקות" => 20, "עוד שעתיים" => 120, "עוד חצי שעה" => 30).
  Otherwise date (YYYY-MM-DD) and/or time (HH:MM). "מחר" = tomorrow's date. For "ביום שלישי" set weekday=2.
  Dates are written the ISRAELI way: DAY/MONTH[/YEAR]. "5/1" = 5 January, "1/12" = 1 December, "20.12.26" = 20 December 2026.
  Hebrew month names: ינואר=1 פברואר=2 מרץ=3 אפריל=4 מאי=5 יוני=6 יולי=7 אוגוסט=8 ספטמבר=9 אוקטובר=10 נובמבר=11 דצמבר=12 ("ב-3 בדצמבר" = 3 December).
  If no year was written, use the NEXT occurrence of that date: if it already passed this year, use next year. Set year_given=true only when the user wrote the year.
  Hebrew hours: "ב-8 בערב" = 20:00, "ב-3 אחה\\"צ" = 15:00, "בשמונה וחצי" = 08:30 or 20:30 by context. If an hour 1-11 has no בבוקר/בערב and that time today already passed, prefer the PM time if it is still ahead today.
  If no time was given, choose a sensible one, set guessed_time=true and explain in reason (Hebrew).
  recurrence: daily ("כל יום", "כל בוקר"), weekly ("כל שבוע", "כל יום שני"), yearly (birthdays/anniversaries every year), else once.
  complex_date=true only when the date depends on the Hebrew calendar or holidays ("ערב פסח", "אחרי סוכות") — then leave date empty.
  weather: only if the reminder is conditional on weather ("אם יורד גשם" => rain).
  confirm_needed=true if the user asks to be chased until confirming ("תרדוף אחריי", "תציק לי עד שאאשר").
- reschedule_reminder: move an existing reminder to another time ("תשנה את התזכורת למחר ב-10", "תדחה את זה לשעה 5"). Set reminder_id from the list (or the one just discussed) and the new time fields.
- delete_reminder: cancel/delete an existing REMINDER ("תמחק את התזכורת של הכדור", "תבטל אותה" right after discussing a reminder). Cancelling a real-world plan ("אני צריך לבטל את הפגישה") is NOT this — that is chat.
- list_reminders: wants to see their reminders.
- mark_done: reports finishing a task that matches one of the active reminders ("לקחתי את הכדור", "סיימתי עם הכביסה"). reminder_id required. If it matches a habit instead, use log_habit.
- add_habit: start tracking a habit ("הוסף הרגל ריצה", "אני רוצה לעקוב אחרי שתיית מים"). text = habit title.
- log_habit: reports doing a tracked habit ("רצתי היום", "עשיתי ריצה"). habit_id from the list.
- list_habits: wants to see habit stats/graph.
- add_note: save an idea for later without a time ("רעיון: ...", "תרשום לי שבא לי ללמוד גיטרה מתישהו"). text = the idea.
- list_notes: wants to see saved ideas/notes.
- countdown: wants a countdown to an event ("ספירה לאחור לטיסה ב-20/12 ב-10:00"). text = event title + date/time fields.
- status: asks about their points/streak/badges.
- set_name: asks to be called by another name. name = the name.
- set_gender: asks to be addressed as male/female.
- set_personality: asks the bot to BE another persona (coach=מאמן, cynic=ציני, friend=חבר, sergeant=רס"ר, therapist=מטפל, hype=מעודד, grandma=סבתא, philosopher=פילוסוף, frayer=פראייר, neighbor=שכן). permanent=true for "מעכשיו"/"תמיד".
- set_tone: asks the bot to be more serious / softer / funnier.
- chat: anything else (conversation, venting, questions, jokes, stories, telling about plans without asking for a reminder).

Output rules:
- Fill EVERY field; use null when it does not apply.
- For create_reminder / reschedule_reminder / countdown ALWAYS fill the time: in_minutes, or date and/or time, or weekday.
- "כל יום"/"כל בוקר"/"כל ערב" => recurrence "daily". "כל יום שלישי"/"כל שבוע" => "weekly" (+ weekday).
Be conservative: when unsure, use chat. confidence is 0..1.`;
}

function validDateStr(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
}

function parseHHMM(s: unknown): { h: number; m: number } | null {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], min = +m[2];
  return h <= 23 && min <= 59 ? { h, m: min } : null;
}

/**
 * Deterministic safety net for numeric dates in the user's own text (Israeli DAY/MONTH order).
 * Returns "YYYY-MM-DD" (next occurrence when no year is written) or null if there is no single clear date.
 * `allowDots`: "8.12" may also be a time, so dotted dates are only trusted when the model saw a date too.
 */
export function explicitNumericDate(text: string, now: Date, allowDots = false): { date: string; yearGiven: boolean } | null {
  const re = allowDots
    ? /(?<![\d:])(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?(?![\d:])/g
    : /(?<![\d:])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d:])/g;
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) return null; // none, or ambiguous (two dates)
  const [, d, m, y] = matches[0];
  const day = +d, month = +m;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const today = israelParts(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  const valid = (yy: number) => {
    const dt = new Date(Date.UTC(yy, month - 1, day));
    return dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day; // rejects 31/4, 30/2...
  };
  if (y) {
    const year = y.length === 2 ? 2000 + +y : +y;
    return valid(year) ? { date: `${year}-${pad(month)}-${pad(day)}`, yearGiven: true } : null;
  }
  let year = today.year;
  const todayKey = today.month * 100 + today.day;
  if (month * 100 + day < todayKey) year += 1; // already passed this year -> next year
  if (!valid(year)) return null;
  return { date: `${year}-${pad(month)}-${pad(day)}`, yearGiven: false };
}

/** Moves a date-only result to next year when the year wasn't written and the date already passed. */
function rollYearIfPassed(raw: any, now: Date): any {
  if (!validDateStr(raw?.date) || raw?.year_given === true) return raw;
  const today = israelParts(now).date;
  if (raw.date >= today) return raw;
  const next = `${+raw.date.slice(0, 4) + 1}${raw.date.slice(4)}`;
  return validDateStr(next) && next >= today ? { ...raw, date: next } : raw;
}

/** Converts the model's local time parts to an absolute Date in Israel time. Never returns a past time. */
export function resolveWhen(raw: any, now: Date, recurrence: RecurrenceType = "once"): Date | null {
  const minutes = Number(raw?.in_minutes);
  if (Number.isFinite(minutes) && minutes > 0 && minutes <= 60 * 24 * 400) {
    return new Date(now.getTime() + Math.round(minutes) * 60_000);
  }
  const hm = parseHHMM(raw?.time);
  let due: Date | null = null;

  if (validDateStr(raw?.date)) {
    const t = hm ?? { h: 9, m: 0 };
    due = israelTime(t.h, t.m, new Date(`${raw.date}T12:00:00Z`));
  } else if (Number.isInteger(raw?.weekday) && raw.weekday >= 0 && raw.weekday <= 6) {
    const t = hm ?? { h: 9, m: 0 };
    const today = israelParts(now).weekday;
    let add = (raw.weekday - today + 7) % 7;
    let candidate = israelTime(t.h, t.m, now, add);
    if (candidate.getTime() <= now.getTime()) {
      add += 7;
      candidate = israelTime(t.h, t.m, now, add);
    }
    due = candidate;
  } else if (hm) {
    due = israelTime(hm.h, hm.m, now);
    if (due.getTime() <= now.getTime()) due = israelTime(hm.h, hm.m, now, 1);
  }

  if (!due) return null;
  if (due.getTime() <= now.getTime()) {
    if (recurrence === "once") return null; // a past one-off time is a misunderstanding; ask instead
    due = advanceRecurring(due, recurrence);
  }
  return due;
}

function str(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** Validates and normalizes the raw router JSON. Pure — unit tested. */
export function normalizeIntent(raw: any, ctx: IntentContext, userText = ""): Action | null {
  if (!raw || typeof raw !== "object" || !INTENTS.includes(raw.intent)) return null;
  if (["create_reminder", "reschedule_reminder", "countdown"].includes(raw.intent) && raw.complex_date !== true) {
    // Trust the user's own DD/MM over the model's reading, then roll year-less past dates forward.
    const explicit = explicitNumericDate(userText, ctx.now, validDateStr(raw.date));
    if (explicit) raw = { ...raw, date: explicit.date, year_given: explicit.yearGiven, in_minutes: null, weekday: null };
    raw = rollYearIfPassed(raw, ctx.now);
  }
  const confidence = Number(raw.confidence ?? 0);
  if (raw.intent === "chat" || !(confidence >= 0.55)) return { kind: "chat" };

  const reminderIds = new Set(ctx.reminders.map((r) => String(r.id)));
  const reminderId = raw.reminder_id && reminderIds.has(String(raw.reminder_id)) ? String(raw.reminder_id) : null;
  const habitIds = new Set(ctx.habits.map((h) => String(h.id)));
  const habitId = raw.habit_id && habitIds.has(String(raw.habit_id)) ? String(raw.habit_id) : null;

  switch (raw.intent) {
    case "create_reminder": {
      const task = str(raw.task);
      if (!task) return null;
      const recurrence: RecurrenceType = ["daily", "weekly", "yearly"].includes(raw.recurrence) ? raw.recurrence : "once";
      const complexDate = raw.complex_date === true;
      return {
        kind: "create_reminder",
        task,
        dueAt: complexDate ? null : resolveWhen(raw, ctx.now, recurrence),
        recurrence,
        weather: ["rain", "clear", "hot", "cold"].includes(raw.weather) ? raw.weather : null,
        confirmNeeded: raw.confirm_needed === true,
        guessed: raw.guessed_time === true,
        reason: str(raw.reason, 160),
        complexDate,
      };
    }
    case "reschedule_reminder": {
      const target = ctx.reminders.find((r) => String(r.id) === reminderId);
      const recurrence = (target?.type ?? "once") as RecurrenceType;
      const complexDate = raw.complex_date === true;
      return { kind: "reschedule_reminder", reminderId, dueAt: complexDate ? null : resolveWhen(raw, ctx.now, recurrence), complexDate };
    }
    case "delete_reminder":
      return { kind: "delete_reminder", reminderId };
    case "list_reminders":
      return { kind: "list_reminders" };
    case "mark_done":
      return reminderId ? { kind: "mark_done", reminderId } : { kind: "chat" };
    case "add_habit": {
      const title = str(raw.text ?? raw.task, 80);
      return title ? { kind: "add_habit", title } : null;
    }
    case "log_habit":
      return { kind: "log_habit", habitId, title: str(raw.text ?? raw.task, 80) };
    case "list_habits":
      return { kind: "list_habits" };
    case "add_note": {
      const text = str(raw.text ?? raw.task, 500);
      return text ? { kind: "add_note", text } : null;
    }
    case "list_notes":
      return { kind: "list_notes" };
    case "countdown": {
      const title = str(raw.text ?? raw.task, 80);
      return title ? { kind: "countdown", title, targetAt: resolveWhen(raw, ctx.now) } : null;
    }
    case "status":
      return { kind: "status" };
    case "set_name": {
      const name = str(raw.name, 40);
      return name ? { kind: "set_name", name } : null;
    }
    case "set_gender":
      return raw.gender === "male" || raw.gender === "female" ? { kind: "set_gender", gender: raw.gender } : null;
    case "set_personality":
      return PERSONALITY_KEYS.includes(raw.personality)
        ? { kind: "set_personality", personality: raw.personality, permanent: raw.permanent === true }
        : null;
    case "set_tone":
      return ["serious", "softer", "funnier"].includes(raw.tone) ? { kind: "set_tone", tone: raw.tone } : null;
  }
  return null;
}

export type ModelCaller = (payload: Record<string, unknown>) => Promise<{ ok: boolean; data?: any }>;

/** Runs the router. Returns null on any failure so the caller can fall back to the regex pipeline. */
export async function routeMessage(text: string, ctx: IntentContext, callModel: ModelCaller): Promise<Action | null> {
  if (!text.trim()) return null;
  try {
    const res = await callModel({
      systemInstruction: { parts: [{ text: buildRouterPrompt(ctx) }] },
      contents: [{ role: "user", parts: [{ text: text.slice(0, 1500) }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 1000,
        responseMimeType: "application/json",
        responseSchema: ROUTER_SCHEMA,
        thinkingConfig: { thinkingLevel: "minimal" },
      },
    });
    if (!res.ok) return null;
    const raw = (res.data?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
    const json = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim());
    return normalizeIntent(json, ctx, text);
  } catch (error) {
    console.error("[intent] routing failed:", error);
    return null;
  }
}
