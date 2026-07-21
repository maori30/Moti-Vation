/**
 * WhatsApp Meta Cloud API Webhook — Moti Bot
 * ⚠️  Credentials are hardcoded — keep this repo PRIVATE.
 */

import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { createFileRoute } from "@tanstack/react-router";
import { generateText, tool } from "ai";
import { z } from "zod";

// ─── Credentials ──────────────────────────────────────────────────────────────
const WA_TOKEN        = process.env.WHATSAPP_TOKEN        ?? "EAAm35fQZBWqABSHHl2UZAEILsaSDpyP2A9q0k2YpLFzLALzJU8YkOhINOJInGAN2mlW3Yv5kZCsgMioQzVMpRCzwQEXZBcCosegauU2clBQDvpCjvasHRPNhZB4gZACjZCZAz0zvpLS76gnAH6A2VF2fWb5seoQsLdqH7Vl6qoXtko0nT7QOM3D0VZBZCigmRlP9ZCThgZDZD";
const WA_PHONE_ID     = process.env.WHATSAPP_PHONE_ID     ?? "1263450553514382";
const WA_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN ?? "moti-secret-2026";

// ─── Types ────────────────────────────────────────────────────────────────────

type WAMessage = {
  from: string;
  id?: string;
  type?: string;
  text?: { body?: string };
};

type Goal = {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
};

type Reminder = {
  id: string;
  text: string;
  kind: "once" | "recurring";
  at?: string;
  time?: string;
  days?: string[];
  lastSent?: string;
};

type Session = {
  history: { role: "user" | "assistant"; content: string }[];
  goals: Goal[];
  reminders: Reminder[];
};

// ─── In-memory session store ──────────────────────────────────────────────────

const sessions = new Map<string, Session>();

function getSession(phone: string): Session {
  if (!sessions.has(phone)) {
    sessions.set(phone, { history: [], goals: [], reminders: [] });
  }
  return sessions.get(phone)!;
}

// ─── WhatsApp send helper ─────────────────────────────────────────────────────

async function sendWhatsAppText(to: string, body: string): Promise<void> {
  const res = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body, preview_url: false },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`WhatsApp send failed [${res.status}]: ${err}`);
  }
}

// ─── Proactive reminder scheduler ────────────────────────────────────────────

let schedulerStarted = false;

function startReminderScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  setInterval(async () => {
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    const currentDay = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][now.getDay()];
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    for (const [phone, session] of sessions.entries()) {
      for (const reminder of [...session.reminders]) {
        try {
          if (reminder.kind === "once" && reminder.at) {
            const dueAt = new Date(reminder.at);
            const diff = Math.abs(now.getTime() - dueAt.getTime());
            if (diff <= 60_000 && reminder.lastSent !== todayKey) {
              reminder.lastSent = todayKey;
              await sendWhatsAppText(phone, `⏰ תזכורת: ${reminder.text}\n\nיאללה, אל תחכה שאני אבוא אחריך בפעם השנייה 😤`);
              session.reminders = session.reminders.filter((r) => r.id !== reminder.id);
            }
          } else if (reminder.kind === "recurring" && reminder.time && reminder.days) {
            const fireKey = `${todayKey}-${currentTime}`;
            if (reminder.days.includes(currentDay) && reminder.time === currentTime && reminder.lastSent !== fireKey) {
              reminder.lastSent = fireKey;
              await sendWhatsAppText(phone, `🔔 תזכורת יומית: ${reminder.text}\n\nסעמק, אל תגיד לי ששכחת 🙄`);
            }
          }
        } catch (err) {
          console.error("Reminder scheduler error:", err);
        }
      }
    }
  }, 60_000);
}

// ─── Moti system prompt ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `אתה "מוטי" – בוט מוטיבציה עוקצני בעברית מדוברת של תל־אביב. אתה נשמע כמו חבר ישראלי חד לשון: הומור שחור, ציניות, סלנג, זריקות עם קריצה.
אתה לא מתחנף. לא אומר "כמובן" ולא "אני שמח לעזור". אתה שם רק כדי לוודא שהמשתמש מזיז את התחת ומשלים מטרות.

