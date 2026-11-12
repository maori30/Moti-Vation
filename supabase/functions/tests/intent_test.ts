import assert from "node:assert/strict";
import { normalizeIntent, resolveWhen, type IntentContext } from "../telegram/intent.ts";

const TZ = "Asia/Jerusalem";
const local = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d).replace(",", "");
const NOW = new Date("2026-11-12T08:00:00Z"); // Thu 10:00 Israel

const ctx: IntentContext = {
  now: NOW,
  reminders: [
    { id: "11111111-1111-1111-1111-111111111111", text: "לקחת כדור", type: "daily", time: "2026-11-13T04:30:00.000Z" },
    { id: "22222222-2222-2222-2222-222222222222", text: "להתקשר לאמא", type: "once", time: "2026-11-12T15:00:00.000Z" },
  ],
  habits: [{ id: 7, title: "ריצה" }],
  recent: [],
};

Deno.test("resolveWhen: in_minutes", () => {
  assert.equal(resolveWhen({ in_minutes: 20 }, NOW)!.getTime() - NOW.getTime(), 20 * 60_000);
});

Deno.test("resolveWhen: date + time in Israel", () => {
  assert.equal(local(resolveWhen({ date: "2026-11-13", time: "08:30" }, NOW)!), "2026-11-13 08:30");
});

Deno.test("resolveWhen: summer date gets the summer offset", () => {
  assert.equal(resolveWhen({ date: "2027-07-01", time: "09:00" }, NOW)!.toISOString(), "2027-07-01T06:00:00.000Z");
});

Deno.test("resolveWhen: time only -> today if ahead, else tomorrow", () => {
  assert.equal(local(resolveWhen({ time: "22:00" }, NOW)!), "2026-11-12 22:00");
  assert.equal(local(resolveWhen({ time: "07:00" }, NOW)!), "2026-11-13 07:00");
});

Deno.test("resolveWhen: weekday (Tuesday) -> next Tuesday", () => {
  assert.equal(local(resolveWhen({ weekday: 2, time: "10:00" }, NOW)!), "2026-11-17 10:00");
});

Deno.test("resolveWhen: same weekday later today stays today, earlier -> next week", () => {
  assert.equal(local(resolveWhen({ weekday: 4, time: "18:00" }, NOW)!), "2026-11-12 18:00");
  assert.equal(local(resolveWhen({ weekday: 4, time: "08:00" }, NOW)!), "2026-11-19 08:00");
});

Deno.test("resolveWhen: a past one-off time is rejected", () => {
  assert.equal(resolveWhen({ date: "2026-11-11", time: "09:00" }, NOW), null);
});

Deno.test("resolveWhen: nothing usable -> null", () => {
  assert.equal(resolveWhen({}, NOW), null);
  assert.equal(resolveWhen({ time: "25:99" }, NOW), null);
});

Deno.test("normalizeIntent: low confidence becomes chat", () => {
  assert.deepEqual(normalizeIntent({ intent: "create_reminder", confidence: 0.3, task: "x" }, ctx), { kind: "chat" });
});

Deno.test("normalizeIntent: unknown intent -> null (fallback to legacy)", () => {
  assert.equal(normalizeIntent({ intent: "hack", confidence: 1 }, ctx), null);
  assert.equal(normalizeIntent(null, ctx), null);
});

Deno.test("normalizeIntent: create_reminder daily", () => {
  const a = normalizeIntent({ intent: "create_reminder", confidence: 0.99, task: "לקחת ויטמין", recurrence: "daily", time: "22:00" }, ctx);
  assert.equal(a?.kind, "create_reminder");
  if (a?.kind !== "create_reminder") return;
  assert.equal(a.recurrence, "daily");
  assert.equal(local(a.dueAt!), "2026-11-12 22:00");
});

Deno.test("normalizeIntent: complex dates skip resolution", () => {
  const a = normalizeIntent({ intent: "create_reminder", confidence: 0.9, task: "לנקות", complex_date: true, time: "09:00" }, ctx);
  assert.equal(a?.kind === "create_reminder" && a.dueAt, null);
  assert.equal(a?.kind === "create_reminder" && a.complexDate, true);
});

Deno.test("normalizeIntent: reminder ids must belong to the user", () => {
  const ok = normalizeIntent({ intent: "delete_reminder", confidence: 0.9, reminder_id: "22222222-2222-2222-2222-222222222222" }, ctx);
  assert.deepEqual(ok, { kind: "delete_reminder", reminderId: "22222222-2222-2222-2222-222222222222" });
  const foreign = normalizeIntent({ intent: "delete_reminder", confidence: 0.9, reminder_id: "99999999-9999-9999-9999-999999999999" }, ctx);
  assert.deepEqual(foreign, { kind: "delete_reminder", reminderId: null });
});

Deno.test("normalizeIntent: mark_done without a valid id falls back to chat", () => {
  assert.deepEqual(normalizeIntent({ intent: "mark_done", confidence: 0.9, reminder_id: "nope" }, ctx), { kind: "chat" });
});

