import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "PUT_YOUR_TELEGRAM_TOKEN_HERE";

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("OK", { status: 200 });
  }

  try {
    const update = await req.json();
    console.log("Telegram update:", JSON.stringify(update));

    const chatId = update?.message?.chat?.id;
    const text = update?.message?.text;

    if (chatId && text) {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `קיבלתי: ${text}`,
        }),
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ ok: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
});
