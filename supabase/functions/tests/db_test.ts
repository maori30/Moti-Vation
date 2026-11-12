import assert from "node:assert/strict";
import { createDb } from "../_shared/db.ts";

const db = createDb();

Deno.test("select with filters, order and limit", () => {
  const q = db.from("reminders").select("id, text, time").eq("chat_id", 5).eq("active", true).lte("time", "2026-11-12T08:00:00.000Z").order("time").limit(50).toSQL();
  assert.equal(q.text, 'SELECT "id", "text", "time" FROM "reminders" WHERE "chat_id" = $1 AND "active" = $2 AND "time" <= $3 ORDER BY "time" ASC LIMIT 50');
  assert.deepEqual(q.params, ["5", true, "2026-11-12T08:00:00.000Z"]);
});

Deno.test("count head query", () => {
  const q = db.from("reminder_completions").select("id", { count: "exact", head: true }).eq("chat_id", 1).toSQL();
  assert.equal(q.text, 'SELECT count(*)::int AS count FROM "reminder_completions" WHERE "chat_id" = $1');
});

Deno.test("insert returning, arrays and json are serialized", () => {
  const q = db.from("users").insert({ chat_id: 1, badges: ["א", 'ב"ג'], blend: { a: 1 } }).select().toSQL();
  assert.equal(q.text, 'INSERT INTO "users" ("chat_id", "badges", "blend") VALUES ($1, $2, $3) RETURNING *');
  assert.deepEqual(q.params, ["1", '{"א","ב\\"ג"}', '{"a":1}']);
});

Deno.test("upsert builds ON CONFLICT DO UPDATE", () => {
  const q = db.from("habit_logs").upsert({ habit_id: 1, chat_id: 2, date_logged: "2026-11-12" }, { onConflict: "habit_id, date_logged" }).toSQL();
  assert.equal(q.text, 'INSERT INTO "habit_logs" ("habit_id", "chat_id", "date_logged") VALUES ($1, $2, $3) ON CONFLICT ("habit_id", "date_logged") DO UPDATE SET "chat_id" = EXCLUDED."chat_id"');
});

Deno.test("update / delete / is / not / in", () => {
  const upd = db.from("reminders").update({ active: false }).eq("id", "x").toSQL();
  assert.equal(upd.text, 'UPDATE "reminders" SET "active" = $2 WHERE "id" = $1');
  assert.deepEqual(upd.params, ["x", false]); // placeholders map to the right values
  assert.equal(db.from("user_memories").delete().eq("chat_id", 1).not("expires_at", "is", null).toSQL().text, 'DELETE FROM "user_memories" WHERE "chat_id" = $1 AND "expires_at" IS NOT NULL');
  assert.equal(db.from("follow_ups").select("id").is("sent_at", null).toSQL().text, 'SELECT "id" FROM "follow_ups" WHERE "sent_at" IS NULL');
  assert.equal(db.from("users").select("chat_id").in("chat_id", []).toSQL().text, 'SELECT "chat_id" FROM "users" WHERE FALSE');
});

Deno.test("identifiers are validated (no SQL injection through column names)", () => {
  assert.throws(() => db.from("users").select('chat_id; DROP TABLE users').toSQL());
  assert.throws(() => db.from('users"; --').select("*").toSQL());
});
