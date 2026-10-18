import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";
const TZ = Deno.env.get("BOT_TIMEZONE") ?? "Asia/Jerusalem";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function israelDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function sendTelegramMessage(chatId: number, text: string): Promise<boolean> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    return response.ok;
  } catch (error) {
    console.error(`[daily-summary] Telegram failed for ${chatId}:`, error);
    return false;
  }
}

function israelYesterday(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

async function updateStreaks() {
  const { data: users } = await supabase
    .from("users")
    .select("chat_id, streak_days, current_streak, last_productive_day, last_active_date");
  if (!users) return;

  const today = israelDate();
  const yesterday = israelYesterday();

  for (const user of users) {
    if (user.last_active_date === today) continue;

    // Check if the user was productive yesterday or today
    const wasProductiveRecently = user.last_productive_day === today || user.last_productive_day === yesterday;
    
    let streak = user.streak_days ?? user.current_streak ?? 0;
    if (!wasProductiveRecently) {
      streak = 0;
    }

    await supabase
      .from("users")
      .update({ streak_days: streak, current_streak: streak, last_active_date: today })
      .eq("chat_id", user.chat_id);
  }
}

async function buildSummary(chatId: number): Promise<string> {
  const since24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [{ count: total }, { count: today }, { data: user }, { data: completions }] = await Promise.all([
    supabase.from("reminder_completions").select("id", { count: "exact", head: true }).eq("chat_id", chatId),
    supabase.from("reminder_completions").select("id", { count: "exact", head: true }).eq("chat_id", chatId).gte("completed_at", since24Hours),
    supabase.from("users").select("goals_achieved, streak_days, current_streak").eq("chat_id", chatId).single(),
    supabase.from("reminder_completions").select("reminder_text").eq("chat_id", chatId).order("completed_at", { ascending: false }).limit(200),
  ]);

  const frequency = new Map<string, number>();
  for (const completion of completions ?? []) {
    if (completion.reminder_text) {
      frequency.set(completion.reminder_text, (frequency.get(completion.reminder_text) ?? 0) + 1);
    }
  }
  const top = [...frequency.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  const activeStreak = user?.streak_days ?? user?.current_streak ?? 0;
  const lines = [
    "☀️ <b>סיכום בוקר קצר</b>",
    "",
    `השלמת ביממה האחרונה: <b>${today ?? 0}</b>`,
    `השלמות בסך הכול: <b>${total ?? 0}</b>`,
    `רצף פעיל: <b>${activeStreak}</b> ימים`,
  ];

  if (top.length) {
    lines.push("", "<b>מה נסגר הכי הרבה:</b>");
    for (const [text, count] of top) lines.push(`• ${text} — ${count} פעמים`);
  }

  const endings = ["יום טוב. דבר אחד קטן מספיק להתחלה.", "בוקר אור! אל תשכח שאפילו צעד קטן הוא עדיין התקדמות.", "יאללה, יש לך את זה. שיהיה יום פורה.", "קום, תשתה קפה, ולך תטרוף את העולם.", "זכור: המאמץ של היום הוא ההצלחה של מחר. יום נהדר!", "בוקר מדהים. קח נשימה עמוקה וצא לדרך.", "אל תוותר לעצמך היום, גם אם ממש בא לך. בוקר טוב!", "כל בוקר הוא דף חלק. תכתוב בו משהו טוב."];
  lines.push("", endings[Math.floor(Math.random() * endings.length)]);
  return lines.join("\n");
}

Deno.serve(async () => {
  try {
    await updateStreaks();
    const today = israelDate();
    const { data: users, error } = await supabase.from("users").select("chat_id, last_summary_date");
    if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 200 });

    let sent = 0;
    for (const user of users ?? []) {
      if (user.last_summary_date === today) continue;
      if (await sendTelegramMessage(user.chat_id, await buildSummary(user.chat_id))) {
        await supabase.from("users").update({ last_summary_date: today }).eq("chat_id", user.chat_id);
        sent++;
      }
    }
    return new Response(JSON.stringify({ ok: true, sent }), { status: 200 });
  } catch (error) {
    console.error("[daily-summary] fatal:", error);
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
});

