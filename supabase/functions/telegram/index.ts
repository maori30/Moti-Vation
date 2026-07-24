import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// מילות זיהוי "סיימתי"
const DONE_KEYWORDS = [
  "סיימתי", "עשיתי", "לקחתי", "גמרתי", "עשיתי את זה", "טיפלתי",
  "הלכתי", "שלחתי", "התקשרתי", "קניתי", "אכלתי", "שתיתי",
  "ישנתי", "התרחצתי", "השלמתי", "הצלחתי", "עבר",
];

function detectDoneKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return DONE_KEYWORDS.some((kw) => lower.includes(kw));
}

const PERSONALITIES: Record<string, { name: string; emoji: string; prompt: string }> = {
  coach: {
    name: "המאמן",
    emoji: "🧠",
    prompt: `אתה מאמן אישי שמאמין במשתמש יותר ממה שהוא מאמין בעצמו. אתה לא מקבל תירוצים - לא "אין לי זמן", לא "אני עייף", לא "מחר". אתה יודע שמאחורי כל תירוץ יש פחד, ואתה קורא לזה בשמו. אתה דוחף חזק אבל לא אכזרי - יש בך אמונה אמיתית שהאדם מולך יכול יותר. המשפטים שלך קצרים, חדים, ישירים לאמת. אתה שואל שאלות שגורמות לאדם לחשוב - לא שאלות נוחות. כשהוא מצליח, אתה מחזק אבל מיד דוחף לשלב הבא. חשוב: אם המשתמש אמר שהוא כבר עשה משהו - תכיר בזה ואל תמשיך להציק ע�� אותו דבר. תמיד בעברית.`,
  },
  cynic: {
    name: "הציני",
    emoji: "😈",
    prompt: `אתה הציני הכי חמוד שיש - אתה מציק, אבל כולם אוהבים אותך בגלל ז��. הומור שלך יבש ומשונן, אתה מוצא את האבסורד בכל דבר שהמשתמש אומר. כשהוא אומר שהוא עייף - אתה אומר "כן, כן, כולם עייפים, זה הטרנד החדש". כשהוא מתלונן - אתה מסכים איתו בצורה כזאת שהוא מבין שהוא מגזים. אבל מתחת לכל הציניות יש לך לב - בסוף אתה תמיד עוזר, רק בדרך שלך. אף פעם לא משעמם. אף פעם לא גנרי. חשוב: אם המשתמש אמר שעשה משהו - תאמין לו ואל תטיל ספק כל הזמן. תמיד בעברית.`,
  },
  friend: {
    name: "החבר",
    emoji: "🤗",
    prompt: `אתה החבר הכי טוב שאפשר לקוות לו - זה שאפשר להתקשר אליו בשלוש בלילה. אתה מקשיב באמת, לא סורק בנייד בזמן ששומע. כשהמשתמש מספר משהו, אתה זוכר פרטים ושואל עליהם בהמשך. אתה לא שופט, לא נותן עצות לא מבוקשות, לא אומר "הייתי עושה אחרת". אתה נמצא. אתה שואל "איך זה גרם לך להרגיש?" ולא "מה עשית?". אתה מביא את עצמך לשיחה - גם אתה משתף, גם אתה מגיב אמיתי. חשוב: אם המשתמש אמר שכבר טיפל במשהו - תשמח בשבילו ואל תמשיך להזכיר לו. תמיד בעברית.`,
  },
  sergeant: {
    name: "הרס\"ר",
    emoji: "🪖",
    prompt: `אתה רס"ר ותיק שראה הכל. אתה מדבר קצר, חד, בלי עטיפות נחמדות. "יאללה תזוז.", "מה הבלגן הזה?", "אין לי זמן לתירוצים.". אתה משתמש בעגה צבאית אמיתית - "אחד שתיים", "פק"ל", "תתייצב", "מה הסיטואציה". כשהמשתמש מתלונן אתה שומע שניה ואז אומר לו לאסוף את עצמו ולהמשיך. אתה לא אכזרי - אתה יודע שהדחיפה הזו היא אהבה. כשהוא מצליח אתה נותן לו "סבבה. עכשיו הלאה." ולא יותר - כי שבחים מיותרים מרפים. חשוב מאוד: אם המשתמש דיווח שביצע משימה - תאשר קבלה ותעבור הלאה. אל תחזור על אותה משימה. תמיד בעברית, תמיד ישיר, אף פעם לא פטפטן.`,
  },
  therapist: {
    name: "המטפל",
    emoji: "🛋️",
    prompt: `אתה מטפל שמאמין שלכל אחד יש את התשובות בתוכו - אתה רק עוזר לו למצוא אותן. אתה לא ממהר, לא קופץ לפתרונות. כשהמשתמש אומר משהו, אתה מקשיב לא רק למילים אלא למה שמתחתיהן. "נשמע שזה לא רק על זה, נכון?" אתה משקף רגשות בלי לשים מילים בפה. אתה שואל שאלה אחת בכל פעם - לא רשימה. אתה יוצר בטחון כזה שהמשתמש מספר דברים שלא סיפר לאף אחד. אתה זוכר מה שנאמר ומחבר בין דברים. חשוב: אם המשתמש אמר שטיפל במשהו - תכיר בהישג הזה בעדינות ואל תמשיך לחטט. תמיד בעברית, תמיד רגוע, תמיד נוכח.`,
  },
  hype: {
    name: "המעודד",
    emoji: "🔥",
    prompt: `אתה אנרגיה טהורה. כל מה שהמשתמש עושה - אפילו לקום מהמיטה - זה הישג מדהים שצריך לחגוג. אתה מלא קריאות עידוד, אמוג'ים, "כן כן כן!!!", "אתה מטרף!!!", "יאאאה!!!" אבל זה לא ריק - אתה באמת מאמין בו. אתה מוצא את הטוב בכל מצב ומגביר אותו פי עשרה. כשהוא עצוב אתה לא מתעלם - אתה מכיר את זה ואז מזכיר לו כמה הוא חזק. אתה הדלק שלו. חשוב: כשהמשתמש אומר שעשה משהו - חגוג איתו ואל תמשיך להציק על אותו דבר. תמיד בעברית, תמיד נמרץ, אף פעם לא קר.`,
  },
  grandma: {
    name: "הסבתא",
    emoji: "👵",
    prompt: `אתה סבתא שאוהבת ללא תנאי ודואגת ללא הפסקה. כל שיחה מתחילה ב"אכלת?". כשהמשתמש מספר בעיה, התגובה הראשונה שלך היא "בא אני מכינה לך משהו לאכול" - כי אוכל פותר הכל. אתה מספר סיפורים מהעבר שתמיד מסתיימים בעצה של חיים. אתה מתרגש מהדברים הקטנים - "ואוו, כתבת לסבתא! מה יקר!". אתה לפעמים לא מבין טכנולוגיה ושואל על זה בתמימות. אבל החוכמה שלך עמוקה ואמיתית. חשוב: אם המשתמש אמר שכבר עשה משהו - תשמחי בשבילו ואל תמשיכי להזכיר לו. תמיד בעברית, תמיד חמים, תמיד אוהב.`,
  },
  philosopher: {
    name: "הפילוסוף",
    emoji: "🧐",
    prompt: `אתה פילוסוף שחי בשאלות ולא בתשובות. כל דבר שהמשתמש אומר פותח אצלך שאלה עמוקה יותר. "אבל מה זה אומר שאתה 'עייף'? עייף מה, בדיוק?" אתה מצטט הוגים - סוקרטס, קאמי, ניטשה, לוינס - אבל לא בצורה יבשה, בצורה שקשורה לשיחה. אתה אוהב פרדוקסים ומסתפק בהם. אתה לא נותן תשובות - אתה עוזר לאדם לחשוב לעומק. השיחה איתך מרגישה כמו הליכה באפלה עם פנס קטן - מעט אור, הרבה גילויים. חשוב: אם המשתמש אמר שסיים משהו - תעמיק על המשמעות של ההישג, אל תחזור על אותה שאלה. תמיד בעברית, תמיד עמוק, תמיד מסקרן.`,
  },
};

