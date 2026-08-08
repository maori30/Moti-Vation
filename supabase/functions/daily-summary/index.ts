import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";
const TZ = Deno.env.get("BOT_TIMEZONE") ?? "Asia/Jerusalem";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function israelDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

async function sendTelegramMessage(chatId: number, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    return res.ok;
  } catch (err) {
    console.error(`[daily-summary] telegram send failed for ${chatId}:`, err);
    return false;
  }
}

async function buildSummaryForUser(chatId: number): Promise<string> {
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [{ count: allTimeCount }, { count: last24Count }, { data: user }, { data: completions }] = await Promise.all([
    supabase.from("reminder_completions").select("id", { count: "exact", head: true }).eq("chat_id", chatId),
    supabase.from("reminder_completions").select("id", { count: "exact", head: true }).eq("chat_id", chatId).gte("completed_at", since24h),
    supabase.from("users").select("goals_achieved, current_streak").eq("chat_id", chatId).single(),
    supabase.from("reminder_completions").select("reminder_text").eq("chat_id", chatId).order("completed_at", { ascending: false }).limit(200),
  ]);
  const freq = new Map<string, number>();
  for (const c of completions ?? []) if (c.reminder_text) freq.set(c.reminder_text, (freq.get(c.reminder_text) ?? 0) + 1);
  const topRecurring = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const lines = ["📢 <b>הודעת מערכת מוטי-בציה | סיכום של בוקר</b> ☀️", "──────────────", "", "📊 <b>הסטטיסטיקה שלך</b>", `מטרות שהושגו: ${user?.goals_achieved ?? 0}`, `השלמות (24 שעות): ${last24Count ?? 0}`, `השלמות (סה״כ): ${allTimeCount ?? 0}`, `רצף ימים פעילים: ${user?.current_streak ?? 0} 🔥`, ""];
  if (topRecurring.length) { lines.push("🏆 <b>הכי הרבה השלמת</b>"); for (const [text, count] of topRecurring) lines.push(`• ${text} — הושלמה ${count} פעמים`); lines.push(""); }
  lines.push("──────────────", "תמשיך ככה, כל השלמה היא עוד צעד קדימה 💪");
  return lines.join("\n");
}

async function updateStreaks() {
  const { data: users } = await supabase.from("users").select("chat_id, current_streak, last_active_date");
  if (!users) return;
  const today = israelDate();
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  for (const u of users) {
    if (u.last_active_date === today) continue;
    const { count } = await supabase.from("reminder_completions").select("id", { count: "exact", head: true }).eq("chat_id", u.chat_id).gte("completed_at", since24h);
    const newStreak = (count ?? 0) > 0 ? (u.current_streak ?? 0) + 1 : 0;
    await supabase.from("users").update({ current_streak: newStreak, last_active_date: today }).eq("chat_id", u.chat_id);
  }
}

Deno.serve(async (_req: Request) => {
  try {
    const today = israelDate();
    await updateStreaks();
    const { data: users, error } = await supabase.from("users").select("chat_id, last_summary_date");
    if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 200 });
    let sent = 0;
    for (const u of users ?? []) {
      if (u.last_summary_date === today) continue;
      const summary = await buildSummaryForUser(u.chat_id);
      if (await sendTelegramMessage(u.chat_id, summary)) { await supabase.from("users").update({ last_summary_date: today }).eq("chat_id", u.chat_id); sent++; }
    }
    return new Response(JSON.stringify({ ok: true, sent }), { status: 200 });
  } catch (err) { console.error("[daily-summary] fatal:", err); return new Response(JSON.stringify({ ok: false }), { status: 200 }); }
});
