/* Pure date/time helpers for reminders (Israel time). No I/O — unit tested. */
import { TZ, israelParts } from "../_shared/util.ts";

export type ParsedReminder = { dueAt: Date; task: string; type: "once" | "daily" | "weekly" };
export type ActiveReminder = { id: string; text: string; type: string; time: string };

export const STRONGREMINDERTRIGGER = /תזכיר\s*לי|תזכירי\s*לי|אל תשכח(?:\s*לי)?|אל תשכחי(?:\s*לי)?|תדע\s*להזכיר|תדעי\s*להזכיר|צריך תזכורת|צריכה תזכורת|רוצה תזכורת|אשמח לתזכורת|תתזכר(?:\s*אותי)?|תתזכרי(?:\s*אותי)?|תזכר(?:\s*אותי)?|לתזכר|להזכיר/;
export const REMINDERTRIGGER = /תזכיר\s*לי|תזכירי\s*לי|תזכורת|אל תשכח(?:\s*לי)?|אל תשכחי(?:\s*לי)?|תדע\s*להזכיר|תזכיר|תזכירי|תתזכר|תתזכרי|תזכר|לתזכר|להזכיר|כל\s*(?:יום|בוקר|ערב|לילה|שבוע|שני|שלישי|רביעי|חמישי|שישי|שבת)/;
export const TIMEORANCHORSIGNAL = /(עוד\s*(?:כ\-?)?\d*\s*(דקות|דקה|שעות|שעה|ימים|יום)|מחר|מחרתיים|ביום\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|בשעה\s*\d|ב\s*-?\s*\d{1,2}[:.]\d{2}|כל\s*(?:יום|בוקר|ערב|לילה|שבוע|שני|שלישי|רביעי|חמישי|שישי|שבת)|לפני שאני|כשאני מגיע|כשאני חוזר|כשאני יוצא|לפני השינה|כשאני קם)/i;
export const WEEKDAYS: Record<string, number> = { ראשון: 0, שני: 1, שלישי: 2, רביעי: 3, חמישי: 4, שישי: 5, שבת: 6 };

export function detectReminderIntent(text: string): boolean {
  const lower = text.toLowerCase();
  return STRONGREMINDERTRIGGER.test(lower) || (REMINDERTRIGGER.test(lower) && TIMEORANCHORSIGNAL.test(lower));
}



export function israelDateParts(base: Date) {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  return formatter.formatToParts(base).reduce((out, part) => { out[part.type] = part.value; return out; }, {} as Record<string, string>);
}

export function timezoneOffset(date: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const parts = formatter.formatToParts(date).reduce((out, part) => { out[part.type] = part.value; return out; }, {} as Record<string, string>);
  return (Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - date.getTime()) / 60_000;
}

export function israelTime(hour: number, minute: number, base = new Date(), addDays = 0): Date {
  const date = israelDateParts(base);
  const naive = Date.UTC(+date.year, +date.month - 1, +date.day + addDays, hour, minute, 0);
  return new Date(naive - timezoneOffset(new Date(naive)) * 60_000);
}

export function reminderScheduleLabel(dueAt: Date, type: string, now = new Date()): string {
  const time = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(dueAt);
  if (type === "daily") return `כל יום ב־${time}`;
  if (type === "weekly") {
    const day = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, weekday: "long" }).format(dueAt);
    return `כל ${day} ב־${time}`;
  }
  if (type === "yearly") {
    const date = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, day: "numeric", month: "numeric" }).format(dueAt);
    return `כל שנה ב־${date} ב־${time}`;
  }
  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const dueDay = dayKey.format(dueAt);
  if (dueDay === dayKey.format(now)) return `היום ב־${time}`;
  if (dueDay === dayKey.format(new Date(now.getTime() + 86_400_000))) return `מחר ב־${time}`;
  const date = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, day: "numeric", month: "numeric" }).format(dueAt);
  return `ב־${date} ב־${time}`;
}

export function reminderLabel(r: ActiveReminder): string {
  const time = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(r.time));
  if (r.type === "daily" || r.type === "weekly" || r.type === "yearly") return reminderScheduleLabel(new Date(r.time), r.type);
  const date = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, day: "numeric", month: "numeric" }).format(new Date(r.time));
  return `ב־${date} ב־${time}`;
}


export function extractHour(timeMatch: RegExpMatchArray): number {
  let hour = +timeMatch[1];
  const ampm = timeMatch[3];
  if (ampm && /(בערב|בלילה|אחה|אחר הצה|צהריים)/.test(ampm) && hour < 12) {
    hour += 12;
  }
  return hour;
}