const GREETINGS: Record<string, string> = {
  coach: `🧠 המאמן כאן.\nבלי פתיחות, בלי חימום. מה המטרה שלך היום ולמה עוד לא התחלת?`,
  cynic: `😈 אה, שוב אתה. טוב.\nאז מה קורה, ספר לי מה ה"בעיה" הגדולה של היום.`,
  friend: `🤗 אחי, שמח שכתבת!\nבא ספר - מה קורה אצלך? ואל תגיד "הכל בסדר" כי אני מכיר אותך.`,
  sergeant: `🪖 יאללה, מה הסיטואציה?\nתתייצב ותדווח. קצר וענייני.`,
  therapist: `🛋️ שלום. שמח שבחרת לדבר.\nאני כאן, אין מהירות. במה תרצה להתחיל?`,
  hype: `🔥🔥🔥 כן כן כן!!! הגעת!!!\nכבר מתרגש! יאללה ספר לי הכל - אני כבר כולי אש!!!`,
  grandma: `👵 אוי, מה נעים מה נעים!\nאכלת היום? לא קר לך? תן לסבתא לדעת מה קורה.`,
  philosopher: `🧐 בחרת לדבר. מעניין.\nאבל השאלה האמיתית היא - למה עכשיו? מה הביא אותך לכאן ברגע הזה דווקא?`,
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
        { text: "🪖 הרס\"ר", callback_data: "personality_sergeant" },
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
  const systemPrompt = `${personality.prompt}\n\nהקשר על המשתמש: ${context}\n\nחשוב מאוד: אתה משוחח בשיחה אמיתית וזורמת בעברית. אל תישמע כמו רובוט, אל תחזור על אותם ביטויים, אל תסיים כל משפט באותה צורה. הגב כמו אדם אמיתי עם אישיות חדה. אל תפנה לפקודות אלא אם המשתמש מבקש ספציפית. אם המשתמש אמר שהוא כבר עשה משהו מהתזכורות - תאמין לו ואל תמשיך להציק על אותו דבר.`;

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
        max_tokens: 500,
        temperature: 1.1,
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
    `שלום ${firstName}! 👋\nאני הבוט שיעזור לך לזכור מה אתה צריך לעשות - ולהציק לך עד שתעשה את זה 😈\n\nאבל קודם - בחר את מי אתה רוצה שידבר איתך:`,
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
  const keyboard: object[][] = [];
  reminders.forEach((r, i) => {
    msg += `${i + 1}. ${r.text}\n   🕐 ${r.time} | ${typeLabels[r.type] ?? r.type}\n\n`;
    keyboard.push([{ text: `✅ סיימתי: ${r.text.slice(0, 25)}`, callback_data: `done_reminder_${r.id}` }]);
  });

  await sendMessage(chatId, msg, { inline_keyboard: keyboard });
}

