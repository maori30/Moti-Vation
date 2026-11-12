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
