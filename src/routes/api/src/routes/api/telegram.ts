const TG_TOKEN = "PUT_YOUR_TELEGRAM_TOKEN_HERE";
const TG_SECRET = "PUT_YOUR_SECRET_HERE";

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
