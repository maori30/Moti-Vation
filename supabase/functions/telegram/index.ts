import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function sendTelegramMessage(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

// Builds a per-user morning digest: how many reminders they completed
// (all-time + last 24h), their most frequently-completed reminders
// (the "motivating recurring reminders" section from the reference image),
// and their current streak. Runs once daily via pg_cron.
async function buildSummaryForUser(chatId: number): Promise<string> {
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const { data: allTime } = await supabase
    .from("reminder_completions")
    .select("id", { count: "exact", head: true })
    .eq("chat_id", chatId);

  const { data: last24 } = await supabase
    .from("reminder_completions")
    .select("id", { count: "exact", head: true })
    .eq("chat_id", chatId)
    .gte("completed_at", since24h);

  const { data: user } = await supabase
    .from("users")
    .select("goals_achieved, current_streak")
    .eq("chat_id", chatId)
    .single();

  // Most-repeated completed reminders (top 3), grouped by text — this
  // mirrors the "המוטיבציות החוזרות שלך" section in the reference image.
  const { data: completions } = await supabase
    .from("reminder_completions")
    .select("reminder_text")
    .eq("chat_id", chatId)
    .order("completed_at", { ascending: false })
    .limit(200);

  const freq = new Map<string, number>();
  for (const c of completions ?? []) {
    if (!c.reminder_text) continue;
    freq.set(c.reminder_text, (freq.get(c.reminder_text) ?? 0) + 1);
  }
  const topRecurring = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const allTimeCount = (allTime as unknown as { length: number })?.length ?? 0;
  const last24Count = (last24 as unknown as { length: number })?.length ?? 0;

  const lines: string[] = [];
  lines.push("📢 <b>הודעת מערכת בוטיבציה | סיכום של בוקר</b> ☀️");
  lines.push("──────────────");
  lines.push("");
  lines.push("📊 <b>הסטטיסטיקה שלך</b>");
  lines.push(`מטרות שהושגו: ${user?.goals_achieved ?? 0}`);
  lines.push(`תזכורות שהתקבלו (24 שעות): ${last24Count}`);
  lines.push(`תזכורות שהתקבלו (סה"כ): ${allTimeCount}`);
  lines.push(`רצף ימים פעילים: ${user?.current_streak ?? 0} 🔥`);
  lines.push("");

  // Pull currently-active recurring reminders (daily/weekly) so the digest
  // shows the actual schedule (days + time), matching the reference image's
  // "המוטיבציות החוזרות שלך" block — not just a completion count.
  const { data: recurringReminders } = await supabase
    .from("reminders")
    .select("text, time, type")
    .eq("chat_id", chatId)
    .eq("active", true)
    .in("type", ["daily", "weekly"]);

  if (recurringReminders && recurringReminders.length > 0) {
    lines.push("⏰ <b>המוטיבציות החוזרות שלך</b>");
    for (const r of recurringReminders) {
      const daysLabel = r.type === "weekly" ? "שבועי" : "א׳-ש׳";
      const timeLabel = new Date(r.time).toLocaleTimeString("he-IL", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Jerusalem",
      });
      lines.push(`• ${r.text} — ימים: ${daysLabel} | שעה: ${timeLabel}`);
    }
    lines.push("");
  }

  if (topRecurring.length > 0) {
    lines.push("🏆 <b>הכי הרבה השלמת</b>");
    for (const [text, count] of topRecurring) {
      lines.push(`• ${text} — הושלמה ${count} פעמים`);
    }
    lines.push("");
  }

  lines.push("──────────────");
  lines.push("תמשיך ככה, כל תזכורת שמתקיימת זה עוד צעד קדימה 💪");
  return lines.join("\n");
}

// Called once per day by pg_cron. Also updates each user's streak counter:
// if they completed at least one reminder yesterday, streak += 1, otherwise
// it resets to 0. This runs BEFORE the summary is generated so the streak
// shown to the user is accurate for the message they are about to read.
async function updateStreaks() {
  const { data: users } = await supabase.from("users").select("chat_id, current_streak, last_active_date");
  if (!users) return;

  const yesterdayStart = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const todayDate = new Date().toISOString().slice(0, 10);

  for (const u of users) {
    const { data: activity } = await supabase
      .from("reminder_completions")
      .select("id", { count: "exact", head: true })
      .eq("chat_id", u.chat_id)
      .gte("completed_at", yesterdayStart);

    const hadActivity = ((activity as unknown as { length: number })?.length ?? 0) > 0;
    const newStreak = hadActivity ? (u.current_streak ?? 0) + 1 : 0;

    await supabase
      .from("users")
      .update({ current_streak: newStreak, last_active_date: todayDate })
      .eq("chat_id", u.chat_id);
  }
}

Deno.serve(async (_req: Request) => {
  try {
    await updateStreaks();

    const { data: users, error } = await supabase.from("users").select("chat_id");
    if (error) {
      console.error("[daily-summary] failed to load users:", error.message);
      return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 200 });
    }

    let sent = 0;
    for (const u of users ?? []) {
      try {
        const summary = await buildSummaryForUser(u.chat_id);
        await sendTelegramMessage(u.chat_id, summary);
        sent++;
      } catch (err) {
        console.error(`[daily-summary] failed for chat ${u.chat_id}:`, err);
      }
    }

    return new Response(JSON.stringify({ ok: true, sent }), { status: 200 });
  } catch (err) {
    console.error("[daily-summary] fatal:", err);
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
});
