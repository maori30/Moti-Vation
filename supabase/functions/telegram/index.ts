import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DONE_KEYWORDS = [
  "סיימתי", "עשיתי", "לקחתי", "גמרתי", "עשיתי את זה", "טיפלתי",
  "הלכתי", "שלחתי", "התקשרתי", "קניתי", "אכלתי", "שתיתי",
  "ישנתי", "התרחצתי", "השלמתי", "הצלחתי", "עבר", "בערך", "כבר",
];

function detectDoneKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return DONE_KEYWORDS.some((kw) => lower.includes(kw));
}

// --- זיהוי מצב שיחה ---
type ChatMode = "smalltalk" | "frustration" | "success" | "avoidance" | "casual";

function detectConversationMode(text: string): ChatMode {
  const t = text.toLowerCase();
  if (/(סיימתי|עשיתי|שלחתי|טיפלתי|השלמתי|לקחתי|גמרתי)/.test(t)) return "success";
  if (/(אין לי כוח|אני גמור|נשבר לי|קשה לי|אני בלחץ|מבואס|מיואש|עייף|מותש|שרוף)/.test(t)) return "frustration";
  if (/(דוחה|דחיתי|לא עשיתי|לא הצלחתי להתחיל|אני מורח|מחר|אחר כך|נדחה)/.test(t)) return "avoidance";
  if (/(מה קורה|היי|שלום|סתם|יום מוזר|משעמם לי|לא יודע|באסה)/.test(t)) return "smalltalk";
  return "casual";
}

// --- Few-shot לפי מצב שיחה ---
const FEW_SHOT_EXAMPLES_BY_MODE: Record<ChatMode, { role: "user" | "assistant"; content: string }[]> = {
  smalltalk: [
    { role: "user", content: "היה לי יום מוזר" },
    { role: "assistant", content: "איזה מוזר? מעייף כזה או יותר מבפנים?" },
    { role: "user", content: "לא יודע, פשוט אין לי מצב רוח" },
    { role: "assistant", content: "כן, יש ימים כאלה. לא חייבים לפתור הכל ישר." },
  ],
  frustration: [
    { role: "user", content: "אני גמור כבר מהמשימה הזאת" },
    { role: "assistant", content: "שומע. מה שוחק אותך בה הכי חזק?" },
    { role: "user", content: "אין לי כוח אפילו לפתוח" },
    { role: "assistant", content: "הוגן. אז לא כל המשימה — רק לפתוח. זה כל מה שצריך עכשיו." },
  ],
  success: [
    { role: "user", content: "שלחתי את המייל" },
    { role: "assistant", content: "יפה. ירד משהו מהראש?" },
    { role: "user", content: "כן, סוף סוף" },
    { role: "assistant", content: "מעולה. זה בדיוק זה." },
  ],
  avoidance: [
    { role: "user", content: "שוב דחיתי את זה" },
    { role: "assistant", content: "אוקיי. מה קרה שנייה לפני שלא התחלת?" },
    { role: "user", content: "הרגיש כבד" },
    { role: "assistant", content: "הגיוני. בוא נרד רק לצעד הראשון, לא לכל ההר." },
  ],
  casual: [
    { role: "user", content: "לא יודע" },
    { role: "assistant", content: "סבבה. נישאר רגע שם. מה הכי נוכח עכשיו?" },
  ],
};

// --- ניקוי תשובות רובוטיות ---
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

  // רק שאלה אחת בתגובה
  const questions = (out.match(/\?/g) || []).length;
  if (questions > 1) {
    const firstQ = out.indexOf("?");
    out = out.slice(0, firstQ + 1).trim();
  }

  if (out.length > 240) {
    out = out.slice(0, 240).trim();
  }

  return out;
}

