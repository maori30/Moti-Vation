import assert from "node:assert/strict";
import { filterFreshEvents } from "../telegram/awareness.ts";

const NOW = new Date("2026-11-12T12:00:00Z");

Deno.test("filterFreshEvents drops stale undated and past events", () => {
  const events = [
    { title: "להכין מחשב ודו\"צ", when_at: null, created_at: "2026-09-23T17:34:00Z", updated_at: "2026-09-23T17:34:00Z" }, // stale, undated
    { title: "אספת הורים", when_at: "2026-10-08T11:00:00Z", created_at: "2026-10-04T15:57:00Z" }, // past
    { title: "פגישה עם רואה חשבון", when_at: null, created_at: "2026-11-09T10:00:00Z", updated_at: "2026-11-09T10:00:00Z" }, // recent, undated
    { title: "תור לרופא", when_at: "2026-11-25T12:00:00Z", created_at: "2026-09-13T05:54:00Z" }, // future
  ];
  assert.deepEqual(filterFreshEvents(events, NOW).map((e) => e.title), ["פגישה עם רואה חשבון", "תור לרופא"]);
});