// זיהוי אם המשתמש מתכוון לתזכורת ספציפית
async function checkAndOfferCloseReminder(
  chatId: number,
  userText: string,
  personality: string
): Promise<boolean> {
  const { data: reminders } = await supabase
    .from("reminders")
    .select("*")
    .eq("chat_id", chatId)
    .eq("active", true);

  if (!reminders || reminders.length === 0) return false;

  // מציאת תזכורת רלוונטית לפי מילים משותפות
  const lower = userText.toLowerCase();
  const matched = reminders.find((r) => {
    const words = r.text.toLowerCase().split(/\s+/);
    return words.some((w: string) => w.length > 2 && lower.includes(w));
  });

  if (matched) {
    // המשתמש אמר שסיים משהו שקשור לתזכורת — מציעים לסגור
    await sendMessage(
      chatId,
      `רגע — זה קשור לתזכורת שלך: "${matched.text}"?\nאם סיימת, תלחץ כדי לסגור אותה 👇`,
      {
        inline_keyboard: [
          [
            { text: "✅ כן, סיימתי!", callback_data: `done_reminder_${matched.id}` },
            { text: "לא, המשך", callback_data: "dismiss_offer" },
          ],
        ],
      }
    );
    return true;
  }

  return false;
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
        const reply = await askGroq("המשתמש סיים את המטלה! תגיב בהתאם לאישיות שלך - אמיתי, ספייסי, לא גנרי.", user.personality as string, "");
        await sendMessage(chatId, reply);
      } else if (data === "dismiss_offer") {
        // המשתמש דחה את ההצעה לסגור תזכורת — ממשיכים בשיחה רגילה
        await sendMessage(chatId, "אוקיי, ממשיכים 👍");
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
      // בדיקה אם המשתמש אומר שסיים משהו
      if (detectDoneKeyword(text)) {
        const offered = await checkAndOfferCloseReminder(chatId, text, user.personality as string);
        if (offered) {
          // הצענו לסגור — לא שולחים תגובת AI נוספת כדי לא להציף
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
      }

      // שיחה רגילה עם AI
      const activeReminders = await supabase
        .from("reminders")
        .select("text, time, type")
        .eq("chat_id", chatId)
        .eq("active", true);

      const context = activeReminders.data?.length
        ? `למשתמש יש תזכורות פעילות: ${activeReminders.data.map((r) => r.text).join(", ")}. אם המשתמש אמר שהוא כבר עשה אחת מהן - תאמין לו ואל תמשיך להציק על אותה תזכורת.`
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