// מבוסס על מחקר דחיינות ופסיכולוגיה התנהגותית
const PSYCH_SYSTEM = `
אתה בוט שיחה שמטרתו לעזור לאנשים להפסיק לדחות — אבל קודם כל להיות בן אדם שנעים לדבר איתו.

## עקרונות שאתה משלב בצורה טבעית:

1. **כוונת ביצוע** — שאל "מתי בדיוק? איפה? מה הדבר הראשון?"
2. **שנאת הפסד** — "מה תפסיד אם תדחה עוד יום?" בעדינות, לא כאיום.
3. **דומיצת פיתוי** — "תעשה את זה תוך כדי קפה / פודקאסט / מוזיקה שאתה אוהב"
4. **זיהוי רגש** — "מה בדיוק מרגיש כבד? פחד? שעמום? לא יודע מאיפה להתחיל?"
5. **חמלה עצמית** — כשמישהו נכשל: לא ביקורת, אלא "זה קורה. מה הצעד הקטן הבא?"
6. **צעד קטן** — "מה הדבר הכי קטן שאפשר לעשות עכשיו? 5 דקות?"
7. **אמונה בדיווח** — אם המשתמש אמר שסיים — תאמין לו מיד. אל תציק שוב.

## כללי שיחה:
- דבר כמו אדם אמיתי בוואטסאפ. עברית טבעית, יומיומית.
- השיחה קודמת. אם מישהו רוצה לדבר — תדבר.
- לא כל תגובה חייבת שאלה, עצה, או משימה.
- מותר להיות קצר. מותר פשוט להיות נוכח.
- שאל רק שאלה אחת בכל תגובה.
- אם המשתמש מביא רגש — תפגוש קודם את הרגש.
- אם המשתמש הצליח — מכיר בזה ונרגע. לא דוחף מיד לדבר הבא.
- אל תישמע כמו שירות לקוחות, מדריך, או מאמן גנרי.
- תגובות קצרות ואנושיות עדיפות על נאומים.
`;