Deno.test("normalizeIntent: habit ids validated", () => {
  assert.deepEqual(normalizeIntent({ intent: "log_habit", confidence: 0.9, habit_id: "7" }, ctx), { kind: "log_habit", habitId: "7", title: null });
  assert.deepEqual(normalizeIntent({ intent: "log_habit", confidence: 0.9, habit_id: "8", text: "שחייה" }, ctx), { kind: "log_habit", habitId: null, title: "שחייה" });
});

Deno.test("normalizeIntent: personality must be known", () => {
  assert.deepEqual(normalizeIntent({ intent: "set_personality", confidence: 0.9, personality: "grandma", permanent: true }, ctx), { kind: "set_personality", personality: "grandma", permanent: true });
  assert.equal(normalizeIntent({ intent: "set_personality", confidence: 0.9, personality: "pirate" }, ctx), null);
});

Deno.test("normalizeIntent: reschedule keeps the reminder's recurrence for past times", () => {
  const a = normalizeIntent({ intent: "reschedule_reminder", confidence: 0.95, reminder_id: "11111111-1111-1111-1111-111111111111", time: "06:30" }, ctx);
  assert.equal(a?.kind, "reschedule_reminder");
  if (a?.kind === "reschedule_reminder") assert.equal(local(a.dueAt!), "2026-11-13 06:30");
});

// ---------------------------------------------------------------- Israeli dates (DAY/MONTH)
import { explicitNumericDate } from "../telegram/intent.ts";

Deno.test("explicitNumericDate: DAY/MONTH order, next occurrence", () => {
  // NOW = 2026-11-12
  assert.deepEqual(explicitNumericDate("תזכיר לי ב-25/11 לשלם", NOW), { date: "2026-11-25", yearGiven: false });
  assert.deepEqual(explicitNumericDate("ב-5/1 תור לרופא", NOW), { date: "2027-01-05", yearGiven: false }); // 5 January, next year
  assert.deepEqual(explicitNumericDate("ב-1/12", NOW), { date: "2026-12-01", yearGiven: false }); // 1 December, not 12 January
  assert.deepEqual(explicitNumericDate("ב-15/3 יום הולדת", NOW), { date: "2027-03-15", yearGiven: false }); // passed -> next year
  assert.deepEqual(explicitNumericDate("היום 12/11", NOW), { date: "2026-11-12", yearGiven: false }); // today stays today
});

Deno.test("explicitNumericDate: explicit year", () => {
  assert.deepEqual(explicitNumericDate("ב-20/12/2027", NOW), { date: "2027-12-20", yearGiven: true });
  assert.deepEqual(explicitNumericDate("ב-20/12/27", NOW), { date: "2027-12-20", yearGiven: true });
  assert.deepEqual(explicitNumericDate("ב-20.12.26", NOW, true), { date: "2026-12-20", yearGiven: true });
});

Deno.test("explicitNumericDate: rejects invalid, ambiguous and time-like input", () => {
  assert.equal(explicitNumericDate("ב-31/4", NOW), null); // April has 30 days
  assert.equal(explicitNumericDate("ב-5/13", NOW), null); // no 13th month
  assert.equal(explicitNumericDate("בין 5/1 ל-7/1", NOW), null); // two dates -> let the model decide
  assert.equal(explicitNumericDate("בשעה 14:00", NOW), null);
  assert.equal(explicitNumericDate("ב-8.30", NOW), null); // dots are a time unless the model saw a date
});

Deno.test("normalizeIntent: user's DD/MM wins over a model that read MM/DD", () => {
  // User wrote 5/1 (5 January) but the model answered May 1st.
  const a = normalizeIntent({ intent: "create_reminder", confidence: 0.95, task: "תור", date: "2027-05-01", time: "10:00" }, ctx, "תזכיר לי ב-5/1 ב-10 תור");
  assert.equal(a?.kind, "create_reminder");
  if (a?.kind === "create_reminder") assert.equal(local(a.dueAt!), "2027-01-05 10:00");
});

Deno.test("normalizeIntent: year-less date that already passed rolls to next year", () => {
  // Model returned this year's 15 March (in the past) for "ב-15 במרץ"
  const a = normalizeIntent({ intent: "create_reminder", confidence: 0.95, task: "יום הולדת", date: "2026-03-15", time: "09:00", year_given: false }, ctx, "תזכיר לי ב-15 במרץ יום הולדת");
  if (a?.kind === "create_reminder") assert.equal(local(a.dueAt!), "2027-03-15 09:00");
  else assert.fail("expected create_reminder");
});

Deno.test("normalizeIntent: explicit past year is NOT moved (asks instead)", () => {
  const a = normalizeIntent({ intent: "create_reminder", confidence: 0.95, task: "x", date: "2026-03-15", time: "09:00", year_given: true }, ctx, "ב-15/3/2026");
  assert.equal(a?.kind === "create_reminder" && a.dueAt, null);
});

Deno.test("normalizeIntent: countdown with DD/MM", () => {
  const a = normalizeIntent({ intent: "countdown", confidence: 0.95, text: "טיסה", date: "2026-12-20", time: "06:30" }, ctx, "ספירה לאחור לטיסה ב-20/12 ב-06:30");
  if (a?.kind === "countdown") assert.equal(local(a.targetAt!), "2026-12-20 06:30");
  else assert.fail("expected countdown");
});
