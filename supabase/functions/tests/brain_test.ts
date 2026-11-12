import assert from "node:assert/strict";
import { detectSwitchRequest, humorPolicy } from "../telegram/brain.ts";

Deno.test("personality switch only on explicit requests", () => {
  assert.equal(detectSwitchRequest("תדבר עם החבר שלי"), null);
  assert.equal(detectSwitchRequest("יש לי חבר שמדבר הרבה"), null);
  assert.deepEqual(detectSwitchRequest("מעכשיו תהיה מאמן"), { type: "personality", key: "coach", scope: "permanent" });
  assert.deepEqual(detectSwitchRequest('תעבור לרס"ר'), { type: "personality", key: "sergeant", scope: "session" });
  assert.deepEqual(detectSwitchRequest("תהיה רציני"), { type: "tone", tone: "serious" });
});

Deno.test("heavy topics zero the humor, but 'מתי' does not", () => {
  const base = { mode: "casual", tone: "neutral", intensity: 0, mood: "calm" as const, userHumorLevel: 0.5 };
  assert.equal(humorPolicy({ ...base, text: "סבא שלי מת אתמול" }).level, 0);
  assert.notEqual(humorPolicy({ ...base, text: "מתי אתה מגיע?" }).level, 0);
  assert.notEqual(humorPolicy({ ...base, text: "זאת האמת" }).level, 0);
});
