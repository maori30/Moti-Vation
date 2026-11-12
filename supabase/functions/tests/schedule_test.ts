import assert from "node:assert/strict";
import { israelTime, looksActionable, parseReminder, reminderScheduleLabel } from "../telegram/schedule.ts";

const TZ = "Asia/Jerusalem";
const local = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d).replace(",", "");

// Thursday 2026-11-12 10:00 Israel (UTC+2 in winter)
const NOW = new Date("2026-11-12T08:00:00Z");

Deno.test("israelTime builds wall-clock time in Israel (winter and summer)", () => {
  assert.equal(israelTime(9, 30, new Date("2026-11-12T12:00:00Z")).toISOString(), "2026-11-12T07:30:00.000Z");
  assert.equal(israelTime(9, 30, new Date("2026-07-01T12:00:00Z")).toISOString(), "2026-07-01T06:30:00.000Z");
});

Deno.test("parseReminder: relative minutes", () => {
  const r = parseReminder("תזכיר לי עוד 20 דקות להוציא כביסה", NOW)!;
  assert.equal(r.dueAt.getTime() - NOW.getTime(), 20 * 60_000);
  assert.equal(r.type, "once");
  assert.match(r.task, /להוציא כביסה/);
});

Deno.test("parseReminder: tomorrow at a time", () => {
  const r = parseReminder("תזכיר לי מחר ב-8 לקנות חלב", NOW)!;
  assert.equal(local(r.dueAt), "2026-11-13 08:00");
});

Deno.test("parseReminder: daily", () => {
  const r = parseReminder("תזכיר לי כל יום ב-22:00 לקחת ויטמין", NOW)!;
  assert.equal(r.type, "daily");
  assert.equal(local(r.dueAt), "2026-11-12 22:00");
});

Deno.test("parseReminder: 'ב-8' after 8am means 20:00 today", () => {
  const r = parseReminder("תזכיר לי ב-8 להתקשר", NOW)!;
  assert.equal(local(r.dueAt), "2026-11-12 20:00");
});

Deno.test("parseReminder: 'ב-9 בבוקר' already passed -> tomorrow", () => {
  const r = parseReminder("תזכיר לי ב-9 בבוקר לרוץ", NOW)!;
  assert.equal(local(r.dueAt), "2026-11-13 09:00");
});

Deno.test("parseReminder: weekday uses Israel calendar", () => {
  const r = parseReminder("תזכיר לי ביום שלישי ב-10 לשלם", NOW)!;
  assert.equal(local(r.dueAt), "2026-11-17 10:00");
});

Deno.test("parseReminder: 'היום' with a passed time is left to the AI scheduler", () => {
  assert.equal(parseReminder("תזכיר לי היום ב-9 בבוקר", NOW), null);
});

Deno.test("parseReminder: explicit dates are left to the AI scheduler", () => {
  assert.equal(parseReminder("תזכיר לי ב-25/11 לשלם", NOW), null);
});

Deno.test("reminderScheduleLabel", () => {
  assert.match(reminderScheduleLabel(new Date("2026-11-12T18:00:00Z"), "once", NOW), /^היום ב־20:00$/);
  assert.match(reminderScheduleLabel(new Date("2026-11-13T06:00:00Z"), "once", NOW), /^מחר ב־08:00$/);
  assert.match(reminderScheduleLabel(new Date("2026-11-13T06:00:00Z"), "daily", NOW), /^כל יום ב־08:00$/);
  assert.match(reminderScheduleLabel(new Date("2026-11-16T17:00:00Z"), "weekly", NOW), /^כל יום שני ב־19:00$/);
});

Deno.test("looksActionable: small talk skips the router", () => {
  assert.equal(looksActionable("מה קורה אחי"), false);
  assert.equal(looksActionable("חחחח אתה מצחיק"), false);
  assert.equal(looksActionable("תזכיר לי לקנות חלב"), true);
  assert.equal(looksActionable("רצתי הבוקר"), true);
  assert.equal(looksActionable("לקחתי את הכדור"), true);
  assert.equal(looksActionable("תמחק אותה"), true);
  assert.equal(looksActionable("8", "מתי להזכיר לך?"), true);
  assert.equal(looksActionable("תהיה יותר מצחיק"), true);
});