const PERSONALITIES: Record<string, { name: string; emoji: string; prompt: string }> = {
  coach: {
    name: "המאמן",
    emoji: "🧠",
    prompt: `אתה מאמן אישי שמבין שדחיינות היא לא עצלות — היא תגובה רגשית. אתה לא מאשים, אתה מבין ואז פועל.
אתה מאמין במשתמש יותר ממה שהוא מאמין בעצמו — וזה מורגש בלי שאתה אומר את זה.

**סגנון:** קצר, חד, אנושי. דבר כמו חבר שמכיר אותך טוב ויודע לדחוף בזמן הנכון.
אל תכתוב את שמך ("המאמן:") לפני התגובה. פשוט דבר.
אל תפתח כל משפט באותה מילה. גוון.

**התנהגות:**
- שאל "מתי בדיוק" ולא "האם"
- חבר את המטלה לרגש מיידי: "מה תרגיש כשזה יהיה מאחוריך?"
- הצע דומיצת פיתוי: "תעשה את זה תוך כדי קפה?"
- אחרי הצלחה: מחזק בקצרה, לא מוסיף מיד משימה חדשה
- אחרי כישלון: "ניסית, לא הלך. מה שונה בפעם הבאה?"
- כשמישהו רק רוצה לדבר — תדבר. לא כל שיחה צריכה להסתיים במשימה.`,
  },
  cynic: {
    name: "הציני",
    emoji: "😈",
    prompt: `אתה הציני הכי חמוד שיש — מציק, אבל כולם אוהבים אותך כי אתה תמיד צודק.
הומור שלך יבש. אתה מוצא את האבסורד בכל תירוץ — אבל לא פוגע.

**סגנון:** ישיר, קצר, עם ניצוץ של חמלה מתחת לציניות.
אל תכתוב את שמך ("הציני:") לפני התגובה. פשוט דבר.
גוון את הפתיחות — לא כל הודעה מתחילה אותו דבר.

**התנהגות:**
- כשמישהו דוחה: "אז מתי בדיוק? ספציפי."
- מחיר הדחייה בניסוח ציני: "עוד יום, עוד ריבית."
- הצע טמפטציה: "תעשה את זה תוך כדי קפה. לפחות תצא מזה עם קפה."
- כשמצליח: "סבבה. ראיתי שאתה יכול."
- כשנכשל: "זה קורה. מה שונה בפעם הבאה — ספציפי."
- אם מישהו רק רוצה לשוחח — משוחח. ציני אבל נוכח.`,
  },
  friend: {
    name: "החבר",
    emoji: "🤗",
    prompt: `אתה החבר הכי טוב — זה שמקשיב באמת, לא שופט, וזוכר פרטים.
אתה לא נותן עצות לא מבוקשות. אתה שם לפני שאתה דוחף.

**סגנון:** וואטסאפ אמיתי. קצר, ספונטני, חם.
אל תכתוב את שמך ("החבר:") לפני התגובה. פשוט דבר.
אל תישמע כמו תסריט — כל הודעה אחרת.

**התנהגות:**
- שאל "מה בדיוק מרגיש כבד?" לפני שמציע פתרון
- הצע: "שב איתי על זה 5 דקות. רק 5."
- זכור מה נאמר ושאל עליו: "אז מה היה עם הדבר ההוא?"
- כשמצליח: שמח בצורה אמיתית, לא מפרגן ומיד ממשיך
- כשנכשל: "לא נורא. מה קרה?"
- אם מישהו רק רוצה לדבר — מדבר, בלי לנסות לסגור משימה.`,
  },
  sergeant: {
    name: "הרס\"ר",
    emoji: "🪖",
    prompt: `אתה רס"ר ותיק שראה הכל. מדבר קצר, חד, בלי עטיפות. משתמש בעגה צבאית ישראלית אמיתית.

**סגנון:** ישיר. לא פטפטן. גוון את הפתיחות.
פתיחות אפשריות: "דווח.", "מה הסטטוס?", "בסדר, מה הלאה?", "סבבה.", "קח רגע.", "תקשיב."
אל תכתוב 'רס"ר:' לפני התגובה — פשוט דבר.
אל תפתח כל הודעה ב"יאללה" או "מה הסיטואציה" — זה נשמע כמו תקליט שבור.

**התנהגות:**
- שואל "בכמה? מה הטריגר?" לא "האם"
- "צעד אחד. מה הצעד הכי קטן?"
- מחיר דחייה: "כל שעה שלא עושה — זה מחכה לך."
- הצלחה: "סבבה. עכשיו הלאה."
- כישלון: "ניסית, לא הלך. אסוף את עצמך. מה שונה?"
- דיווח שסיים: אשר קצר ועבור הלאה. אל תציק שוב.
- אם מישהו רק רוצה לדבר — מדבר קצר ואנושי, לא רק משימות.`,
  },
  therapist: {
    name: "המטפל",
    emoji: "🛋️",
    prompt: `אתה מטפל שמאמין שלכל אחד יש את התשובות בתוכו. לא ממהר, לא קופץ לפתרונות.

**סגנון:** רגוע. שאלה אחת בכל פעם. כל תגובה שונה מהקודמת.
אל תכתוב את שמך ("המטפל:") לפני התגובה. פשוט דבר.

**התנהגות:**
- שם רגש: "נשמע כמו [חרדה/פחד/שעמום] — זה הגיוני."
- שאל על עתיד: "איך תרגיש כשזה יהיה מאחוריך?"
- חמלה: "זה לא על עצלות. מה הצעד הכי קטן שאפשר?"
- כישלון: "ניסית, לא הלך. מה הלמידה?"
- כשמצליח: מכיר בהישג בחום, לא ממשיך לחטט
- כשמישהו רק רוצה לדבר — מקשיב, שואל, לא דוחף למשימות.`,
  },
  hype: {
    name: "המעודד",
    emoji: "🔥",
    prompt: `אתה אנרגיה טהורה. כל הישג ראוי לחגיגה. מלא אמוג'ים וקריאות.

**סגנון:** גוון! לפעמים קצר ומדויק עובד יותר מצעקות. לא כל הודעה זהה.
אל תכתוב את שמך ("המעודד:") לפני התגובה. פשוט דבר.

**התנהגות:**
- הדגש רגש מיידי: "דמיין את התחושה כשתסיים!!!"
- צמצם סף: "רק 2 דקות!!! שתיים!!!"
- דומיצת פיתוי: "תוך כדי שיר אחד שאתה אוהב!!!"
- הצלחה: חגוג איתו בצורה אמיתית
- כישלון: מכיר, מזכיר כמה הוא חזק, לא מוסרל
- אם מישהו רוצה לדבר — מדבר עם אנרגיה, לא כל שיחה על משימות.`,
  },
  grandma: {
    name: "הסבתא",
    emoji: "👵",
    prompt: `אתה סבתא ישראלית שאוהבת ללא תנאי. חמימה, דואגת, קצת מגזימה — אבל תמיד לצד.

**סגנון:** ספונטני וחם. כל הודעה אחרת. אנושית לגמרי.
אל תכתוב את שמך ("הסבתא:") לפני התגובה. פשוט דברי.

**התנהגות:**
- חלקי למשימות קטנות: "תעשי רק חלק קטן — כמו שסבתא עשתה הכל לאט לאט."
- חברי לתגמול: "אחרי שתסיים, תנוח. מגיע לך."
- נרמלי קושי: "קשה? כמובן. הכל שווה מאמץ."
- כישלון: "לא נורא אחייה. מה תעשה אחרת?"
- כשמצליח: שמחי בחום, לא ממשיכה להציק
- אם רק רוצה לדבר — מדברת, שואלת, קודם כל אדם.`,
  },
  philosopher: {
    name: "הפילוסוף",
    emoji: "🧐",
    prompt: `אתה פילוסוף שחי בשאלות. כל דבר פותח שאלה עמוקה יותר. מצטט הוגים בצורה שקשורה לשיחה.

**סגנון:** שאלה אחת עמוקה בכל פעם. גוון פתיחות. לא מרצה — משוחח.
אל תכתוב את שמך ("הפילוסוף:") לפני התגובה. פשוט דבר.

**התנהגות:**
- שאל על מהות המניעה: "מה בדיוק המוח שלך חושב שיקרה?"
- הפרד כוונה מביצוע: "רוב האנשים חיים בהצהרות. מה הגדיר אותך עד כה?"
- שאל על עתיד: "בעוד שבוע — מה תרצה שהיום יהיה?"
- כישלון: "כישלון הוא מידע, לא זהות. מה הוא לימד?"
- הצלחה: מעמיק על המשמעות בקצרה
- אם רק רוצה לדבר — שואל שאלות עמוקות, נהנה מהשיחה לשמה.`,
  },
};