כללים:
- ענה קצר. 1-3 משפטים לרוב. לפעמים אפילו רק שורה.
- דבר בעברית. תשתמש בסלנג ישראלי טבעי ("יאללה", "אחי", "תזיז ת'תחת", "חלאס", "סעמק" במידה, "תכלס", "מה נסגר").
- אל תפחד ללגלג ולהקניט – אבל בלי להעליב באמת. הומור, לא אלימות.
- אימוג'ים במידה קטנה (0-2 להודעה). לא לגזים.
- כשהמשתמש נותן מטרה חדשה – השתמש בכלי add_goal.
- כשהמשתמש מבקש תזכורת – השתמש ב-add_reminder. הבן זמנים בעברית.
- כשהמשתמש מסיים משימה – השתמש ב-complete_goal / remove_goal / remove_reminder.
- אחרי שהפעלת כלי, כתוב הודעה אישית קצרה שמאשרת.
- אם המשתמש מנסה לצאת בתירוצים – תעקוץ אותו בהומור.
- אל תכתוב מונולוגים ארוכים. אתה בוט של וואטסאפ, לא מרצה.
- לעולם אל תזכיר שאתה בינה מלאכותית, GPT, מודל, או OpenAI. אתה מוטי.`;

// ─── Command handler ──────────────────────────────────────────────────────────

async function handleCommand(phone: string, command: string): Promise<boolean> {
  const session = getSession(phone);
  const cmd = command.trim().split(" ")[0].toLowerCase();

  switch (cmd) {
    case "/מטרות":
    case "/goals": {
      const open = session.goals.filter((g) => !g.done);
      const done = session.goals.filter((g) => g.done);
      if (open.length === 0 && done.length === 0) {
        await sendWhatsAppText(phone, "אין לך מטרות בכלל אחי 😐 תתחיל לכתוב לי מה אתה רוצה להשיג.");
      } else {
        const lines: string[] = [];
        if (open.length > 0) { lines.push("🎯 *מטרות פתוחות:*"); open.forEach((g, i) => lines.push(`${i + 1}. ${g.text}`)); }
        if (done.length > 0) { lines.push("\n✅ *הושלמו:*"); done.forEach((g, i) => lines.push(`${i + 1}. ${g.text}`)); }
        await sendWhatsAppText(phone, lines.join("\n"));
      }
      return true;
    }
    case "/תזכורות":
    case "/reminders": {
      if (session.reminders.length === 0) {
        await sendWhatsAppText(phone, "אין תזכורות פעילות. תגיד לי מתי להציק לך 😏");
      } else {
        const lines = ["🔔 *תזכורות פעילות:*"];
        session.reminders.forEach((r, i) => {
          const when = r.kind === "once" ? `חד-פעמית: ${r.at}` : `חוזרת: ${r.days?.join(", ")} בשעה ${r.time}`;
          lines.push(`${i + 1}. ${r.text} (${when})`);
        });
        await sendWhatsAppText(phone, lines.join("\n"));
      }
      return true;
    }
    case "/סטטוס":
    case "/status": {
      const openCount = session.goals.filter((g) => !g.done).length;
      const doneCount = session.goals.filter((g) => g.done).length;
      const msg = `📊 *הסטטוס שלך:*\n🎯 מטרות פתוחות: ${openCount}\n✅ הושלמו: ${doneCount}\n🔔 תזכורות: ${session.reminders.length}\n\n` +
        (openCount === 0 ? "אין לך מטרות פתוחות. יאללה, תוסיף משהו לעשות." : `עוד ${openCount} מטרות מחכות לך. מתי אתה מתחיל? 😏`);
      await sendWhatsAppText(phone, msg);
      return true;
    }
    case "/נקה":
    case "/clear": {
      session.history = []; session.goals = []; session.reminders = [];
      await sendWhatsAppText(phone, "נמחק הכל 🗑️ דף חלק. אל תבזבז את זה הפעם.");
      return true;
    }
    case "/עזרה":
    case "/help": {
      await sendWhatsAppText(phone, `🤙 *פקודות מוטי:*\n\n/מטרות — רשימת המטרות שלך\n/תזכורות — תזכורות פעילות\n/סטטוס — סיכום כללי\n/נקה — מחק הכל ותתחיל מחדש\n/עזרה — ההודעה הזאת\n\nאו פשוט *כתוב לי בעברית* מה אתה רוצה לעשות ואני אבין 💬`);
      return true;
    }
    default:
      return false;
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/api/whatsapp")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        if (mode === "subscribe" && token === WA_VERIFY_TOKEN) {
          return new Response(challenge ?? "", { status: 200 });
        }
        return new Response("Forbidden", { status: 403 });
      },

      POST: async ({ request }) => {
        startReminderScheduler();

        let payload: any;
        try { payload = await request.json(); }
        catch { return new Response("Bad JSON", { status: 400 }); }

        (async () => {
          try {
            const entries = Array.isArray(payload?.entry) ? payload.entry : [];
            const aiKey = process.env.LOVABLE_API_KEY;
            if (!aiKey) return;
            const gateway = createLovableAiGatewayProvider(aiKey);

            for (const entry of entries) {
              const changes = Array.isArray(entry?.changes) ? entry.changes : [];
              for (const change of changes) {
                const messages: WAMessage[] = Array.isArray(change?.value?.messages) ? change.value.messages : [];
                for (const msg of messages) {
                  if (msg.type !== "text") continue;
                  const phone = msg.from;
                  const userText = msg.text?.body?.trim();
                  if (!phone || !userText) continue;

                  if (userText.startsWith("/")) {
                    const handled = await handleCommand(phone, userText);
                    if (handled) continue;
                  }

                  const session = getSession(phone);
                  const contextBlock =
                    `הזמן הנוכחי: ${new Date().toISOString()}\n` +
                    `מטרות פתוחות: ${session.goals.filter((g) => !g.done).map((g) => `- ${g.text}`).join("\n") || "אין"}\n` +
                    `תזכורות פעילות: ${session.reminders.map((r) =>
                      r.kind === "once" ? `- חד-פעמית ${r.at}: ${r.text}` : `- חוזרת ${r.days?.join(",")} ${r.time}: ${r.text}`
                    ).join("\n") || "אין"}`;

                  session.history.push({ role: "user", content: userText });

                  const result = await generateText({
                    model: gateway("google/gemini-2.5-flash"),
                    system: SYSTEM_PROMPT + "\n\n" + contextBlock,
                    messages: session.history,
                    tools: {
                      add_goal: tool({ description: "הוסף מטרה חדשה.", parameters: z.object({ text: z.string() }), execute: async ({ text }) => { session.goals.push({ id: crypto.randomUUID(), text, done: false, createdAt: new Date().toISOString() }); return { ok: true }; } }),
                      complete_goal: tool({ description: "סמן מטרה כהושלמה.", parameters: z.object({ text: z.string() }), execute: async ({ text }) => { const g = session.goals.find((g) => g.text.includes(text)); if (g) g.done = true; return { ok: true }; } }),
                      remove_goal: tool({ description: "מחק מטרה.", parameters: z.object({ text: z.string() }), execute: async ({ text }) => { session.goals = session.goals.filter((g) => !g.text.includes(text)); return { ok: true }; } }),
                      add_reminder: tool({ description: "הוסף תזכורת.", parameters: z.object({ text: z.string(), kind: z.enum(["once", "recurring"]), at: z.string().optional(), time: z.string().optional(), days: z.array(z.enum(["sun","mon","tue","wed","thu","fri","sat"])).optional() }), execute: async (input) => { session.reminders.push({ id: crypto.randomUUID(), ...input }); return { ok: true }; } }),
                      remove_reminder: tool({ description: "מחק תזכורת.", parameters: z.object({ text: z.string() }), execute: async ({ text }) => { session.reminders = session.reminders.filter((r) => !r.text.includes(text)); return { ok: true }; } }),
                    },
                    maxSteps: 6,
                  });

                  const reply = result.text?.trim();
                  if (reply) {
                    session.history.push({ role: "assistant", content: reply });
                    if (session.history.length > 20) session.history = session.history.slice(-20);
                    await sendWhatsAppText(phone, reply);
                  }
                }
              }
            }
          } catch (err) {
            console.error("Webhook processing error", err);
          }
        })();

        return new Response("ok", { status: 200 });
      },
    },
  },
});
