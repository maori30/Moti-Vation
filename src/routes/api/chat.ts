import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { createFileRoute } from "@tanstack/react-router";
import { convertToModelMessages, streamText, tool, stepCountIs, type UIMessage } from "ai";
import { z } from "zod";

type ChatState = {
  goals: { id: string; text: string; done?: boolean }[];
  reminders: {
    id: string;
    text: string;
    kind: "once" | "recurring";
    at?: string; // ISO for once
    time?: string; // "HH:MM" for recurring
    days?: string[]; // for recurring: ['sun','mon',...]
  }[];
  now: string; // client local time ISO
};

const SYSTEM_PROMPT = `אתה "מוטי" – בוט מוטיבציה עוקצני בעברית מדוברת של תל־אביב. אתה נשמע כמו חבר ישראלי חד לשון: הומור שחור, ציניות, סלנג, זריקות עם קריצה. אתה לא מתחנף. לא אומר "כמובן" ולא "אני שמח לעזור". אתה שם רק כדי לוודא שהמשתמש מזיז את התחת ומשלים מטרות.

כללים:
- ענה קצר. 1-3 משפטים לרוב. לפעמים אפילו רק שורה.
- דבר בעברית. תשתמש בסלנג ישראלי טבעי ("יאללה", "אחי", "תזיז ת'תחת", "חלאס", "סעמק" במידה, "תכלס", "מה נסגר").
- אל תפחד ללגלג ולהקניט – אבל בלי להעליב באמת. הומור, לא אלימות.
- אימוג'ים במידה קטנה (0-2 להודעה). לא לגזים.
- כשהמשתמש נותן מטרה חדשה – השתמש בכלי add_goal. אל תשאל שאלות בירוקרטיות מיותרות, פשוט תוסיף.
- כשהמשתמש מבקש תזכורת ("תזכיר לי ב-17:30", "כל בוקר ב-6:30") – השתמש ב-add_reminder. הבן זמנים בעברית ("מחר", "בעוד שעה", "כל יום"). אם חסר לך פרט – שאל שאלה קצרה.
- כשהמשתמש מסיים משימה או רוצה למחוק – השתמש ב-complete_goal / remove_goal / remove_reminder.
- אחרי שהפעלת כלי, כתוב הודעה אישית קצרה שמאשרת ומתחילה להציק לגבי הביצוע.
- אם המשתמש מנסה לצאת בתירוצים ("מחר", "אחר כך", "עייף") – תעקוץ אותו בהומור. אל תרד ממנו בקלות. הצע זמן ספציפי.
- אל תכתוב מונולוגים ארוכים. אתה בוט של וואטסאפ, לא מרצה.
- לעולם אל תזכיר שאתה בינה מלאכותית, GPT, מודל, או OpenAI. אתה מוטי.

דוגמאות טון:
משתמש: "בעזרת השם אעשה את זה מחר"
אתה: "בעזרת השם והתחת שלך שיזוז. באיזו שעה מחר?"

משתמש: "אין לי כוח"
אתה: "כוח זה לא עניין של מלאי. יאללה 10 דקות ותסגור פינה."

משתמש: "אני אוהב אותך"
אתה: "חנפן. תשמור ת'אהבה למשימות."`;

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json()) as { messages?: UIMessage[]; state?: ChatState };
        const messages = body.messages;
        const state = body.state;
        if (!Array.isArray(messages)) {
          return new Response("Messages are required", { status: 400 });
        }

        const key = process.env.LOVABLE_API_KEY;
        if (!key) return new Response("Missing LOVABLE_API_KEY", { status: 500 });

        const gateway = createLovableAiGatewayProvider(key);

        const contextSystem = state
          ? `הזמן הנוכחי אצל המשתמש: ${state.now}
מטרות פתוחות: ${state.goals.filter((g) => !g.done).map((g) => `- ${g.text}`).join("\n") || "אין"}
תזכורות פעילות: ${
              state.reminders
                .map((r) =>
                  r.kind === "once"
                    ? `- חד־פעמית ${r.at}: ${r.text}`
                    : `- חוזרת ${r.days?.join(",")} ${r.time}: ${r.text}`,
                )
                .join("\n") || "אין"
            }`
          : "";

        const result = streamText({
          model: gateway("google/gemini-2.5-flash"),
          system: SYSTEM_PROMPT + "\n\n" + contextSystem,
          messages: await convertToModelMessages(messages),
          stopWhen: stepCountIs(6),
          tools: {
            add_goal: tool({
              description: "הוסף מטרה חדשה לרשימה של המשתמש.",
              inputSchema: z.object({ text: z.string().describe("תיאור המטרה בעברית") }),
              execute: async ({ text }) => ({ ok: true, text }),
            }),
            complete_goal: tool({
              description: "סמן מטרה כהושלמה. השתמש בטקסט של המטרה כדי לזהות אותה.",
              inputSchema: z.object({ text: z.string() }),
              execute: async ({ text }) => ({ ok: true, text }),
            }),
            remove_goal: tool({
              description: "מחק מטרה מהרשימה.",
              inputSchema: z.object({ text: z.string() }),
              execute: async ({ text }) => ({ ok: true, text }),
            }),
            add_reminder: tool({
              description:
                "הוסף תזכורת. עבור תזכורת חד־פעמית ספק at כ-ISO string. עבור תזכורת חוזרת ספק time (HH:MM) ו-days (מערך מ-sun,mon,tue,wed,thu,fri,sat).",
              inputSchema: z.object({
                text: z.string(),
                kind: z.enum(["once", "recurring"]),
                at: z.string().optional(),
                time: z.string().optional(),
                days: z.array(z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"])).optional(),
              }),
              execute: async (input) => ({ ok: true, ...input }),
            }),
            remove_reminder: tool({
              description: "מחק תזכורת לפי הטקסט שלה.",
              inputSchema: z.object({ text: z.string() }),
              execute: async ({ text }) => ({ ok: true, text }),
            }),
          },
        });

        return result.toUIMessageStreamResponse({ originalMessages: messages });
      },
    },
  },
});