import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// In-memory ring buffer of recent Gemini errors for the /diag command.
type DiagError = { at: string; status?: number; code?: string; message: string };
const RECENT_ERRORS: DiagError[] = [];
function recordError(e: DiagError) {
  RECENT_ERRORS.unshift({ ...e, at: new Date().toISOString() });
  if (RECENT_ERRORS.length > 5) RECENT_ERRORS.length = 5;
}

function logMissingSecrets() {
  const required = ["TELEGRAM_BOT_TOKEN", "GEMINI_API_KEY", "SUPABASE_URL", "SB_SERVICE_ROLE_KEY"];
  const missing = required.filter((k) => !Deno.env.get(k));
  if (missing.length) console.error(`[secrets] missing: ${missing.join(", ")}`);
  return missing;
}
logMissingSecrets();

const DONE_KEYWORDS = [
  "סיימתי", "עשיתי", "לקחתי", "גמרתי", "עשיתי את זה", "טיפלתי",
  "הלכתי", "שלחתי", "התקשרתי", "קניתי", "אכלתי", "שתיתי",
  "ישנתי", "התרחצתי", "השלמתי", "הצלחתי", "עבר", "בערך", "כבר",
];

function detectDoneKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return DONE_KEYWORDS.some((kw) => lower.includes(kw));
}

type ChatMode = "smalltalk" | "frustration" | "success" | "avoidance" | "casual";

function detectConversationMode(text: string): ChatMode {
  const t = text.toLowerCase();
  if (/(סיימתי|עשיתי|שלחתי|טיפלתי|השלמתי|לקחתי|גמרתי)/.test(t)) return "success";
  if (/(אין לי כוח|אני גמור|נשבר לי|קשה לי|אני בלחץ|מבואס|מיואש|עייף|מותש|שרוף)/.test(t)) return "frustration";
  if (/(דוחה|דחיתי|לא עשיתי|לא הצלחתי להתחיל|אני מורח|מחר|אחר כך|נדחה)/.test(t)) return "avoidance";
  if (/(מה קורה|היי|שלום|סתם|יום מוזר|משעמם לי|לא יודע|באסה)/.test(t)) return "smalltalk";
  return "casual";
}

const FEW_SHOT_EXAMPLES_BY_MODE: Record<ChatMode, { role: "user" | "model"; parts: { text: string }[] }[]> = {
  smalltalk: [
    { role: "user", parts: [{ text: "היה לי יום מוזר" }] },
    { role: "model", parts: [{ text: "איזה מוזר? מעייף כזה או יותר מבפנים?" }] },
    { role: "user", parts: [{ text: "לא יודע, פשוט אין לי מצב רוח" }] },
    { role: "model", parts: [{ text: "כן, יש ימים כאלה. לא חייבים לפתור הכל ישר." }] },
  ],
  frustration: [
    { role: "user", parts: [{ text: "אני גמור כבר מהמשימה הזאת" }] },
    { role: "model", parts: [{ text: "שומע. מה שוחק אותך בה הכי חזק?" }] },
    { role: "user", parts: [{ text: "אין לי כוח אפילו לפתוח" }] },
    { role: "model", parts: [{ text: "הוגן. אז לא כל המשימה — רק לפתוח. זה כל מה שצריך עכשיו." }] },
  ],
  success: [
    { role: "user", parts: [{ text: "שלחתי את המייל" }] },
    { role: "model", parts: [{ text: "יפה. ירד משהו מהראש?" }] },
    { role: "user", parts: [{ text: "כן, סוף סוף" }] },
    { role: "model", parts: [{ text: "מעולה. זה בדיוק זה." }] },
  ],
  avoidance: [
    { role: "user", parts: [{ text: "שוב דחיתי את זה" }] },
    { role: "model", parts: [{ text: "אוקיי. מה קרה שנייה לפני שלא התחלת?" }] },
    { role: "user", parts: [{ text: "הרגיש כבד" }] },
    { role: "model", parts: [{ text: "הגיוני. בוא נרד רק לצעד הראשון, לא לכל ההר." }] },
  ],
  casual: [
    { role: "user", parts: [{ text: "לא יודע" }] },
    { role: "model", parts: [{ text: "סבבה. נישאר רגע שם. מה הכי נוכח עכשיו?" }] },
  ],
};

