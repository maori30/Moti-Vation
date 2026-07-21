import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { generateText } from "ai";

const SARCASM_PROMPT = `אתה "מוטי" – סמל קשוח בצבא, ציני, סרקסטי, הומור שחור, סלנג ישראלי. אתה כותב הודעת תזכורת אחת לחייל שלך בוואטסאפ.

כללים:
- שורה אחת עד שתיים. קצר, נוקב, עוקצני.
- בעברית מדוברת. סלנג צה"לי/תל אביבי ("יאללה", "אחי", "תזיז ת'תחת", "קום ורוץ", "מה נסגר").
- לא לחזור על הטקסט של המשימה מילה במילה – להתייחס אליו בעקיפין עם עקיצה.
- 0-1 אימוג'י מקסימום. עדיף בלי.
- בלי פתיחים מנומסים, בלי "היי", בלי "תזכורת:". יורים ישר.
- אל תזכיר שאתה בוט או AI.`;

const NAG_PROMPT = SARCASM_PROMPT + `

זו תזכורת מציקה חוזרת – המשתמש כבר קיבל תזכורת קודמת ולא זז. תהיה יותר אגרסיבי, יותר עוקצני, ותזכיר לו שאתה חוזר על עצמך כי הוא מתמהמה.`;

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0")) return "972" + digits.slice(1);
  return digits;
}

export async function generateSarcasticLine(
  text: string,
  opts?: { nag?: boolean },
): Promise<string> {
  const aiKey = process.env.LOVABLE_API_KEY;
  if (!aiKey) return text;
  try {
    const gateway = createLovableAiGatewayProvider(aiKey);
    const { text: generated } = await generateText({
      model: gateway("google/gemini-2.5-flash"),
      system: opts?.nag ? NAG_PROMPT : SARCASM_PROMPT,
      prompt: `משימה: "${text}"\nכתוב תזכורת אחת בסגנון סמל קשוח.`,
    });
    return generated?.trim() || text;
  } catch (e) {
    console.error("AI gen failed", e);
    return text;
  }
}

export async function sendWhatsAppReminder(phone: string, text: string, opts?: { nag?: boolean }) {
  const waToken = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!waToken || !phoneId) throw new Error("WhatsApp env missing");

  const line = await generateSarcasticLine(text, opts);
  const to = normalizePhone(phone);
  const res = await fetch(
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
  if (!res.ok) {
    const err = await res.text();
    console.error(`WA send failed [${res.status}]: ${err}`);
    return { ok: false, error: err, line };
  }
  return { ok: true, line };
}