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

Deno.serve(async (_req: Request) => {
  try {
    const nowIso = new Date().toISOString();

    const { data: dueReminders, error } = await supabase
      .from("reminders")
      .select("id, chat_id, text, type")
      .eq("active", true)
      .lte("time", nowIso);

    if (error) {
      console.error("[check-reminders] query failed:", error.message);
      return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 200 });
    }

    if (!dueReminders || dueReminders.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: 0 }), { status: 200 });
    }

    let sent = 0;
    for (const r of dueReminders) {
      try {
        await sendTelegramMessage(r.chat_id, `⏰ תזכורת: ${r.text}`);
        if (r.type === "once") {
          await supabase.from("reminders").update({ active: false }).eq("id", r.id);
        } else {
          // For daily/weekly recurring reminders, push the time forward
          // instead of deactivating, so it fires again next cycle.
          const incrementMs = r.type === "weekly" ? 7 * 86400000 : 86400000;
          const nextTime = new Date(new Date(nowIso).getTime() + incrementMs).toISOString();
          await supabase.from("reminders").update({ time: nextTime }).eq("id", r.id);
        }
        sent++;
      } catch (sendErr) {
        console.error(`[check-reminders] failed to send reminder ${r.id}:`, sendErr);
      }
    }

    return new Response(JSON.stringify({ ok: true, sent }), { status: 200 });
  } catch (err) {
    console.error("[check-reminders] fatal:", err);
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
});
