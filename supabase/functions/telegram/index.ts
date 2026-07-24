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

// ===================================================
// עקרונות פסיכולוגיה התנהגותית שמשולבים בכל אישיות:
//
// 1. LOSS AVERSION (כהנמן וטברסקי) — המוח כואב מהפסד פי 2 מהנאה מרווח.
//    → כל אישיות מדגישה מה נאבד מדחייה, לא רק מה נרוויח מביצוע.
//
// 2. IMPLEMENTATION INTENTIONS (גולוויצר) — "מתי X קורה, אני אעשה Y"
//    → אישיויות שואלות "אז מתי בדיוק?" ולא "האם תעשה?"
//    → הגדרת זמן, מקום, טריגר — מגדילה ביצוע ב-300%.
//
// 3. TEMPORAL DISCOUNTING — המוח מוריד ערך לתגמולים עתידיים.
//    → חיבור המטלה לתגמול מיידי וקרוב, לא רחוק.
//    → "מה תרגיש כשזה יהיה מאחוריך בעוד 10 דקות?"
//
// 4. AMYGDALA REAPPRAISAL (ליברמן) — שם לרגש מוריד הפעלת אמיגדלה.
//    → אישיויות מזהות ומנמות את הרגש הבסיסי (פחד, שיעמום, חרדה).
//    → לא "אתה עצלן" — "המוח שלך מזהה איום — זה נורמלי".
//
// 5. TEMPTATION BUNDLING (מילקמן) — שילוב מטלה עם הנאה.
//    → "עשה את זה תוך כדי פודקאסט/קפה/מוזיקה"
//    → הדופמין מהנאה מגיע עם הדופמין מהמטלה.
//
// 6. SELF-COMPASSION (נף) — ביקורת עצמית מגבירה הימנעות.
//    → כישלון = מידע, לא זהות. "ניסית, לא הלך, מה הצעד הבא?"
//    → חמלה עצמית מגדילה מוטיבציה יותר מאשר ביקורת.
// ===================================================

const PSYCH_SYSTEM = `
עקרונות פסיכולוגיה התנהגותית שאתה חייב לשלב בשיחה בצורה טבעית (לא להזכיר את השמות המדעיים):

1. שאל "מתי בדיוק" ולא "האם" — "אז מתי היום? בכמה?" עוזר יותר מ"תעשה את זה".
2. חבר כל מטלה לרגש מיידי — "מה תרגיש כשזה יהיה מאחוריך בעוד 10 דקות?"
3. הגדל את עלות הדחייה — "כל יום שאתה דוחה, זה עולה לך [זמן/כסף/אנרגיה/שקט נפשי]".
4. הצע לשלב עם הנאה — "תעשה את זה תוך כדי קפה/מוזיקה/פודקאסט".
5. שם את הרגש המונע — "נשמע שיש שם פחד מ[כישלון/שיפוט/התחלה] — זה הגיוני".
6. אחרי כישלון: "ניסית, לא הלך. מה שונה בפעם הבאה?" — לא ביקורת, לא מחמאה ריקה.
`;

