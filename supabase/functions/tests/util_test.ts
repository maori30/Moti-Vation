import assert from "node:assert/strict";
import { advanceRecurring, escapeHtml, israelParts, nextOccurrence, toTelegramHtml } from "../_shared/util.ts";

Deno.test("escapeHtml / toTelegramHtml", () => {
  assert.equal(escapeHtml("אוהב <3 & שלום"), "אוהב &lt;3 &amp; שלום");
  assert.equal(toTelegramHtml("**חשוב** <מאוד>"), "<b>חשוב</b> &lt;מאוד&gt;");
});

Deno.test("israelParts", () => {
  const p = israelParts(new Date("2026-11-12T22:30:00Z")); // 00:30 on Friday in Israel
  assert.equal(p.date, "2026-11-13");
  assert.equal(p.weekday, 5);
  assert.equal(p.hour, 0);
});

Deno.test("nextOccurrence keeps the wall-clock time across DST", () => {
  // 06:30 Israel on 2026-10-24 (summer, UTC+3) -> next day after DST ends is still 06:30 (UTC+2)
  const before = new Date("2026-10-24T03:30:00Z");
  const after = nextOccurrence(before, 1);
  assert.equal(after.toISOString(), "2026-10-25T04:30:00.000Z");
});

Deno.test("advanceRecurring catches up missed occurrences and never returns the past", () => {
  const old = new Date(Date.now() - 10 * 86_400_000);
  const next = advanceRecurring(old, "daily");
  assert.ok(next.getTime() > Date.now());
  assert.ok(next.getTime() - Date.now() <= 86_400_000 + 3_600_000);
  const yearly = advanceRecurring(new Date(Date.now() - 400 * 86_400_000), "yearly");
  assert.ok(yearly.getTime() > Date.now());
});
