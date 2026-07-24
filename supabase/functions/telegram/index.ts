import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const PERSONALITIES: Record<string, { name: string; emoji: string; prompt: string }> = {
  coach: {
    name: "המאמן",
    emoji: "🧠",
    prompt: `אתה מאמן אישי תובעני, ישיר ורציני. אתה לא מקבל תירוצים ולא סובל עצלות. אתה דוחף את המשתמש קדימה בכוח - אבל מתוך אמונה אמיתית בו. משפטים קצרים וחדים. תמיד בעברית.`,
  },
  cynic: {
    name: "הציני",
    emoji: "😈",
    prompt: `אתה ציני מצחיק שמציק באהבה. אתה סרקסטי, אירוני, ומשונן. אתה עוזר - אבל תמיד עם קריצה ועוקצנות. הומור יבש. תמיד בעברית.`,
  },
  friend: {
    name: "החבר",
    emoji: "🤗",
    prompt: `אתה חבר טוב, חם ואמיתי. אתה מקשיב, אכפת לך, ותמיד שם. אתה מגיב כמו חבר אמיתי, שואל שאלות, מתעניין. תמיד בעברית. נעים, קרוב, מרגיע.`,
  },
  robot: {
    name: "הרובוט",
    emoji: "🤖",
    prompt: `אתה רובוט קר, לוגי וחסר רגשות לחלוטין. אתה מנתח כל מה שנאמר ומגיב בצורה מכנית ומדויקת בלבד. ללא אמפתיה. ללא חום. תמיד בעברית. קצר, מדויק, יעיל.`,
  },
  therapist: {
    name: "המטפל",
    emoji: "🛋️",
    prompt: `אתה מטפל נפשי אמפתי ועדין. אתה מקשיב לעומק, לא שופט, ועוזר למשתמש להבין את עצמו. אתה שואל שאלות פתוחות ומשקף רגשות. תמיד בעברית. רגוע, עמוק, קשוב.`,
  },
  hype: {
    name: "המעודד",
    emoji: "🔥",
    prompt: `אתה המעודד הכי אנרגטי שיש. כל מה שהמשתמש עושה זה מדהים. אתה מלא אנרגיה חיובית, קריאות עידוד, אמוג'ים וריגוש. גם שיחה רגילה הופכת אצלך לחגיגה. תמיד בעברית. נמרץ, רועש, מלהיב.`,
  },
  grandma: {
    name: "הסבתא",
    emoji: "👵",
    prompt: `אתה סבתא אוהבת, מודאגת ומתפנקת. אתה כל הזמן דואג שהמשתמש אכל, ישן, לא קר לו. אתה מספר סיפורים מהעבר ונותן עצות של חיים. כשהוא מספר בעיה אתה מיד מציע אוכל כפתרון. תמיד בעברית. חמימות, אהבה, קצת דאגה מוגזמת.`,
  },
  philosopher: {
    name: "הפילוסוף",
    emoji: "🧐",
    prompt: `אתה פילוסוף עמוק ומחשבתי. כל שאלה - אפילו הכי פשוטה - הופכת אצלך לדיון על משמעות החיים. אתה מצטט הוגים ומאתגר את המשתמש לחשוב לעומק. תמיד בעברית. עמוק, מחשבתי, קצת מורכב.`,
  },
};

const GREETINGS: Record<string, string> = {
  coach: `🧠 המאמן כאן.\nאין זמן לטקסים. מה המטרה שלך היום? דבר.`,
  cynic: `😈 אה, בחרת בי. כמובן. תמיד יודעים לבחור נכון בסוף.\nאז מה, מה קורה?`,
  friend: `🤗 היי! כל כך שמח שבחרת אותי!\nאז ספר - מה קורה אצלך? איך הולך?`,
  robot: `🤖 אישיות נטענה: רובוט.\nממתין לקלט.`,
  therapist: `🛋️ שלום. שמח שבחרת לדבר.\nאני כאן, קשוב לגמרי. במה תרצה להתחיל?`,
  hype: `🔥🔥🔥 כן כן כן!!! בחרת אותי!!! זו ההחלטה הכי טובה שעשית היום!!!\nיאללה ספר לי הכל - אני כבר מתרגש!!!`,
  grandma: `👵 אוי, מה נעים שבחרת אותי מכולם!\nאכלת היום? לא קר לך? ספר לסבתא מה קורה.`,
  philosopher: `🧐 בחרת. מעניין. האם הבחירה עצמה היא חופשית, או שאולי הגורל הוביל אותך לכאן?\nאבל זה לשיחה אחרת. מה שאלתך?`,
};

function getPersonalityKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🧠 המאמן", callback_data: "personality_coach" },
        { text: "😈 הציני", callback_data: "personality_cynic" },
      ],
      [
        { text: "🤗 החבר", callback_data: "personality_friend" },
        { text: "🤖 הרובוט", callback_data: "personality_robot" },
      ],
      [
        { text: "🛋️ המטפל", callback_data: "personality_therapist" },
        { text: "🔥 המעודד", callback_data: "personality_hype" },
      ],
      [
        { text: "👵 הסבתא", callback_data: "personality_grandma" },
        { text: "🧐 הפילוסוף", callback_data: "personality_philosopher" },
      ],
    ],
  };
}

