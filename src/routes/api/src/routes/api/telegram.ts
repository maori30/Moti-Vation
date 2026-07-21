const TG_TOKEN = "8874634451:AAHCobKuZMX6GPG_1Nv7lyMuURiRGixm40U";
const TG_SECRET = "maorliavkfir";

export async function POST(request: Request) {
  const update = await request.json();
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
}