function postProcessReply(text: string): string {
  let out = text.trim();
  out = out.replace(/!{2,}/g, "!");
  out = out.replace(/\?{2,}/g, "?");
  out = out.replace(/\s{2,}/g, " ");
  const roboticOpeners = [
    "אני כאן בשבילך",
    "אני מבין אותך",
    "בוא נעשה סדר",
    "אני שומע אותך",
    "אני לגמרי מבין",
  ];
  for (const opener of roboticOpeners) {
    if (out.startsWith(opener)) {
      out = out.replace(opener, "").trim();
    }
  }
  const questions = (out.match(/\?/g) || []).length;
  if (questions > 1) {
    const firstQ = out.indexOf("?");
    out = out.slice(0, firstQ + 1).trim();
  }
  if (out.length > 240) {
    const cutPoint = out.lastIndexOf(".", 240);
    if (cutPoint > 80) {
      out = out.slice(0, cutPoint + 1).trim();
    } else {
      out = out.slice(0, 240).trim();
    }
  }
  return out;
}

const PERSONALITIES: Record<string, { name: string; emoji: string; prompt: string }> = {
  coach: {
    name: "המאמן",
    emoji: "🧠",
    prompt: `אתה מאמן אישי שמבין שדחיינות היא לא עצלות — היא תגובה רגשית.
אתה מאמין במשתמש יותר ממה שהוא מאמין בעצמו.
כתוב עברית ישראלית יומיומית ותקנית. דבר קצר כמו חבר בוואטסאפ. לא נאומים.
שאל רק שאלה אחת בכל תגובה. אם יש רגש — פגוש אותו קודם.
אל תכתוב "המאמן:" לפני התגובה.`,
  },
  cynic: {
    name: "הציני",
    emoji: "😈",
    prompt: `אתה הציני הכי חמוד שיש — מציק, אבל כולם אוהבים אותך כי אתה תמיד צודק.
ישיר, קצר, עם ניצוץ חמלה מתחת לציניות.
כתוב עברית ישראלית יומיומית ותקנית.
אל תכתוב "הציני:" לפני התגובה.`,
  },
  friend: {
    name: "החבר",
    emoji: "🤗",
    prompt: `אתה החבר הכי טוב — מקשיב באמת, לא שופט, זוכר פרטים.
וואטסאפ אמיתי — קצר, ספונטני, חם.
כתוב עברית ישראלית יומיומית ותקנית.
אל תכתוב "החבר:" לפני התגובה.`,
  },
  sergeant: {
    name: "הרס\"ר",
    emoji: "🪖",
    prompt: `אתה רס"ר ותיק שראה הכל. מדבר קצר, חד, בלי עטיפות.
כתוב עברית ישראלית תקנית.
אל תכתוב 'רס"ר:' לפני התגובה.`,
  },
  therapist: {
    name: "המטפל",
    emoji: "🛋️",
    prompt: `אתה מטפל שמאמין שלכל אחד יש את התשובות בתוכו. לא ממהר, לא קופץ לפתרונות.
כתוב עברית ישראלית יומיומית ותקנית.
אל תכתוב "המטפל:" לפני התגובה.`,
  },
  hype: {
    name: "המעודד",
    emoji: "🔥",
    prompt: `אתה אנרגיה טהורה. כל הישג ראוי לחגיגה.
כתוב עברית ישראלית יומיומית ותקנית.
אל תכתוב "המעודד:" לפני התגובה.`,
  },
  grandma: {
    name: "הסבתא",
    emoji: "👵",
    prompt: `אתה סבתא ישראלית שאוהבת ללא תנאי. חמימה, דואגת, קצת מגזימה — אבל תמיד לצד.
כתוב עברית ישראלית יומיומית ותקנית. שימי לב למגדר — דברי בנקבה על עצמך.
אל תכתוב "הסבתא:" לפני התגובה.`,
  },
  philosopher: {
    name: "הפילוסוף",
    emoji: "🧐",
    prompt: `אתה פילוסוף שחי בשאלות. כל דבר פותח שאלה עמוקה יותר.
כתוב עברית ישראלית תקנית.
אל תכתוב "הפילוסוף:" לפני התגובה.`,
  },
};

