import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { createFileRoute } from "@tanstack/react-router";
import { generateText } from "ai";
import { z } from "zod";

const BodySchema = z.object({
  phone: z.string().min(6),
  text: z.string().min(1),
});

const SARCASM_PROMPT = `אתה "מוטי" – סמל קשוח בצבא, ציני, סרקסטי, הומור שחור, סלנג ישראלי. אתה כותב הודעת תזכורת אחת לחייל שלך בוואטסאפ.

כללים:
- שורה אחת עד שתיים. קצר, נוקב, עוקצני.
- בעברית מדוברת. סלנג צה"לי/תל אביבי ("יאללה", "אחי", "תזיז ת'תחת", "קום ורוץ", "מה נסגר").
- לא לחזור על הטקסט של המשימה מילה במילה – להתייחס אליו בעקיפין עם עקיצה.
- 0-1 אימוג'י מקסימום. עדיף בלי.
- בלי פתיחים מנומסים, בלי "היי", בלי "תזכורת:". יורים ישר.
- אל תזכיר שאתה בוט או AI.

דוגמאות:
משימה: "ללכת לחדר כושר"
פלט: "קום מהספה גיבור, הברזל לא ירים את עצמו. יאללה זוז."

משימה: "להתקשר לאמא"
פלט: "אמא שלך עדיין זוכרת שיש לה בן? תרים טלפון לפני שהיא מוחקת אותך מהצוואה."

משימה: "לסיים את המצגת"
פלט: "המצגת לא תסיים את עצמה בזמן שאתה גולל טיקטוק. חלאס, לעבודה."`;

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0")) return "972" + digits.slice(1);
  return digits;
}

export const Route = createFileRoute("/api/send-reminder")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const parsed = BodySchema.safeParse(await request.json());
        if (!parsed.success) {
          return new Response("Bad request", { status: 400 });
        }
        const { phone, text } = parsed.data;

        const aiKey = process.env.LOVABLE_API_KEY;
        const waToken = process.env.WHATSAPP_TOKEN;
        const phoneId = process.env.WHATSAPP_PHONE_ID;
        if (!aiKey || !waToken || !phoneId) {
          return new Response("Missing server config", { status: 500 });
        }

        // 1) Generate a sarcastic drill-sergeant line
        let line = text;
        try {
          const gateway = createLovableAiGatewayProvider(aiKey);
          const { text: generated } = await generateText({
            model: gateway("google/gemini-2.5-flash"),
            system: SARCASM_PROMPT,
            prompt: `משימה: "${text}"\nכתוב תזכורת אחת בסגנון סמל קשוח.`,
          });
          if (generated?.trim()) line = generated.trim();
        } catch (e) {
          console.error("AI generation failed, falling back to raw text", e);
        }

        // 2) Send via WhatsApp Cloud API
        const to = normalizePhone(phone);
        const waRes = await fetch(
          `https://graph.facebook.com/v20.0/${phoneId}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${waToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to,
              type: "text",
              text: { body: line, preview_url: false },
            }),
          },
        );

        if (!waRes.ok) {
          const errBody = await waRes.text();
          console.error(`WhatsApp send failed [${waRes.status}]: ${errBody}`);
          return Response.json(
            { ok: false, status: waRes.status, error: errBody, line },
            { status: 502 },
          );
        }

        const data = await waRes.json().catch(() => ({}));
        return Response.json({ ok: true, line, wa: data });
      },
    },
  },
});