async function sendMessage(chatId: number, text: string, keyboard?: object) {
  const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) body.reply_markup = keyboard;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function askGroq(userMessage: string, personalityKey: string, context: string): Promise<string> {
  const personality = PERSONALITIES[personalityKey] ?? PERSONALITIES.cynic;
  const systemPrompt = `${personality.prompt}\n\nהקשר נוסף על המשתמש: ${context}\n\nחשוב: אתה משוחח בשיחה זורמת וטבעית בעברית. אל תנסה להפנות לפקודות אלא אם המשתמש מבקש ספציפית.`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_tokens: 400,
        temperature: 1.0,
      }),
    });
    const data = await res.json();
    console.log("Groq response:", JSON.stringify(data));
    return data?.choices?.[0]?.message?.content ?? "לא הצלחתי לחשוב על תשובה. נסה שוב.";
  } catch (err) {
    console.error("Groq error:", err);
    return "לא הצלחתי לחשוב על תשובה. נסה שוב.";
  }
}

// Table name: 'users' (not 'bot_users')
async function getOrCreateUser(chatId: number, firstName: string) {
  const { data } = await supabase.from("users").select("*").eq("chat_id", chatId).single();
  if (data) return data;
  const { data: newUser } = await supabase
    .from("users")
    .insert({ chat_id: chatId, first_name: firstName, personality: "cynic", state: "idle" })
    .select()
    .single();
  return newUser;
}

async function updateUser(chatId: number, updates: object) {
  await supabase.from("users").update(updates).eq("chat_id", chatId);
}

async function handleStart(chatId: number, firstName: string) {
  await getOrCreateUser(chatId, firstName);
  await sendMessage(
    chatId,
    `שלום ${firstName}! 👋\nאני הבוט שיעזור לך לזכור מה אתה צריך לעשות - ולהציק לך עד שתעשה את זה 😈\n\nבחר אישיות:`,
    getPersonalityKeyboard()
  );
}

async function handleMenu(chatId: number) {
  await sendMessage(chatId, `מה תרצה לעשות?`, {
    inline_keyboard: [
      [{ text: "⏰ הוסף תזכורת", callback_data: "add_reminder" }],
      [{ text: "📋 התזכורות שלי", callback_data: "list_reminders" }],
      [{ text: "🎭 שנה אישיות", callback_data: "change_personality" }],
      [{ text: "💬 דבר איתי", callback_data: "chat" }],
    ],
  });
}

async function handleReminderText(chatId: number, text: string) {
  await updateUser(chatId, { state: "awaiting_reminder_type", pending_reminder_text: text });
  await sendMessage(chatId, `מעולה! מתי לתזכר אותך על: "${text}"?`, {
    inline_keyboard: [
      [{ text: "🔔 חד פעמי", callback_data: "reminder_type_once" }],
      [{ text: "📅 יומי", callback_data: "reminder_type_daily" }],
      [{ text: "📆 שבועי", callback_data: "reminder_type_weekly" }],
    ],
  });
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

  await supabase.from("reminders").insert({
    chat_id: chatId,
    text: reminderText,
    type,
    time: timeText,
    active: true,
  });

  await updateUser(chatId, { state: "idle", pending_reminder_text: null });

  const typeLabels: Record<string, string> = { once: "חד פעמי", daily: "יומי", weekly: "שבועי" };
  await sendMessage(chatId, `✅ תזכורת נוספה!\n📝 ${reminderText}\n🕐 ${timeText}\n🔁 ${typeLabels[type] ?? type}\n\nאציק לך בזמן 😈`);
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
        await updateUser(chatId, { personality: p, state: "chatting" });
        const greeting = GREETINGS[p] ?? `✅ אישיות שונתה! דבר איתי על הכל.`;
        await sendMessage(chatId, greeting);
      } else if (data === "add_reminder") {
        await updateUser(chatId, { state: "awaiting_reminder_text" });
        await sendMessage(chatId, "מה המטלה שאתה רוצה שאזכיר לך?");
      } else if (data === "list_reminders") {
        await handleListReminders(chatId);
      } else if (data === "change_personality") {
        await sendMessage(chatId, "בחר אישיות חדשה:", getPersonalityKeyboard());
      } else if (data === "chat") {
        await updateUser(chatId, { state: "chatting" });
        const p = user.personality as string;
        const pName = PERSONALITIES[p]?.name ?? "הבוט";
        const pEmoji = PERSONALITIES[p]?.emoji ?? "💬";
        await sendMessage(chatId, `${pEmoji} ${pName} כאן. דבר איתי על הכל!\n(שלח /menu לתפריט)`);
      } else if (data.startsWith("reminder_type_")) {
        const type = data.replace("reminder_type_", "");
        await handleReminderType(chatId, type);
      } else if (data.startsWith("done_reminder_")) {
        const reminderId = data.replace("done_reminder_", "");
        await supabase.from("reminders").update({ active: false }).eq("id", reminderId);
        const reply = await askGroq("המשתמש סיים את המטלה! תגיב בהתאם לאישיות שלך.", user.personality as string, "");
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
    } else if (text === "/personality") {
      await sendMessage(chatId, "בחר אישיות:", getPersonalityKeyboard());
    } else if (user.state === "awaiting_reminder_text") {
      await handleReminderText(chatId, text);
    } else if ((user.state as string).startsWith("awaiting_reminder_time_")) {
      await handleReminderTime(chatId, text, user);
    } else {
      const activeReminders = await supabase
        .from("reminders")
        .select("text, time, type")
        .eq("chat_id", chatId)
        .eq("active", true);

      const context = activeReminders.data?.length
        ? `למשתמש יש תזכורות פעילות: ${activeReminders.data.map((r) => r.text).join(", ")}`
        : "למשתמש אין תזכורות פעילות כרגע.";

      const reply = await askGroq(text, user.personality as string, context);
      await sendMessage(chatId, reply);
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
});
