import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const PERSONALITIES: Record<string, { name: string; prompt: string }> = {
  coach: {
    name: "המאמן",
    prompt: `אתה מאמן אישי תובעני ורציני. אתה לא מקבל תירוצים. אתה דוחף את המשתמש קדימה בכוח ובתקיפות. תמיד בעברית. משפטים קצרים וחדים.`,
  },
  cynic: {
    name: "הציני",
    prompt: `אתה ציני מצחיק שמציק באהבה. אתה סרקסטי, אירוני, ומעט שנון. אתה עוזר אבל תמיד עם קריצה ועוקצנות. תמיד בעברית. הומור יבש.`,
  },
  friend: {
    name: "החבר",
    prompt: `אתה חבר טוב, חם ומעודד. אתה תמיד שם לתמוך, להקשיב ולעודד. אתה אמפתי ואוהב. תמיד בעברית. נעים ומרגיע.`,
  },
  robot: {
    name: "הרובוט",
    prompt: `אתה רובוט קר, עובדתי וחסר רגשות לחלוטין. אתה עונה בצורה מכנית ולוגית בלבד. ללא רגשות. ללא אמפתיה. תמיד בעברית. קצר ויעיל.`,
  },
};

async function sendMessage(chatId: number, text: string, keyboard?: object) {
  const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) body.reply_markup = keyboard;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function askGemini(userMessage: string, personalityKey: string, context: string): Promise<string> {
  const personality = PERSONALITIES[personalityKey] ?? PERSONALITIES.cynic;
  const systemPrompt = `${personality.prompt}\n\nהקשר נוסף: ${context}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.9 },
      }),
    }
  );
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "לא הצלחתי לחשוב על תשובה. נסה שוב.";
}

async function getOrCreateUser(chatId: number, firstName: string) {
  const { data } = await supabase.from("bot_users").select("*").eq("chat_id", chatId).single();
  if (data) return data;
  const { data: newUser } = await supabase
    .from("bot_users")
    .insert({ chat_id: chatId, first_name: firstName, personality: "cynic", state: "idle" })
    .select()
    .single();
  return newUser;
}

async function updateUser(chatId: number, updates: object) {
  await supabase.from("bot_users").update(updates).eq("chat_id", chatId);
}

async function handleStart(chatId: number, firstName: string) {
  await getOrCreateUser(chatId, firstName);
  await sendMessage(
    chatId,
    `שלום ${firstName}! 👋\nאני הבוט שיעזור לך לזכור מה אתה צריך לעשות — ולהציק לך עד שתעשה את זה 😈\n\nבחר אישיות:`,
    {
      inline_keyboard: [
        [{ text: "😈 הציני (ברירת מחדל)", callback_data: "personality_cynic" }],
        [{ text: "🧠 המאמן", callback_data: "personality_coach" }],
        [{ text: "🤗 החבר", callback_data: "personality_friend" }],
        [{ text: "🤖 הרובוט", callback_data: "personality_robot" }],
      ],
    }
  );
}

async function handleMenu(chatId: number) {
  await sendMessage(
    chatId,
    `מה תרצה לעשות?`,
    {
      inline_keyboard: [
        [{ text: "⏰ הוסף תזכורת", callback_data: "add_reminder" }],
        [{ text: "📋 התזכורות שלי", callback_data: "list_reminders" }],
        [{ text: "🎭 שנה אישיות", callback_data: "change_personality" }],
        [{ text: "💬 דבר איתי", callback_data: "chat" }],
      ],
    }
  );
}

async function handleAddReminder(chatId: number) {
  await updateUser(chatId, { state: "awaiting_reminder_text" });
  await sendMessage(chatId, "מה המטלה שאתה רוצה שאזכיר לך? (כתוב בחופשיות)");
}

async function handleReminderText(chatId: number, text: string) {
  await updateUser(chatId, { state: "awaiting_reminder_type", pending_reminder_text: text });
  await sendMessage(
    chatId,
    `מעולה! מתי לתזכר אותך על: "${text}"?`,
    {
      inline_keyboard: [
        [{ text: "🔔 חד פעמי", callback_data: "reminder_type_once" }],
        [{ text: "📅 יומי", callback_data: "reminder_type_daily" }],
        [{ text: "📆 שבועי", callback_data: "reminder_type_weekly" }],
      ],
    }
  );
}

async function handleReminderType(chatId: number, type: string) {
  await updateUser(chatId, { state: `awaiting_reminder_time_${type}` });
  await sendMessage(chatId, `באיזו שעה? (כתוב בפורמט HH:MM, למשל 08:00)`);
}

async function handleReminderTime(chatId: number, timeText: string, user: Record<string, unknown>) {
  const state = user.state as string;
  const type = state.replace("awaiting_reminder_time_", "");
  const reminderText = user.pending_reminder_text as string;

  const timeMatch = timeText.match(/^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/);
  if (!timeMatch) {
    await sendMessage(chatId, "פורמט שגוי. כתוב שעה בפורמט HH:MM (למשל 08:30)");
    return;
  }

  const now = new Date();
  const [hours, minutes] = timeText.split(":").map(Number);
  const scheduledAt = new Date(now);
  scheduledAt.setHours(hours, minutes, 0, 0);
  if (scheduledAt <= now) scheduledAt.setDate(scheduledAt.getDate() + 1);

  await supabase.from("reminders").insert({
    chat_id: chatId,
    text: reminderText,
    type,
    time: timeText,
    scheduled_at: scheduledAt.toISOString(),
    active: true,
  });

  await updateUser(chatId, { state: "idle", pending_reminder_text: null });

  const typeLabels: Record<string, string> = { once: "חד פעמי", daily: "יומי", weekly: "שבועי" };
  await sendMessage(
    chatId,
    `✅ תזכורת נוספה!\n📝 ${reminderText}\n🕐 ${timeText}\n🔁 ${typeLabels[type] ?? type}\n\nאציק לך בזמן 😈`
  );
  await handleMenu(chatId);
}

async function handleListReminders(chatId: number) {
  const { data: reminders } = await supabase
    .from("reminders")
    .select("*")
    .eq("chat_id", chatId)
    .eq("active", true)
    .order("created_at", { ascending: false });

  if (!reminders || reminders.length === 0) {
    await sendMessage(chatId, "אין לך תזכורות פעילות. הוסף אחת! ⏰");
    return;
  }

  const typeLabels: Record<string, string> = { once: "חד פעמי", daily: "יומי", weekly: "שבועי" };
  let msg = "📋 <b>התזכורות שלך:</b>\n\n";
  reminders.forEach((r, i) => {
    msg += `${i + 1}. ${r.text}\n   🕐 ${r.time} | ${typeLabels[r.type] ?? r.type}\n\n`;
  });

  await sendMessage(chatId, msg);
}

serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("OK", { status: 200 });

  try {
    const update = await req.json();
    console.log("Update:", JSON.stringify(update));

    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message.chat.id;
      const data = cq.data as string;
      const user = await getOrCreateUser(chatId, cq.from.first_name);

      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: cq.id }),
      });

      if (data.startsWith("personality_")) {
        const p = data.replace("personality_", "");
        await updateUser(chatId, { personality: p, state: "idle" });
        const pName = PERSONALITIES[p]?.name ?? p;
        await sendMessage(chatId, `✅ בחרת: ${pName}!\nמעכשיו אדבר איתך בסגנון הזה 😎`);
        await handleMenu(chatId);
      } else if (data === "add_reminder") {
        await handleAddReminder(chatId);
      } else if (data === "list_reminders") {
        await handleListReminders(chatId);
      } else if (data === "change_personality") {
        await sendMessage(chatId, "בחר אישיות חדשה:", {
          inline_keyboard: [
            [{ text: "😈 הציני", callback_data: "personality_cynic" }],
            [{ text: "🧠 המאמן", callback_data: "personality_coach" }],
            [{ text: "🤗 החבר", callback_data: "personality_friend" }],
            [{ text: "🤖 הרובוט", callback_data: "personality_robot" }],
          ],
        });
      } else if (data === "chat") {
        await updateUser(chatId, { state: "chatting" });
        await sendMessage(chatId, "אני כאן. דבר איתי 💬\n(שלח /menu לחזור לתפריט)");
      } else if (data.startsWith("reminder_type_")) {
        const type = data.replace("reminder_type_", "");
        await handleReminderType(chatId, type);
      } else if (data.startsWith("done_reminder_")) {
        const reminderId = data.replace("done_reminder_", "");
        await supabase.from("reminders").update({ active: false }).eq("id", reminderId);
        const reply = await askGemini("המשתמש סיים את המטלה! תגיב בהתאם לאישיות שלך.", user.personality as string, "");
        await sendMessage(chatId, reply);
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const message = update.message;
    if (!message) return new Response(JSON.stringify({ ok: true }), { status: 200 });

    const chatId = message.chat.id;
    const text = (message.text ?? "").trim();
    const firstName = message.from?.first_name ?? "חבר";
    const user = await getOrCreateUser(chatId, firstName);

    if (text === "/start") {
      await handleStart(chatId, firstName);
    } else if (text === "/menu") {
      await updateUser(chatId, { state: "idle" });
      await handleMenu(chatId);
    } else if (text === "/reminders") {
      await handleListReminders(chatId);
    } else if (user.state === "awaiting_reminder_text") {
      await handleReminderText(chatId, text);
    } else if ((user.state as string).startsWith("awaiting_reminder_time_")) {
      await handleReminderTime(chatId, text, user);
    } else if (user.state === "chatting" || user.state === "idle") {
      const activeReminders = await supabase
        .from("reminders")
        .select("text, time, type")
        .eq("chat_id", chatId)
        .eq("active", true);

      const context = activeReminders.data?.length
        ? `למשתמש יש תזכורות פעילות: ${activeReminders.data.map((r) => r.text).join(", ")}`
        : "למשתמש אין תזכורות פעילות כרגע.";

      const reply = await askGemini(text, user.personality as string, context);
      await sendMessage(chatId, reply);
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
});
