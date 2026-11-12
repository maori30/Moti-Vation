/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Db } from "./db.ts";

export const TZ = Deno.env.get("BOT_TIMEZONE") ?? "Asia/Jerusalem";

// ---------------------------------------------------------------- background work
// Supabase Edge Functions may stop the isolate as soon as the response is returned.
// EdgeRuntime.waitUntil keeps it alive until the promise settles.
export function background(promise: PromiseLike<unknown>, label: string): void {
  const guarded = Promise.resolve(promise).catch((error) => console.error(`[background:${label}] failed:`, error));
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(guarded);
}

// ---------------------------------------------------------------- Telegram text
export function escapeHtml(text: string): string {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape user/AI text for parse_mode=HTML and turn **bold** into <b>bold</b>. */
export function toTelegramHtml(text: string): string {
  return escapeHtml(text).replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
}

function stripTags(html: string): string {
  return html.replace(/<\/?b>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * Calls a Telegram Bot API method that carries formatted text (sendMessage, editMessageText,
 * sendAnimation caption...). If Telegram rejects the HTML, retries once as plain text so the
 * user still gets the message.
 */
export async function telegramCall(token: string, method: string, body: Record<string, unknown>, textField = "text"): Promise<any | null> {
  const post = (payload: Record<string, unknown>) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  try {
    let response = await post(body);
    if (!response.ok) {
      const errText = await response.text();
      if (response.status === 400 && /parse entities|can't find end/i.test(errText) && typeof body[textField] === "string") {
        const plain = { ...body, [textField]: stripTags(body[textField] as string) };
        delete (plain as any).parse_mode;
        response = await post(plain);
        if (response.ok) return await response.json();
      }
      console.error(`[telegram] ${method} ${response.status}: ${errText.slice(0, 300)}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error(`[telegram] ${method} exception:`, error);
    return null;
  }
}

// ---------------------------------------------------------------- config & auth
const configCache = new Map<string, { value: string | null; at: number }>();

export async function getConfig(db: Db, key: string): Promise<string | null> {
  const cached = configCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
  const { data } = await db.from("bot_config").select("value").eq("key", key).maybeSingle();
  const value = (data?.value as string | undefined) ?? null;
  configCache.set(key, { value, at: Date.now() });
  return value;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Scheduled functions accept calls only from pg_cron, which sends x-cron-secret. */
export async function isCronAuthorized(req: Request, db: Db): Promise<boolean> {
  const provided = req.headers.get("x-cron-secret") ?? "";
  const expected = await getConfig(db, "cron_secret");
  return Boolean(expected && provided && safeEqual(provided, expected));
}

export async function headerMatchesConfig(req: Request, db: Db, header: string, key: string): Promise<boolean> {
  const provided = req.headers.get(header) ?? "";
  const expected = await getConfig(db, key);
  return Boolean(expected && provided && safeEqual(provided, expected));
}

/** Returns true exactly once per key (atomic insert into bot_config). */
export async function runOnce(db: Db, key: string): Promise<boolean> {
  const { error } = await db.from("bot_config").insert({ key: `job:${key}`, value: new Date().toISOString() });
  return !error;
}

// ---------------------------------------------------------------- Israel time
export function israelParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date).reduce((out, part) => { out[part.type] = part.value; return out; }, {} as Record<string, string>);
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: +parts.year, month: +parts.month, day: +parts.day,
    hour: +parts.hour, minute: +parts.minute, weekday: weekdays[parts.weekday] ?? 0,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export function tzOffsetMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).reduce((out, part) => { out[part.type] = part.value; return out; }, {} as Record<string, string>);
  return (Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - date.getTime()) / 60_000;
}

/** Wall-clock time in Israel -> Date. addDays/addMonths/addYears are applied to the Israeli calendar date. */
export function israelTime(hour: number, minute: number, base = new Date(), addDays = 0, addYears = 0): Date {
  const p = israelParts(base);
  const naive = Date.UTC(p.year + addYears, p.month - 1, p.day + addDays, hour, minute, 0);
  return new Date(naive - tzOffsetMinutes(new Date(naive)) * 60_000);
}

/** Same Israeli wall-clock time, N days (or years) later — DST safe. */
export function nextOccurrence(previous: Date, days: number, years = 0): Date {
  const p = israelParts(previous);
  const naive = Date.UTC(p.year + years, p.month - 1, p.day + days, p.hour, p.minute, 0);
  return new Date(naive - tzOffsetMinutes(new Date(naive)) * 60_000);
}

export function advanceRecurring(previous: Date, type: string): Date {
  const now = Date.now();
  let next = previous;
  // Catch up if the reminder was missed for a while (e.g. downtime), never schedule in the past.
  for (let i = 0; i < 400 && next.getTime() <= now; i++) {
    next = type === "yearly" ? nextOccurrence(next, 0, 1) : nextOccurrence(next, type === "weekly" ? 7 : 1);
  }
  return next;
}