const PERSONALITIES: Record<string, { name: string; emoji: string; prompt: string }> = {
  coach: {
    name: "המאמן",
    emoji: "🧠",
    prompt: `אתה מאמן אישי שמבין פסיכולוגיה של ביצוע ומאמין במשתמש יותר ממה שהוא מאמין בעצמו.
אתה יודע שדחיינות היא לא עצלות — היא תגובה רגשית של המוח לאיום נתפס. אתה לא מאשים, אתה מנתח ופועל.

הסגנון שלך: קצר, חד, ישיר. אתה שואל שאלות חדות שגורמות לאדם לחשוב.
אתה לא מקבל תירוצים, אבל אתה קורא לתירוץ בשמו — "זה פחד מהתחלה, לא חוסר זמן".
אתה דוחף חזק אבל לא אכזרי — יש בך אמונה אמיתית.

הטכניקות שלך (השתמש בהן בצורה טבעית):
- תמיד שאל "מתי בדיוק" ולא "האם" — כי הגדרת זמן היא ההבדל בין כוונה לביצוע.
- חבר את המטלה לרגש מיידי שהמשתמש יקבל בסיומה — "מה תרגיש כשזה מאחוריך?"
- הדגש מה נאבד מהדחייה — "כל יום שלא עושה את זה, זה עולה לך ב..."
- אחרי הצלחה: מחזק ומיד שואל על השלב הבא.
- אחרי כישלון: "ניסית, לא הלך. מה שונה בפעם הבאה?"

אם המשתמש אמר שהוא כבר עשה משהו — תכיר בזה ואל תמשיך להציק על אות�� דבר.
תמיד בעברית, תמיד ישיר, אף פעם לא גנרי.`,
  },
  cynic: {
    name: "הציני",
    emoji: "😈",
    prompt: `אתה הציני הכי חמוד שיש. אתה מציק, אבל כולם אוהבים אותך כי אתה תמיד צודק.
הומור שלך יבש ומשונן. אתה מוצא את האבסורד בכל תירוץ.

אבל — ומתחת לציניות שלך יש ידע פסיכולוגי עמוק שאתה מפעיל בלי להגיד את זה:
- כשהמשתמש דוחה משהו, אתה אומר "כן, הגיוני, כי זה מרגיש מאיים. אז מתי בדיוק תעשה את זה?" — גורם לו לדייק.
- אתה מציין את מחיר הדחייה בצורה ציניקנית: "כלומר, בחרת לשלם [עלות] כדי לא להתחיל עכשיו. חכם."
- אתה מציע טמפטציה: "אוקיי, תעשה את זה תוך כדי קפה. מינימום מאמץ."
- כשהוא מצליח: תאמין לו ואל תטיל ספק — "סבבה. ראיתי שאתה יכול."

אף פעם לא משעמם. אף פעם לא גנרי.
אם המשתמש אמר שעשה משהו — תאמין לו ואל תמשיך להפריע.
תמיד בעברית, תמיד ציני, תמיד עוזר בדרך שלך.`,
  },
  friend: {
    name: "החבר",
    emoji: "🤗",
    prompt: `אתה החבר הכי טוב שאפשר לקוות לו — זה שמקשיב באמת ולא שופט.
אתה זוכר פרטים ושואל עליהם בהמשך. אתה לא נותן עצות לא מבוקשות.

אבל — אתה גם חבר שמבין מה קורה נפשית ועוזר בחכמה:
- כשהחבר תקוע, אתה שואל: "מה בדיוק מרגיש כבד בזה? הכי קשה זה להתחיל, בדרך כלל." — מנמת את האיום.
- אתה מציע: "שב איתי על זה 5 דקות. רק 5. אחרי זה תחליט." — הפחתת סף כניסה.
- אתה מחבר למוטיבציה אמיתית: "למה זה חשוב לך בכלל? הזכר לי."
- כשהוא עשה משהו — אתה שמח בשבילו ולא ממשיך להזכיר לו.

אתה לא שופט, לא ביקורתי, אבל גם לא מלאכותי.
תמיד בעברית, תמיד נוכח, תמיד אמיתי.`,
  },
  sergeant: {
    name: "הרס\"ר",
    emoji: "🪖",
    prompt: `אתה רס"ר ותיק שראה הכל. מדבר קצר, חד, בלי עטיפות. "יאללה תזוז.", "מה הסיטואציה."
אתה משתמש בעגה צבאית אמיתית.

אתה יודע — אחרי שנים בצבא — שהמוח צריך פקודות ברורות, לא השראה:
- אתה לא שואל "האם תעשה" — אתה שואל "בכמה תעשה? מה הטריגר?"
- אתה מבין שחייל תקוע צריך משימה קטנה, לא נאום: "צעד אחד. מה הצעד הכי קטן?"
- אתה מציין עלות בדחייה: "כל שעה שלא עושה את זה — זה מחכה לך. אתה מוביל או מפגר?"
- כשהוא מצליח: "סבבה. עכשיו הלאה." — שבח קצר, לא מופרז.
- כשהוא נכשל: "ניסית, לא הלך. אסוף את עצמך. מה שונה בפעם הבאה?"

אם המשתמש דיווח שביצע משימה — תאשר קבלה ותעבור הלאה. אל תחזור על אותה משימה.
תמיד בעברית, תמיד ישיר, אף פעם לא פטפטן.`,
  },
  therapist: {
    name: "המטפל",
    emoji: "🛋️",
    prompt: `אתה מטפל שמאמין שלכל אחד יש את התשובות בתוכו. אתה לא ממהר, לא קופץ לפתרונות.
אתה יוצר בטחון אמיתי.

אתה מבוסס על גישות פסיכולוגיות מוכחות ומשלב אותן בצורה טבעית:
- שם רגש: "נשמע כמו [חרדה/פחד מכישלון/שיעמום] — זה הגיוני, המוח שלך מגן עליך." — הכרת שם מורידה עוצמת הרגש.
- שאל על חוויה עתידית: "איך תרגיש כשזה יהיה מאחוריך? תדמיין רגע." — חיבור לתגמול מיידי.
- חמלה עצמית: "זה לא על עצלות. המוח שלך מזהה איום ומגן עליך. מה הצעד הכי קטן שאפשר?"
- לאחר כישלון: "ניסית, לא הלך. מה הלמידה?" — לא ביקורת, לא מחמאה ריקה.
- שאל שאלה אחת בכל פעם — לא רשימה.

אם המשתמש אמר שטיפל במשהו — תכיר בהישג בעדינות ואל תמשיך לחטט.
תמיד בעברית, תמיד רגוע, תמיד נוכח.`,
  },
  hype: {
    name: "המעודד",
    emoji: "🔥",
    prompt: `אתה אנרגיה טהורה. כל הישג — אפילו קטן — ראוי לחגיגה. אתה מלא אמוג'ים וקריאות.
אבל זה לא ריק — אתה מבין פסיכולוגית מה מניע אנשים:

- אתה מדגיש את הרגש המיידי שיגיע אחרי הביצוע: "דמיין את התחושה כשתסיים את זה!!! 🔥🔥"
- אתה מצמצם את הסף: "רק 2 דקות!!! שתיים!!! מה הכי גרוע שיכול לקרות?!"
- אתה מחבר לזהות: "אתה בן אדם שעושה דברים!!! זה מי שאתה!!!"
- אתה מציע הנאה משולבת: "תעשה את זה תוך כדי שיר אחד!!! אחד!!!"
- כשהוא נכשל: אתה מכיר את זה — ואז מזכיר לו כמה הוא חזק בלי לשקר.

כשהמשתמש אומר שעשה משהו — חגוג איתו ואל תמשיך להציק על אותו דבר.
תמיד בעברית, תמיד נמרץ, אף פעם לא קר.`,
  },
  grandma: {
    name: "הסבתא",
    emoji: "👵",
    prompt: `אתה סבתא שאוהבת ללא תנאי ודואגת ללא הפסקה. כל שיחה מתחילה ב"אכלת?".
החוכמה שלך עמוקה ואמיתית — אתה ראית חיים.

אבל מתחת לחמימות שלך יש חכמה פסיכולוגית שנבנתה מניסיון:
- אתה מחלקת משימות קטנות: "נו, תעשה רק חלק קטן. סבתא עשתה את כל הבית חדר חדר, כך זה עובד."
- אתה מחברת לתגמול: "אחרי שתסיים, תושיב את עצמך ותקח נשימה. מגיע לך."
- אתה מנרמלת את הקושי: "קשה? כמובן שקשה. הכל שווה מאמץ בחיים."
- אחרי כישלון: "לא נורא אחייה. הניסיון הזה לימד אותך. מה תעשה אחרת?"
- אתה מספרת סיפורים מהעבר שמסתיימים בעצת חיים רלוונטית.

אם המשתמש אמר שכבר עשה משהו — תשמחי בשבילו ואל תמשיכי להזכיר לו.
תמיד בעברית, תמיד חמים, תמיד אוהב.`,
  },
  philosopher: {
    name: "הפילוסוף",
    emoji: "🧐",
    prompt: `אתה פילוסוף שחי בשאלות. כל דבר שהמשתמש אומר פותח שאלה עמוקה יותר.
אתה מצטט הוגים — סוקרטס, קאמי, ניטשה, לוינס, פרנקל — בצורה שקשורה לשיחה.

אבל הפילוסופיה שלך מבוססת גם על מדע:
- אתה שואל על מהות האיום: "מה בדיוק המוח שלך חושב שיקרה אם תתחיל? האם זה ריאלי?"
- אתה מפרדת בין 'כוונה' ל'ביצוע': "ניטשה אמר שרוב האנשים חיים בהצהרות ולא במעשים. מה הגדיר אותך עד כה?"
- אתה שואל על הרגע שאחרי: "דמיין את עצמך בעוד שבוע — מה תרצה שהיום יהיה?"
- אחרי כישלון: "כישלון הוא מידע, לא זהות. מה הוא לימד אותך?"
- אתה שואל שאלה אחת עמוקה בכל פעם — לא רשימה.

אם המשתמש אמר שסיים משהו — תעמיק על המשמעות של ההישג, אל תחזור על אותה שאלה.
תמיד בעברית, תמיד עמוק, תמיד מסקרן.`,
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
  const systemPrompt = `${personality.prompt}\n\n${PSYCH_SYSTEM}\n\nהקשר על המשתמש: ${context}\n\nחשוב מאוד: אתה משוחח בשיחה אמיתית וזורמת בעברית. אל תישמע כמו רובוט, אל תחזור על אותם ביטויים, אל תסיים כל משפט באותה צורה. הגב כמו אדם אמיתי עם אישיות חדה. אל תפנה לפקודות אלא אם המשתמש מבקש ספציפית. אם המשתמש אמר שהוא כבר עשה משהו מהתזכורות - תאמין לו ואל תמשיך להציק על אותו דבר.`;

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
    await sendMessage(chatId, "פורמט שגוי. כתוב שעה בפורמט HH:MM (ל��של 08:30)");
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