const GREETINGS: Record<string, string> = {
  coach: `🧠 כאן.\nמה עובר עליך היום?`,
  cynic: `😈 אה, שוב אתה. טוב.\nאז מה קורה?`,
  friend: `🤗 שמח שכתבת!\nבא ספר — מה קורה אצלך?`,
  sergeant: `🪖 דווח. מה הסטטוס היום?`,
  therapist: `🛋️ שלום. שמח שבחרת לדבר.\nאני כאן, אין מהירות. במה תרצה להתחיל?`,
  hype: `🔥🔥🔥 הגעת! כבר מתרגש!\nספר לי הכל!`,
  grandma: `👵 אוי, מה נעים!\nאכלת היום? תן לסבתא לדעת מה קורה.`,
  philosopher: `🧐 בחרת לדבר. מעניין.\nמה הביא אותך לכאן ברגע הזה דווקא?`,
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

async function saveMessage(chatId: number, role: string, content: string) {
  await supabase.from("messages").insert({ chat_id: chatId, role, content });
}

async function getHistory(chatId: number): Promise<{ role: string; content: string }[]> {
  const { data } = await supabase
    .from("messages")
    .select("role, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .limit(20);
  return data ?? [];
}

async function clearHistory(chatId: number) {
  await supabase.from("messages").delete().eq("chat_id", chatId);
}

async function askGemini(
  userMessage: string,
  personalityKey: string,
  context: string,
  history: { role: string; content: string }[]
): Promise<string> {
  const personality = PERSONALITIES[personalityKey] ?? PERSONALITIES.cynic;
  const mode = detectConversationMode(userMessage);
  const selectedFewShot = FEW_SHOT_EXAMPLES_BY_MODE[mode] ?? FEW_SHOT_EXAMPLES_BY_MODE.casual;

  const systemPrompt = `${personality.prompt}

הקשר על המשתמש: ${context}

כללים קריטיים:
- כתוב עברית ישראלית יומיומית ותקנית. שים לב למגדר נכון.
- תגובה קצרה ואנושית. מקסימום 3 משפטים.
- שאל רק שאלה אחת בכל תגובה.
- אם המשתמש אמר שסיים — תאמין לו מיד.
- אם יש רגש — פגוש אותו קודם לפני ייעוץ.`;

  const geminiHistory: { role: "user" | "model"; parts: { text: string }[] }[] = [
    ...selectedFewShot,
    ...history.map((m) => ({
      role: (m.role === "assistant" ? "model" : "user") as "user" | "model",
      parts: [{ text: m.content }],
    })),
  ];

  try {
    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
      console.error("[gemini] missing secret GEMINI_API_KEY");
      recordError({ code: "MISSING_KEY", message: "GEMINI_API_KEY not set in Supabase secrets" });
      return "אין לי כרגע חיבור למוח. תגיד למאורי לבדוק את GEMINI_API_KEY.";
    }
    const contents = [
      ...geminiHistory,
      { role: "user" as const, parts: [{ text: userMessage }] },
    ];
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { temperature: 0.75, maxOutputTokens: 220 },
        }),
      },
    );
    if (!res.ok) {
      const errText = await res.text();
      let apiCode: string | undefined;
      try {
        const j = JSON.parse(errText);
        apiCode = j?.error?.status || j?.error?.code?.toString();
      } catch { /* not json */ }
      console.error(`[gemini] http ${res.status} ${apiCode ?? ""} body=${errText.slice(0, 500)}`);
      recordError({ status: res.status, code: apiCode, message: errText.slice(0, 300) });
      return "המוח שלי תקוע רגע. תנסה שוב עוד שנייה.";
    }
    const data = await res.json();
    if (data?.promptFeedback?.blockReason) {
      console.error(`[gemini] blocked: ${data.promptFeedback.blockReason}`);
      recordError({ code: "BLOCKED", message: data.promptFeedback.blockReason });
    }
    const raw =
      data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ||
      "לא הצלחתי לחשוב על תשובה. נסה שוב.";
    return postProcessReply(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[gemini] exception: ${msg}`);
    recordError({ code: "EXCEPTION", message: msg });
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
  await clearHistory(chatId);
  await sendMessage(
    chatId,
    `שלום ${firstName}! 👋\nאני פה כדי לעזור לך לזכור דברים, לזוז עם מה שחשוב לך, וגם פשוט לדבר כשצריך.\n\nאבל קודם — בחר את מי אתה רוצה שידבר איתך:`,
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
  await sendMessage(
    chatId,
    `✅ תזכורת נוספה!\n📝 ${reminderText}\n🕐 ${timeText}\n🔁 ${typeLabels[type] ?? type}\n\nאני אזכיר לך בזמן.`
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
  const keyboard: object[][] = [];
  reminders.forEach((r, i) => {
    msg += `${i + 1}. ${r.text}\n   🕐 ${r.time} | ${typeLabels[r.type] ?? r.type}\n\n`;
    keyboard.push([{ text: `✅ סיימתי: ${r.text.slice(0, 25)}`, callback_data: `done_reminder_${r.id}` }]);
  });

  await sendMessage(chatId, msg, { inline_keyboard: keyboard });
}

async function checkAndOfferCloseReminder(
  chatId: number,
  userText: string,
  _personality: string
): Promise<boolean> {
  const { data: reminders } = await supabase
    .from("reminders")
    .select("*")
    .eq("chat_id", chatId)
    .eq("active", true);

  if (!reminders || reminders.length === 0) return false;

  const lower = userText.toLowerCase();
  const matched = reminders.find((r) => {
    const words = r.text.toLowerCase().split(/\s+/);
    return words.some((w: string) => w.length > 2 && lower.includes(w));
  });

  if (matched) {
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
        await clearHistory(chatId);
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
        await sendMessage(chatId, `${pEmoji} ${pName} כאן.\nדבר איתי חופשי.\n(שלח /menu לתפריט)`);
      } else if (data.startsWith("reminder_type_")) {
        const type = data.replace("reminder_type_", "");
        await handleReminderType(chatId, type);
      } else if (data.startsWith("done_reminder_")) {
        const reminderId = data.replace("done_reminder_", "");
        await supabase.from("reminders").update({ active: false }).eq("id", reminderId);
        const history = await getHistory(chatId);
        const reply = await askGemini(
          "המשתמש סיים את המטלה! תגיב בהתאם לאישיות שלך — אמיתי, ספונטני, לא גנרי.",
          user.personality as string,
          "",
          history
        );
        await sendMessage(chatId, reply);
      } else if (data === "dismiss_offer") {
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
    } else if (text === "/diag") {
      await handleDiag(chatId);
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
      if (detectDoneKeyword(text)) {
        const offered = await checkAndOfferCloseReminder(chatId, text, user.personality as string);
        if (offered) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
      }

      const activeReminders = await supabase
        .from("reminders")
        .select("text, time, type")
        .eq("chat_id", chatId)
        .eq("active", true);

      const context = activeReminders.data?.length
        ? `למשתמש יש תזכורות פעילות: ${activeReminders.data.map((r) => r.text).join(", ")}.`
        : "למשתמש אין תזכורות פעילות כרגע.";

      const history = await getHistory(chatId);
      await saveMessage(chatId, "user", text);
      const reply = await askGemini(text, user.personality as string, context, history);
      await saveMessage(chatId, "assistant", reply);
      await sendMessage(chatId, reply);
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
});
