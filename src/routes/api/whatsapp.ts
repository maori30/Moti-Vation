import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { createFileRoute } from "@tanstack/react-router";
import { generateText } from "ai";

const SYSTEM_PROMPT = `אתה "מוטי" – בוט מוטיבציה עוקצני בעברית מדוברת של תל־אביב. סמל קשוח, ציני, סרקסטי, הומור שחור, סלנג ישראלי. אתה כותב לחייל שלך בוואטסאפ.

כללים:
- ענה קצר. 1-3 משפטים.
- דבר בעברית עם סלנג ("יאללה", "אחי", "תזיז ת'תחת", "חלאס", "תכלס", "מה נסגר").
- לגלג ולהקניט – בלי להעליב באמת.
- 0-1 אימוג'י מקסימום.
- אל תזכיר שאתה בוט או AI. אתה מוטי.
- אם המשתמש מנסה תירוצים – תעקוץ. הצע זמן ספציפי.`;

type WAMessage = {
  from: string;
  id?: string;
  type?: string;
  text?: { body?: string };
};

async function sendWhatsAppText(
  phoneId: string,
  token: string,
  to: string,
  body: string,
) {
  const res = await fetch(
    `https://graph.facebook.com/v20.0/${phoneId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body, preview_url: false },
      }),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    console.error(`WhatsApp send failed [${res.status}]: ${err}`);
  }
}

export const Route = createFileRoute("/api/whatsapp")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
        if (mode === "subscribe" && token && token === verifyToken) {
          return new Response(challenge ?? "", { status: 200 });
        }
        return new Response("Forbidden", { status: 403 });
      },
      POST: async ({ request }) => {
        const aiKey = process.env.LOVABLE_API_KEY;
        const waToken = process.env.WHATSAPP_TOKEN;
        const phoneId = process.env.WHATSAPP_PHONE_ID;
        if (!aiKey || !waToken || !phoneId) {
          return new Response("Missing server config", { status: 500 });
        }

        let payload: any;
        try {
          payload = await request.json();
        } catch {
          return new Response("Bad JSON", { status: 400 });
        }

        try {
          const entries = Array.isArray(payload?.entry) ? payload.entry : [];
          const gateway = createLovableAiGatewayProvider(aiKey);

          for (const entry of entries) {
            const changes = Array.isArray(entry?.changes) ? entry.changes : [];
            for (const change of changes) {
              const value = change?.value;
              const messages: WAMessage[] = Array.isArray(value?.messages)
                ? value.messages
                : [];
              for (const msg of messages) {
                if (msg.type !== "text") continue;
                const from = msg.from;
                const userText = msg.text?.body?.trim();
                if (!from || !userText) continue;

                let reply = "יאללה, תתחיל לזוז.";
                try {
                  const { text } = await generateText({
                    model: gateway("google/gemini-2.5-flash"),
                    system: SYSTEM_PROMPT,
                    prompt: userText,
                  });
                  if (text?.trim()) reply = text.trim();
                } catch (e) {
                  console.error("Moti AI failed", e);
                }

                await sendWhatsAppText(phoneId, waToken, from, reply);
              }
            }
          }
        } catch (e) {
          console.error("Webhook processing error", e);
        }

        // Always 200 so Meta doesn't retry forever.
        return new Response("ok", { status: 200 });
      },
    },
  },
});