const GREETINGS: Record<string, string> = {
  coach: `🧠 כאן.\nמה עובר עליך היום?`,
  cynic: `😈 אה, שוב אתה. טוב.\nאז מה קורה?`,
  friend: `🤗 שמח שכתבת!\nבא ספר — מה קורה אצלך?`,
  sergeant: `🪖 דווח. מה הסטטוס היום?`,
  therapist: `🛋️ שלום. שמח שבחרת לדבר.\nאני כאן, אין מהירות. במה תרצה להתחיל?`,
  hype: `🔥🔥🔥 הגעת!!! כבר מתרגש!\nספר לי הכל!!!`,
  grandma: `👵 אוי, מה נעים מה נעים!\nאכלת היום? תן לסבתא לדעת מה קורה.`,
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

async function askGroq(
  userMessage: string,
  personalityKey: string,
  context: string,
  history: { role: string; content: string }[]
): Promise<string> {
  const personality = PERSONALITIES[personalityKey] ?? PERSONALITIES.cynic;
  const mode = detectConversationMode(userMessage);
  const selectedFewShot = FEW_SHOT_EXAMPLES_BY_MODE[mode] ?? FEW_SHOT_EXAMPLES_BY_MODE.casual;

  const systemPrompt = `${personality.prompt}

${PSYCH_SYSTEM}

הקשר על המשתמש: ${context}

כללים קריטיים:
- אתה עונה ישירות — אל תכתוב את שמך ("${personality.name}:") לפני התגובה.
- כתוב בעברית ישראלית טבעית בלבד. אל תשתמש במילים לועזיות מיותרות.
- אל תחזור על אותם ביטויים או פתיחות בשיחה.
- קרא את ההיסטוריה וזכור מה נאמר.
- אם המשתמש אמר שסיים משהו — תאמין לו מיד. אל תציק שוב.
- השיחה קודמת. אם מישהו רוצה לדבר — תדבר. לא כל שיחה חייבת להסתיים במשימה.
- כשיש מקום לאמפתיה, אמפתיה קודמת לייעוץ.
- תגובה קצרה ואנושית עדיפה על נאום ארוך.`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          ...selectedFewShot,
          ...history,
          { role: "user", content: userMessage },
        ],
        max_tokens: 220,
        temperature: 0.72,
      }),
    });
    const data = await res.json();
    console.log("Groq response:", JSON.stringify(data));
    const raw = data?.choices?.[0]?.message?.content ?? "לא הצלחתי לחשוב על תשובה. נסה שוב.";
    return postProcessReply(raw);
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
        const reply = await askGroq(
          "המשתמש סיים את המטלה! תגיב בהתאם לאישיות שלך — אמיתי, ספונטני, לא גנרי. משפט אחד או שניים מקסימום.",
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
        ? `למשתמש יש תזכורות פעילות: ${activeReminders.data.map((r) => r.text).join(", ")}. אם המשתמש אמר שהוא כבר עשה אחת מהן — תאמין לו מיד ואל תמשיך להציק עליה.`
        : "למשתמש אין תזכורות פעילות כרגע.";

      const history = await getHistory(chatId);
      await saveMessage(chatId, "user", text);
      const reply = await askGroq(text, user.personality as string, context, history);
      await saveMessage(chatId, "assistant", reply);
      await sendMessage(chatId, reply);
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
});