export function parseReminder(text: string, now = new Date()): ParsedReminder | null {
  const input = text.trim();
  if (/\b\d{1,2}[\/.]\d{1,2}\b/.test(input)) {
    return null; // Explicit dates should be handled by Gemini smart scheduling
  }
  let type: ParsedReminder["type"] = "once";
  let dueAt: Date | null = null;
  let span = "";

  const daily = input.match(/כל\s*(?:יום|בוקר|ערב|לילה)\s*(?:ב\s*-?\s*|בשעה\s*)?(\d{1,2})(?::(\d{2})|\s*וחצי|\s*ורבע)?\s*(בערב|בלילה|אחהצ|אחר הצהריים|בצהריים|בבוקר|לפנות בוקר)?/);
  if (daily) {
    const hour = extractHour(daily);
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
      const time = input.match(/(?:ב\s*-?\s*|בשעה\s*)(\d{1,2})(?::(\d{2}))?\s*(בערב|בלילה|אחהצ|אחר הצהריים|בצהריים|בבוקר|לפנות בוקר)?/);
      const hour = time ? extractHour(time) : 9;
      const minute = time?.[2] ? +time[2] : 0;
      dueAt = israelTime(hour, minute, now, add);
      if (add === 0 && dueAt <= now) {
        // "היום ב-8" at 10:00 most likely means 20:00. Otherwise let the AI scheduler decide.
        const pm = time && !time[3] && hour < 12 ? israelTime(hour + 12, minute, now) : null;
        if (!pm || pm <= now) return null;
        dueAt = pm;
      }
      span = day[0] + (time ? time[0] : "");
    }
  }

  if (!dueAt) {
    const weekday = input.match(/ביום\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/);
    if (weekday) {
      const target = WEEKDAYS[weekday[1]];
      let add = (target - israelParts(now).weekday + 7) % 7;
      if (!add) add = 7;
      const time = input.match(/(?:ב\s*-?\s*|בשעה\s*)(\d{1,2})(?::(\d{2}))?\s*(בערב|בלילה|אחהצ|אחר הצהריים|בצהריים|בבוקר|לפנות בוקר)?/);
      const hour = time ? extractHour(time) : 9;
      dueAt = israelTime(hour, time?.[2] ? +time[2] : 0, now, add);
      span = weekday[0] + (time ? time[0] : "");
    }
  }

  if (!dueAt) {
    const time = input.match(/(?:ב\s*-?\s*|בשעה\s*)(\d{1,2})(?::(\d{2}))?\s*(בערב|בלילה|אחהצ|אחר הצהריים|בצהריים|בבוקר|לפנות בוקר)?/);
    if (time) {
      const hour = extractHour(time);
      const minute = time[2] ? +time[2] : 0;
      dueAt = israelTime(hour, minute, now);
      if (dueAt <= now) {
        // "ב-8" said at 10:00 → 20:00 today (when no בבוקר/בערב was given), else tomorrow.
        const pm = !time[3] && hour < 12 ? israelTime(hour + 12, minute, now) : null;
        dueAt = pm && pm > now ? pm : israelTime(hour, minute, now, 1);
      }
      span = time[0];
    }
  }

  if (!dueAt || !span) return null;
  const task = input.replace(REMINDERTRIGGER, "").replace(span, "").replace(/^[\s,־-]+|[\s,־-]+$/g, "").trim() || "תזכורת";
  return { dueAt, task, type };
}

/** Cheap pre-filter: does this message possibly ask for an action (reminder, habit, settings...)?
 *  Pure small talk skips the AI router entirely, so it costs no extra latency. */
export const ACTION_HINT = /\d|תזכ|הזכר|תזכור|אל תשכח|תעיר|מחר|מחרתיים|היום|הערב|בבוקר|בערב|בצהריים|בלילה|עוד\s|בעוד|בשעה|כל\s|שבוע|חודש|ביום\s|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|תמחק|תבטל|מחק|בטל|תסיר|תשנה|תזיז|תדחה|תעביר|הרגל|רעיון|פתק|מתישהו|ספירה|נקודות|סטטוס|הישגים|רצף|תהיה|תהיי|תדבר|תקרא לי|תפנה|לשון|יותר (?:רציני|עדין|מצחיק|ציני|בעדינות)|בלי בדיחות|תפסיק|\S{2,}תי(?:\s|$|[.!,])|סיימתי|גמרתי|בוצע|סגרתי|שוב|עוד פעם|אותו דבר/u;

export function looksActionable(text: string, lastBotMessage = ""): boolean {
  if (ACTION_HINT.test(text)) return true;
  // Short answer right after the bot asked a question ("מתי?", "איזו?").
  return text.trim().length <= 40 && /\?\s*$/.test(lastBotMessage.trim());
}
