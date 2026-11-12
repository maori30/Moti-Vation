import { createDb } from "../_shared/db.ts";
import { TZ, background, getConfig, headerMatchesConfig, israelParts, telegramCall } from "../_shared/util.ts";
import {
  DONEREPLIES, GREETINGS, PERSONALITIES, SNOOZEREPLIES,
  genderKeyboard, personalityKeyboard, pickPersonalized, pickReminderCreated, resolveActivePersonality,
} from "./personas.ts";
import {
  REMINDERTRIGGER, detectReminderIntent, israelTime, looksActionable, parseReminder, reminderLabel, reminderScheduleLabel,
  type ActiveReminder,
} from "./schedule.ts";
import { routeMessage, type Action } from "./intent.ts";
import {
  answerCallback, editMessageReplyMarkup, getTelegramFile, pinChatMessage, sendChatAction, sendMessage, sendPhoto,
  sendTelegramAnimation, type MediaPart,
} from "./tg.ts";
import {
  activeModel, callGeminiRaw, callGoogleGeminiModel, candidateModels, extractionModel, generateAiReply, listAvailableModels,
  transcribeAudio, type HistoryMessage,
} from "./gemini.ts";
import {
  anchorMemoryKeyFor,
  anchorQuestion,
  coreferenceInstruction,
  detectSwitchRequest,
  fetchMemories,
  followUpNudge,
  forgetMemories,
  humorPolicy,
  memoryContext,
  moodInstruction,
  moodLabel,
  naturalize,
  parseSmartHints,
  pickMood,
  runExtraction,
  scheduleFollowUps,
  toneOverrideInstruction,
  upsertMemories,
  type Memory,
  type Mood,
} from "./brain.ts";
import {
  blendInstruction,
  currentBlend,
  decisionEngine,
  detectGoalStatement,
  evolveBlend,
  fetchGoals,
  fetchProfile,
  goalContext,
  isLaugh,
  isShortReply,
  learnFromBehavior,
  linkedReasoning,
  logBehavior,
  pacing as computePacing,
  profileContext,
  runProfileExtraction,
  saveProfile,
  selfCorrectionLayer,
  upsertGoals,
  type Profile,
} from "./profile.ts";
import {
  antiRepetitionInstruction,
  bumpInsideJokes,
  confidenceContext,
  detectDeepMode,
  deepModeInstruction,
  eventContext,
  fetchEvents,
  fetchInsideJokes,
  fetchRecentPhrases,
  humanityCheck,
  implicitIntentLayer,
  insideJokeContext,
  isRepetitive,
  rankMemories,
  rememberPhrase,
  rewriteForHumanity,
  rollSurprise,
  runAwarenessExtraction,
  runForgettingEngine,
  surpriseInstruction,
  upsertEvents,
} from "./awareness.ts";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";

const HISTORY_LIMIT = 14;
// Direct Postgres connection (see _shared/db.ts for why we no longer use the REST API key).
const supabase = createDb();


async function markReminderDone(chatId: number, reminderId: string): Promise<string | null> {
  // Always scope by chat_id: the id may come from the AI ([CMD_COMPLETE:...]) or from a button.
  if (!/^[0-9a-f-]{36}$/i.test(reminderId)) return null;
  const { data: reminder } = await supabase.from("reminders").select("id, text, type, time").eq("id", reminderId).eq("chat_id", chatId).maybeSingle();
  if (!reminder) return null;

  // Idempotency check: don't reward points multiple times for the same reminder completed today
  const sinceHoursAgo = new Date(Date.now() - 16 * 3600 * 1000).toISOString();
  const { data: existingComp } = await supabase
    .from("reminder_completions")
    .select("id")
    .eq("chat_id", chatId)
    .eq("reminder_id", reminder.id)
    .gte("completed_at", sinceHoursAgo)
    .limit(1);

  if (existingComp && existingComp.length > 0) {
    return null; // Already completed today!
  }

  const { data: userData } = await supabase.from("users").select("points, streak_days, last_productive_day, badges").eq("chat_id", chatId).single();
  
  let points = (userData?.points || 0) + 10;
  let streak = userData?.streak_days || 0;
  const today = israelParts().date;
  
  let streakMsg = "";
  if (userData?.last_productive_day !== today) {
    const yesterday = israelParts(new Date(Date.now() - 86_400_000)).date;
    if (userData?.last_productive_day === yesterday) {
      streak += 1;
      streakMsg = `\n🔥 רצף פעילות: ${streak} ימים!`;
    } else {
      streak = 1;
    }
  }

  let badges = userData?.badges || [];
  let badgeMsg = "";
  if (points >= 100 && !badges.includes("מתחיל_לתקתק")) { badges.push("מתחיל_לתקתק"); badgeMsg = "\n🏅 קיבלת תג: מתחיל לתקתק! (100 נק')"; }
  if (points >= 500 && !badges.includes("מכונת_פרודוקטיביות")) { badges.push("מכונת_פרודוקטיביות"); badgeMsg = "\n🏅 קיבלת תג: מכונת פרודוקטיביות! (500 נק')"; }
  if (points >= 1000 && !badges.includes("בלתי_עציר")) { badges.push("בלתי_עציר"); badgeMsg = "\n👑 קיבלת תג: בלתי עציר! (1000 נק')"; }

  const writes: PromiseLike<unknown>[] = [
    supabase.from("users").update({ points, streak_days: streak, last_productive_day: today, badges }).eq("chat_id", chatId),
    supabase.from("reminder_completions").insert({ chat_id: chatId, reminder_id: reminder.id, reminder_text: reminder.text }),
    logBehavior(supabase, chatId, "reminder_done", { hour: israelParts(new Date(reminder.time)).hour }),
  ];
  if (reminder.type === "once") writes.push(supabase.from("reminders").update({ active: false }).eq("id", reminder.id));
  await Promise.all(writes);
  
  return `\n+10 נק' (סה"כ ${points})${streakMsg}${badgeMsg}`;
}

async function updateUser(chatId: number, changes: Record<string, unknown>) {
  const { error } = await supabase.from("users").update(changes).eq("chat_id", chatId);
  if (error) console.error("[users] update failed:", error.message);
}

async function touchUser(chatId: number, defaultName?: string): Promise<{ user: any; isNew: boolean }> {
  const { data: existing, error: selectError } = await supabase.from("users").select("*").eq("chat_id", chatId).maybeSingle();
  if (existing) {
    background(supabase.from("users").update({ last_message_at: new Date().toISOString() }).eq("chat_id", chatId), "touch_user_ts");
    return { user: existing, isNew: false };
  }
  const { data: created, error: insertError } = await supabase
    .from("users")
    .insert({
      chat_id: chatId,
      first_name: defaultName || null,
      state: "awaiting_name",
      last_message_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (created) return { user: created, isNew: true };
  if (insertError) {
    const { data: fallback } = await supabase.from("users").select("*").eq("chat_id", chatId).maybeSingle();
    if (fallback) return { user: fallback, isNew: false };
    throw insertError;
  }
  throw new Error("touchUser: failed to create user");
}

async function getHistory(chatId: number): Promise<HistoryMessage[]> {
  const { data } = await supabase.from("messages").select("role, content, created_at").eq("chat_id", chatId).order("created_at", { ascending: false }).limit(HISTORY_LIMIT);
  return (data ?? []).reverse();
}

async function saveMessage(chatId: number, role: string, content: string) {
  await supabase.from("messages").insert({ chat_id: chatId, role, content });
}

async function showReminders(chatId: number) {
  const { data } = await supabase.from("reminders").select("id, text, type, time").eq("chat_id", chatId).eq("active", true).order("time");
  const reminders = (data ?? []) as ActiveReminder[];
  if (!reminders.length) {
    await sendMessage(chatId, "אין לך כרגע תזכורות פעילות.");
    return;
  }
  const lines = reminders.map((r, i) => `${i + 1}. ${r.text} — ${reminderLabel(r)}`);
  const buttons = reminders.map((r) => [{ text: `🗑️ מחק: ${r.text.slice(0, 24)}`, callback_data: `ask_delete_reminder_${r.id}` }]);
  await sendMessage(chatId, `התזכורות שלך:\n${lines.join("\n")}`, { inline_keyboard: buttons });
}

async function askDeleteReminder(chatId: number, reminder: ActiveReminder) {
  await sendMessage(chatId, `למחוק את התזכורת:\n${reminder.text} — ${reminderLabel(reminder)}?`, {
    inline_keyboard: [
      [{ text: "🗑️ כן, למחוק", callback_data: `confirm_delete_reminder_${reminder.id}` }, { text: "לבטל", callback_data: "cancel_delete_reminder" }],
    ],
  });
}

async function findReminderForDeletion(chatId: number, text: string): Promise<ActiveReminder | null> {
  const { data } = await supabase.from("reminders").select("id, text, type, time").eq("chat_id", chatId).eq("active", true);
  const reminders = (data ?? []) as ActiveReminder[];
  if (!reminders.length) return null;
  const query = text.replace(/מחק|תמחק|לבטל|תבטל|הסר|תסיר|את התזכורת|תזכורת|אותה|אותו/gu, "").trim().toLowerCase();
  if (!query || /^(אותה|אותו)?$/u.test(query)) return reminders.length === 1 ? reminders[0] : null;
  return reminders.find((r) => query.split(/\s+/).some((w) => w.length > 2 && r.text.toLowerCase().includes(w))) ?? null;
}

async function askGemini(text: string, personalityKey: string, history: HistoryMessage[], context: string, layers: string[], media?: MediaPart | null): Promise<string> {
  const personality = PERSONALITIES[personalityKey] ?? PERSONALITIES.cynic;

  const prompt = `אתה ${personality.name}. ${personality.prompt}

אתה בוט אישי בוואטסאפ שמתכתב בעברית ישראלית אותנטית, חיה, אינטליגנטית ושנונה מאוד. יש לך אופי ישראלי מובהק — אתה קצת חוצפן, ציני, מצחיק, שנון, חריף וקולע כשצריך. אתה מדבר בגובה העיניים, לא מתנצל ולא מנומס מדי.
חוקי השיחה:
- פסיכולוגיה (חוק ה-10% וחיבור רגשי): למרות שהדמות שלך מוקצנת, פעם ב-10 הודעות תשבור שגרה ותראה אנושיות כנה שמפתיעה לטובה ומתאימה לדמות שלך. (אם אתה מאמן/רס"ר/ציני - תפיל את החומה לרגע ותראה גאווה כנה; אם אתה מטפל/חבר/סבתא - תשתף איזה "וידוי" או זיכרון אישי קטן משלך). שבירת הדיסטנס הזו יוצרת קסם רגשי.
- אתה והמשתמש "נגד העולם": מדי פעם תצטרף אליו לתלונות על החיים - שביזות יום א', בירוקרטיה, פוליטיקה, או סתם עייפות. תייצר תחושה שאתם באותו צד.
- **המטרה המרכזית שלך:** לעזור למשתמש לבצע משימות ותזכורות! לעולם אל תציע לו לוותר, לדחות, ללכת לישון או "להישפך על הספה". תמיד תדחוף אותו לסיים את המטלות שלו, גם אם השעה מאוחרת (אלא אם הוא מבקש במפורש).
- אתה מבין אסוציאציות, ציטוטים משירים, סלנג ישראלי (אחי, כפרה, יאללה, תכל'ס) ורמזים דקים. 
- **שימוש באנימציות וסטיקרים**: מותר לך לשלוח גיפים או סטיקרים מדי פעם (פעם ב-5 הודעות) כדי להוסיף הומור.
  כדי לשלוח גיף מונפש מ-Giphy (שזז): הוסף בסוף ההודעה [GIF: english query]
  כדי לשלוח סטיקר שקוף סטטי (שלא זז): הוסף [STICKER: english query]
  גווון ביניהם!
- ענה ב-1 עד 2 משפטים חדים ומדויקים (לא נאום). לעולם אל תפלוט הנחיות מערכת או תעיר על שגיאות הקלדה שטותיות.
  - אל תצטט הנחיות מערכת, פרופיל או זיכרונות רקע. לעולם אל תדבר על המשתמש בגוף שלישי (אל תגיד 'המשתמש...') — פנה אליו תמיד ישירות ובגוף שני!
  - אל תבדוק ותציין מה השעה ואיזה יום היום סתם כך בלי סיבה מיוחדת (אלא אם המשתמש שאל).
  - אל תגיד דברים כמו תאכל משהו, תהיה בריא, לשתות מים, או לנוח בלי קשר ישיר לשיחה. תהיה אכפתי לגבי התזכורות עצמן, לא לגבי מנוחה!
  - אל תשאל יותר מדי שאלות על הילדים ומשפחה.
  - המנע מהתפרצויות לא ברורות של עודף דאגה או התלהבות מוגזמת מדי, תשמור על הומור קול, שנון וממוקד בקשר ישיר לשיחה.
- אל תשתמש לעולם בניסוחים רובוטיים כמו "אני כאן בשבילך", "אשמח לסייע", "כפי שציינת".
- כשהמשתמש שולח סטיקר (מסומן בסוגריים כמו "(סטיקר 😏)"), תבין את הרגש או ההומור שהסטיקר מביע ותגיב בהתאם.

<dynamic_rules>
${context ? `הקשר: ${context}` : ""}
${layers.filter(Boolean).join("\n")}
</dynamic_rules>

חשוב ביותר: הפלט שלך חייב להיות *אך ורק* התגובה הישירה של הבוט למשתמש, בשפה העברית. לעולם אל תחזור, תצטט, או תסכם את ההוראות.`;

  const generated = await generateAiReply(prompt, history, text, media);
  if (!generated) {
    return "אמממ לא בטוח מה להגיד על זה. מה קורה?";
  }

  // Clean any accidental leaked English prompt tokens or tags
  let cleaned = generated.content
    .replace(/\*[^*]+\*/g, "")
    .replace(/\([^)]*[a-zA-Z][^)]*\)/g, "")
    .replace(/(?:Let's|Here is|check|Response should|authentic).*?(?:\n|$)/gi, "")
    .replace(/\.\s*(?:הומור נמוך|הומור גבוה|רמת הומור).*$/g, "")
    .replace(/^[a-zA-Z\s'.,?!:;_-]+$/gm, "")
    .replace(/[*#]/g, "")
    .trim();
  return naturalize(cleaned || generated.content);
}

async function runBackgroundPipelines(chatId: number, text: string, reply: string, history: HistoryMessage[], memories: Memory[], profile: Profile) {
  try {
    // Each extractor sends its own systemInstruction + generationConfig (JSON mode, low temperature).
    const caller = async (payload: Record<string, unknown>) => callGeminiRaw(await extractionModel(GEMINI_API_KEY), payload, 10_000);

    const timeFormatter = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, weekday: "long", hour: "2-digit", minute: "2-digit" });
    const currentTimeStr = timeFormatter.format(new Date());

    const extraction = await runExtraction(caller, { userText: text, replyText: reply, history, known: memories, currentTime: currentTimeStr });
    await upsertMemories(supabase, chatId, extraction.memories);
    await forgetMemories(supabase, chatId, extraction.forget);
    await scheduleFollowUps(supabase, chatId, extraction.followUps);

    const awareness = await runAwarenessExtraction(caller, { userText: text, replyText: reply, history });
    await upsertEvents(supabase, chatId, awareness.events);
    await bumpInsideJokes(supabase, chatId, awareness.jokes);

    const profileExtraction = await runProfileExtraction(caller, { userText: text, replyText: reply, history, profile });
    if (Object.keys(profileExtraction.patch).length) await saveProfile(supabase, chatId, profileExtraction.patch);
    await upsertGoals(supabase, chatId, profileExtraction.goals);

    // Occasionally expire old memories / mark past events (was imported but never called).
    if (Math.random() < 0.1) await runForgettingEngine(supabase, chatId);
  } catch (error) {
    console.error("[background] pipeline failed:", error);
  }
}

// ============================================================== actions
// Shared by the AI router (intent.ts) and the legacy regex fallback, so both behave the same.

type NewReminder = { task: string; dueAt: Date; type: string; weather?: string | null; confirmNeeded?: boolean; guessed?: boolean; reason?: string | null };
const REPEAT_WORDS = /^(תזכורת|שוב|מעולה שוב|עוד פעם|אותו דבר)$/u;
const WEATHER_HE: Record<string, string> = { rain: "יורד גשם", clear: "לא יורד גשם", hot: "חם", cold: "קר" };

function nowIsraelString(): string {
  return new Intl.DateTimeFormat("he-IL", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "long" }).format(new Date());
}

async function saveReminder(chatId: number, personality: string, userText: string, r: NewReminder): Promise<void> {
  let task = r.task.trim();
  if (REPEAT_WORDS.test(task)) {
    const { data: last } = await supabase.from("reminders").select("text").eq("chat_id", chatId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (last?.text && last.text !== "תזכורת") task = last.text;
  }
  const { data: existing } = await supabase.from("reminders").select("id, text, type, time").eq("chat_id", chatId).eq("active", true);
  const duplicate = (existing ?? []).find((item: any) =>
    item.text.trim().toLowerCase() === task.toLowerCase() && item.type === r.type && Math.abs(new Date(item.time).getTime() - r.dueAt.getTime()) < 60_000
  );
  let reply: string;
  if (duplicate) {
    reply = `כבר יש לך תזכורת כזאת ל"${task}". לא הוספתי עוד אחת.`;
  } else {
    const { error } = await supabase.from("reminders").insert({
      chat_id: chatId, text: task.slice(0, 200), type: r.type, time: r.dueAt.toISOString(),
      weather_condition: r.weather ?? null, active: true, confirm_needed: r.confirmNeeded === true,
    });
    if (error) {
      reply = "משהו השתבש בשמירת התזכורת. נסה שוב עוד רגע.";
    } else {
      reply = pickReminderCreated(personality, task, reminderScheduleLabel(r.dueAt, r.type));
      if (r.weather) reply += `\n(רק אם ${WEATHER_HE[r.weather] ?? "מזג האוויר מתאים"})`;
      if (r.guessed && r.reason) reply += `\n(נקבע אוטומטית: ${r.reason}) אם בא לך זמן אחר, פשוט תכתוב "תשנה למחר ב-10".`;
    }
  }
  await sendMessage(chatId, reply);
  background(saveMessage(chatId, "user", userText), "save_user");
  background(saveMessage(chatId, "assistant", reply), "save_reply");
}

/** Slower scheduler with full model reasoning — for Hebrew-calendar/holiday dates and as a fallback. */
async function smartSchedule(text: string): Promise<NewReminder | null> {
  try {
    const prompt = `המשתמש ביקש תזכורת: "${text}".
הזמן המקומי כרגע בישראל הוא: ${nowIsraelString()}.
אם המשתמש ציין במפורש תאריך ושעה (למשל "ב-25/11 בשעה 14:00" או "בעוד שעתיים"), חלץ אותם במדויק.
אתה מכיר את כל חגי ישראל ומועדי הלוח העברי. אם המשתמש מבקש תזכורת הקשורה לחג (למשל "יום לפני ערב פסח", "אחרי סוכות"), חשב במדויק מתי זה קורה והחזר את התאריך הלועזי המדויק.
שים לב לשנה הנוכחית. אם התאריך המבוקש כבר עבר השנה, קבע אותו לשנה הבאה. לעולם אל תחזיר תאריך בעבר!
אם המשתמש התנה את התזכורת במזג האוויר (למשל "אלא אם יורד גשם" או "רק אם שמש"), חלץ את התנאי.
החזר אך ורק אובייקט JSON תקני עם:
"task": ניסוח קצר של המשימה נטו ללא מילות התנאי (למשל "לקחת מטריה").
"time": תאריך ושעה בפורמט ISO 8601 עם אזור זמן. דוגמה: "2026-11-25T14:00:00+02:00". חייב להיות בעתיד!
"type": "once" / "daily" / "weekly" / "yearly".
"is_smart_guess": boolean (true אם המשתמש לא ציין זמן והיית צריך להסיק לבד).
"reason": הסבר קצר לזמן שנבחר.
"weather_condition": "rain" / "clear" / "hot" / "cold" או null.
אל תחזיר טקסט מחוץ ל-JSON.`;
    const model = await extractionModel(GEMINI_API_KEY);
    const res = await callGoogleGeminiModel(GEMINI_API_KEY, model, "החזר JSON בלבד", [], prompt, 20_000);
    if (!res.ok) return null;
    const jsonMatch = res.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const smart = JSON.parse(jsonMatch[0]);
    if (!smart.time || !smart.task) return null;
    const dueAt = new Date(smart.time);
    if (Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= Date.now()) return null;
    const type = ["daily", "weekly", "yearly"].includes(smart.type) ? smart.type : "once";
    return { task: String(smart.task), dueAt, type, weather: smart.weather_condition || null, guessed: smart.is_smart_guess === true, reason: smart.reason ?? null };
  } catch (error) {
    console.error("[smart-scheduling] failed:", error);
    return null;
  }
}

async function askWhen(chatId: number, task: string, recurrence: string) {
  const state = recurrence === "daily" || recurrence === "weekly" ? `awaiting_reminder_time_${recurrence}` : "awaiting_reminder_time_once";
  await updateUser(chatId, { state, pending_reminder_text: task.slice(0, 200) });
  await sendMessage(chatId, `מתי להזכיר לך ${task}? למשל: מחר ב-8, עוד שעה, או 08:30.`);
}

async function showStatus(chatId: number) {
  const { data: userData } = await supabase.from("users").select("points, streak_days, badges").eq("chat_id", chatId).single();
  const badges: string[] = userData?.badges || [];
  const badgeStr = badges.length > 0 ? badges.map((b) => `🏆 ${b.replace(/_/g, " ")}`).join("\n") : "אין עדיין תגים";
  await sendMessage(chatId, `📊 **הסטטוס שלך:**\n\n⭐️ נקודות: ${userData?.points || 0}\n🔥 רצף פעילות: ${userData?.streak_days || 0} ימים ברצף\n\n🏅 **תגים:**\n${badgeStr}`);
}

async function showNotes(chatId: number) {
  const { data: notes } = await supabase.from("quick_notes").select("id, text").eq("chat_id", chatId).eq("active", true);
  if (!notes || notes.length === 0) {
    await sendMessage(chatId, "המגירה ריקה. אין לך רעיונות פתוחים כרגע.");
    return;
  }
  const list = notes.map((n: any, i: number) => `${i + 1}. ${n.text}`).join("\n");
  await sendMessage(chatId, `הנה הרעיונות ששמרת במגירת "מתישהו":\n\n${list}\n\n(כדי להפוך רעיון למשימה, פשוט תבקש ממני לקבוע לו תזכורת)`);
}

async function addNote(chatId: number, text: string) {
  await supabase.from("quick_notes").insert({ chat_id: chatId, text: text.slice(0, 500), active: true });
  await sendMessage(chatId, `שמרתי את זה במגירת הרעיונות ("מתישהו").\nאזכיר לך לבדוק את זה באחת מביקורות סוף השבוע שלנו! 💡`);
}

async function addHabit(chatId: number, title: string) {
  await supabase.from("habits").insert({ chat_id: chatId, title: title.slice(0, 80) });
  await sendMessage(chatId, `הוספתי את ההרגל "${title}". כל פעם שתעשה את זה, פשוט תספר לי (למשל "עשיתי ${title}"), ו"הרגלים" יראה לך את הגרף.`);
}

/** Returns false when no matching habit exists. */
async function logHabit(chatId: number, habitId: string | null, title: string | null): Promise<boolean> {
  let habit: { id: number; title: string } | null = null;
  if (habitId) {
    const { data } = await supabase.from("habits").select("id, title").eq("id", habitId).eq("chat_id", chatId).maybeSingle();
    habit = data;
  } else if (title) {
    const { data } = await supabase.from("habits").select("id, title").eq("chat_id", chatId).eq("active", true);
    const t = title.toLowerCase();
    habit = (data ?? []).find((h: any) => t.includes(h.title.toLowerCase()) || h.title.toLowerCase().includes(t)) ?? null;
  }
  if (!habit) return false;
  await supabase.from("habit_logs").upsert({ habit_id: habit.id, chat_id: chatId, date_logged: israelParts().date }, { onConflict: "habit_id, date_logged" });
  await sendMessage(chatId, `כל הכבוד! סימנתי שעשית "${habit.title}" היום. 💪`);
  return true;
}

async function showHabits(chatId: number) {
  const { data: habits } = await supabase.from("habits").select("id, title").eq("chat_id", chatId).eq("active", true);
  if (!habits || habits.length === 0) {
    await sendMessage(chatId, 'אין לך הרגלים במעקב. כתוב "הוסף הרגל [שם ההרגל]" כדי להתחיל.');
    return;
  }
  const { data: logs } = await supabase.from("habit_logs").select("habit_id, date_logged").eq("chat_id", chatId).order("date_logged", { ascending: false }).limit(300);
  let msg = "ההרגלים שלך:\n\n";
  for (const h of habits) {
    let grid = "";
    for (let i = 6; i >= 0; i--) {
      const dateStr = israelParts(new Date(Date.now() - i * 86_400_000)).date;
      grid += logs?.some((l: any) => l.habit_id === h.id && l.date_logged === dateStr) ? "🟩" : "⬜";
    }
    msg += `**${h.title}**\n${grid}\n\n`;
  }
  const labels = habits.map((h: any) => h.title);
  const data = habits.map((h: any) => logs?.filter((l: any) => l.habit_id === h.id).length || 0);
  const chartJson = { type: "bar", data: { labels, datasets: [{ label: "ביצועים", data, backgroundColor: "rgba(54, 162, 235, 0.5)" }] } };
  const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartJson))}&w=500&h=300`;
  if (!(await sendPhoto(chatId, chartUrl, msg))) await sendMessage(chatId, msg);
}

async function startCountdown(chatId: number, title: string, targetAt: Date) {
  const diffMs = targetAt.getTime() - Date.now();
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs / 3_600_000) % 24);
  const minutes = Math.floor((diffMs / 60_000) % 60);
  const msgId = await sendMessage(chatId, `⏳ **ספירה לאחור: ${title}**\nנותרו: ${days} ימים, ${hours} שעות, ו-${minutes} דקות.`);
  if (msgId) {
    await pinChatMessage(chatId, msgId);
    await supabase.from("countdowns").insert({ chat_id: chatId, title, target_date: targetAt.toISOString(), message_id: msgId, active: true });
    await sendMessage(chatId, "נעצתי את ההודעה! היא תתעדכן אוטומטית ככל שנתקרב ליעד.");
  }
}

async function applyPersonality(chatId: number, key: string, permanent: boolean) {
  const changes = permanent
    ? { personality: key, temp_personality: null, temp_personality_until: null }
    : { temp_personality: key, temp_personality_until: new Date(Date.now() + 2 * 3_600_000).toISOString() };
  await updateUser(chatId, changes);
  const p = PERSONALITIES[key];
  await sendMessage(chatId, permanent ? `${p?.emoji ?? "💬"} סגור, מעכשיו אני ${p?.name ?? ""}.` : `${p?.emoji ?? "💬"} סגור, ${p?.name ?? ""} לשעתיים הקרובות.`);
}

async function applyGender(chatId: number, gender: "male" | "female") {
  const isFemale = gender === "female";
  await Promise.all([updateUser(chatId, { gender }), saveProfile(supabase, chatId, { address_style: isFemale ? "לשון נקבה" : "לשון זכר" })]);
  await sendMessage(chatId, isFemale ? "סגור, מעכשיו אני פונה אלייך בלשון נקבה! ✨" : "סגור, מעכשיו אני פונה אליך בלשון זכר! 👍");
}

/** Executes a routed action. Returns true when the message was fully handled. */
async function handleAction(a: Action, chatId: number, personality: string, text: string): Promise<boolean> {
  switch (a.kind) {
    case "create_reminder": {
      let dueAt = a.dueAt;
      let extra: Partial<NewReminder> = {};
      if (!dueAt && a.complexDate) {
        const smart = await smartSchedule(text);
        if (smart) { dueAt = smart.dueAt; extra = { guessed: smart.guessed, reason: smart.reason }; }
      }
      if (!dueAt) { await askWhen(chatId, a.task, a.recurrence); return true; }
      await saveReminder(chatId, personality, text, {
        task: a.task, dueAt, type: a.recurrence, weather: a.weather, confirmNeeded: a.confirmNeeded,
        guessed: extra.guessed ?? a.guessed, reason: extra.reason ?? a.reason,
      });
      return true;
    }
    case "reschedule_reminder": {
      const { data: active } = await supabase.from("reminders").select("id, text, type, time").eq("chat_id", chatId).eq("active", true);
      const list = (active ?? []) as ActiveReminder[];
      const target = list.find((r) => r.id === a.reminderId) ?? (list.length === 1 ? list[0] : null);
      if (!target) {
        if (!list.length) await sendMessage(chatId, "אין לך כרגע תזכורות פעילות להזיז.");
        else { await sendMessage(chatId, "איזו תזכורת להזיז? הנה הרשימה:"); await showReminders(chatId); }
        return true;
      }
      let dueAt = a.dueAt;
      if (!dueAt && a.complexDate) dueAt = (await smartSchedule(text))?.dueAt ?? null;
      if (!dueAt) { await sendMessage(chatId, `לאיזה זמן להזיז את "${target.text}"? למשל: "תשנה למחר ב-10".`); return true; }
      await supabase.from("reminders").update({ time: dueAt.toISOString(), nudge_sent_at: null, active: true }).eq("id", target.id).eq("chat_id", chatId);
      const reply = `סגור, הזזתי את "${target.text}" ל${reminderScheduleLabel(dueAt, target.type)}.`;
      await sendMessage(chatId, reply);
      background(saveMessage(chatId, "user", text), "save_user");
      background(saveMessage(chatId, "assistant", reply), "save_reply");
      return true;
    }
    case "delete_reminder": {
      const { data: active } = await supabase.from("reminders").select("id, text, type, time").eq("chat_id", chatId).eq("active", true);
      const list = (active ?? []) as ActiveReminder[];
      const target = list.find((r) => r.id === a.reminderId) ?? (list.length === 1 ? list[0] : null);
      if (target) await askDeleteReminder(chatId, target);
      else if (!list.length) await sendMessage(chatId, "אין לך כרגע תזכורות פעילות.");
      else { await sendMessage(chatId, "איזו תזכורת למחוק? בחר בכפתור:"); await showReminders(chatId); }
      return true;
    }
    case "list_reminders":
      await showReminders(chatId);
      return true;
    case "mark_done": {
      if (!a.reminderId) return false;
      const points = await markReminderDone(chatId, a.reminderId);
      const reply = points ? `${pickPersonalized(DONEREPLIES, personality)}${points}` : "כבר סימנתי את זה היום 👍";
      await sendMessage(chatId, reply);
      background(saveMessage(chatId, "user", text), "save_user");
      background(saveMessage(chatId, "assistant", reply), "save_reply");
      return true;
    }
    case "add_habit":
      await addHabit(chatId, a.title);
      return true;
    case "log_habit":
      return await logHabit(chatId, a.habitId, a.title); // no match -> continue as normal chat
    case "list_habits":
      await showHabits(chatId);
      return true;
    case "add_note":
      await addNote(chatId, a.text);
      return true;
    case "list_notes":
      await showNotes(chatId);
      return true;
    case "countdown":
      if (!a.targetAt) {
        await sendMessage(chatId, "לא הבנתי למתי הספירה לאחור. תפרט קצת יותר (למשל: ספירה לאחור לטיסה ב-20 באוקטובר שעה 10:00).");
        return true;
      }
      await startCountdown(chatId, a.title, a.targetAt);
      return true;
    case "status":
      await showStatus(chatId);
      return true;
    case "set_name":
      await updateUser(chatId, { first_name: a.name });
      await sendMessage(chatId, `סגור, מעכשיו אני קורא לך ${a.name}! 👍`);
      return true;
    case "set_gender":
      await applyGender(chatId, a.gender);
      return true;
    case "set_personality":
      await applyPersonality(chatId, a.personality, a.permanent);
      return true;
    case "set_tone":
      await updateUser(chatId, { tone_override: a.tone });
      await sendMessage(chatId, a.tone === "serious" ? "סגור, בלי שטויות מעכשיו." : a.tone === "softer" ? "סבבה, יותר בעדינות." : "יאללה, נעלה הילוך 😏");
      return true;
    case "chat":
      return false;
  }
  return false;
}

const OK = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

// One-time / repeatable webhook registration with a secret token. Called from pg_cron/SQL with
// the cron secret: POST /telegram?setup=webhook  (header x-cron-secret)
async function registerWebhook(): Promise<Response> {
  const secret = await getConfig(supabase, "webhook_secret");
  if (!secret) return new Response(JSON.stringify({ ok: false, error: "webhook_secret missing" }), { status: 500 });
  const result = await telegramCall(TG_TOKEN, "setWebhook", {
    url: `${SUPABASE_URL}/functions/v1/telegram`,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    max_connections: 20,
  });
  const info = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getWebhookInfo`).then((r) => r.json()).catch(() => null);
  const safeInfo = info?.result ? { url: info.result.url, pending: info.result.pending_update_count, last_error: info.result.last_error_message ?? null } : null;
  return new Response(JSON.stringify({ ok: Boolean(result?.ok), info: safeInfo }), { status: 200 });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Self-healing webhook setup: the first invocation after deploy (or after the secret changes)
// registers the webhook with the secret_token, then remembers it in bot_config.
let webhookChecked = false;
async function ensureWebhook(): Promise<void> {
  if (webhookChecked) return;
  try {
    const secret = await getConfig(supabase, "webhook_secret");
    if (!secret) return;
    const marker = (await sha256Hex(`${secret}|${SUPABASE_URL}`)).slice(0, 32);
    const { data } = await supabase.from("bot_config").select("value").eq("key", "webhook_registered").maybeSingle();
    if (data?.value !== marker) {
      const res = await registerWebhook();
      const body = await res.json().catch(() => null);
      if (!body?.ok) { console.error("[webhook] registration failed:", JSON.stringify(body)); return; }
      await supabase.from("bot_config").upsert({ key: "webhook_registered", value: marker }, { onConflict: "key" });
      console.log("[webhook] registered with secret token");
    }
    webhookChecked = true;
  } catch (error) {
    console.error("[webhook] ensure failed:", error);
  }
}

function isAdmin(chatId: number, adminId: string | null): boolean {
  return Boolean(adminId) && String(chatId) === String(adminId);
}

Deno.serve(async (req: Request) => {
  await ensureWebhook();
  const url = new URL(req.url);
  if (url.searchParams.get("setup") === "webhook") {
    if (!(await headerMatchesConfig(req, supabase, "x-cron-secret", "cron_secret"))) return new Response("unauthorized", { status: 401 });
    return await registerWebhook();
  }

  if (req.method !== "POST") {
    // Keep-warm ping from pg_cron: touch the DB so the connection pool stays hot.
    try {
      await supabase.from("users").select("chat_id").limit(1);
    } catch (e) {
      console.error("[keepalive] db ping error:", e);
    }
    return new Response("OK", { status: 200 });
  }

  // Only Telegram knows the secret_token we registered with setWebhook.
  if (!(await headerMatchesConfig(req, supabase, "x-telegram-bot-api-secret-token", "webhook_secret"))) {
    return new Response("unauthorized", { status: 401 });
  }

  try {
    const update = await req.json();

    // Telegram re-sends an update if we were slow to answer; process each update_id once.
    if (typeof update.update_id === "number") {
      const { error: dupError } = await supabase.from("processed_updates").insert({ update_id: update.update_id });
      if (dupError) return OK();
    }

    if (update.callback_query) {
      const callback = update.callback_query;
      const chatId = callback.message.chat.id as number;
      const data = String(callback.data ?? "");
      const { user } = await touchUser(chatId, callback.from?.first_name ?? "חבר");
      const activePersonality = resolveActivePersonality(user);
      await answerCallback(callback.id);

      if (data === "gender_male" || data === "gender_female") {
        const isFemale = data === "gender_female";
        const gender = isFemale ? "female" : "male";
        const addressStyle = isFemale ? "לשון נקבה" : "לשון זכר";
        background(
          Promise.all([
            updateUser(chatId, { gender, state: "chatting" }),
            saveProfile(supabase, chatId, { address_style: addressStyle }),
          ]),
          "save_gender_callback",
        );
        if (callback.message?.message_id) {
          background(editMessageReplyMarkup(chatId, callback.message.message_id), "clear_markup");
        }
        const confirmText = isFemale
          ? "מעולה, נרשם בלשון נקבה! ✨\nבאיזה סגנון תרצי שנדבר? בחרי אישיות:"
          : "מעולה, נרשם בלשון זכר! ✨\nבאיזה סגנון תרצה שנדבר? בחר אישיות:";
        await sendMessage(chatId, confirmText, personalityKeyboard());
      } else if (data.startsWith("personality_")) {
        const personality = data.replace("personality_", "");
        background(updateUser(chatId, { personality, temp_personality: null, temp_personality_until: null, state: "chatting" }), "personality_switch");
        await sendMessage(chatId, GREETINGS[personality] ?? "סגור. דבר איתי.");
      } else if (data === "menu_reminder") {
        background(updateUser(chatId, { state: "awaiting_reminder_text" }), "menu_reminder_state");
        await sendMessage(chatId, "מה להזכיר לך?");
      } else if (data === "menu_personality") {
        await sendMessage(chatId, "בחר אישיות:", personalityKeyboard());
      } else if (data.startsWith("done_reminder_")) {
        const id = data.replace("done_reminder_", "");
        if (callback.message?.message_id) {
          background(editMessageReplyMarkup(chatId, callback.message.message_id), "clear_markup");
        }
        const pointsString = await markReminderDone(chatId, id);
        if (pointsString) {
          const baseReply = pickPersonalized(DONEREPLIES, activePersonality);
          await sendMessage(chatId, `${baseReply}${pointsString}`);
        }
      } else if (data.startsWith("snooze_")) {
        const id = data.replace("snooze_", "");
        if (callback.message?.message_id) {
          background(editMessageReplyMarkup(chatId, callback.message.message_id), "clear_markup");
        }
        const { data: rem } = await supabase.from("reminders").select("id, text, type, time, snooze_count").eq("id", id).eq("chat_id", chatId).maybeSingle();
        if (rem) {
          const snoozeUntil = new Date(Date.now() + 15 * 60_000).toISOString();
          const writes: PromiseLike<unknown>[] = [logBehavior(supabase, chatId, "reminder_snoozed")];
          if (rem.type === "once") {
            writes.push(supabase.from("reminders").update({ time: snoozeUntil, nudge_sent_at: null, snooze_count: (rem.snooze_count || 0) + 1, active: true }).eq("id", id).eq("chat_id", chatId));
          } else {
            // Recurring reminders keep their schedule; the snooze is a separate one-off copy.
            writes.push(supabase.from("reminders").update({ snooze_count: (rem.snooze_count || 0) + 1 }).eq("id", id).eq("chat_id", chatId));
            writes.push(supabase.from("reminders").insert({ chat_id: chatId, text: rem.text, type: "once", time: snoozeUntil, active: true }));
          }
          await Promise.all(writes);
          await sendMessage(chatId, pickPersonalized(SNOOZEREPLIES, activePersonality));
        }
      } else if (data.startsWith("ask_delete_reminder_")) {
        const id = data.replace("ask_delete_reminder_", "");
        const { data: reminder } = await supabase.from("reminders").select("id, text, type, time").eq("id", id).eq("chat_id", chatId).eq("active", true).maybeSingle();
        if (reminder) await askDeleteReminder(chatId, reminder as ActiveReminder);
      } else if (data.startsWith("confirm_delete_reminder_")) {
        const id = data.replace("confirm_delete_reminder_", "");
        if (callback.message?.message_id) background(editMessageReplyMarkup(chatId, callback.message.message_id), "clear_markup");
        const { error } = await supabase.from("reminders").update({ active: false }).eq("id", id).eq("chat_id", chatId);
        await sendMessage(chatId, error ? "לא הצלחתי למחוק. נסה שוב עוד רגע." : "נמחקה. לא אטריד אותך על זה יותר.");
      } else if (data === "cancel_delete_reminder") {
        if (callback.message?.message_id) {
          background(editMessageReplyMarkup(chatId, callback.message.message_id), "clear_markup");
        }
        await sendMessage(chatId, "סבבה, נשארת כמו שהיא.");
      } else if (data.startsWith("activate_reminder_")) {
        const id = data.replace("activate_reminder_", "");
        if (callback.message?.message_id) background(editMessageReplyMarkup(chatId, callback.message.message_id), "clear_markup");
        const { data: rem } = await supabase.from("reminders").update({ active: true }).eq("id", id).eq("chat_id", chatId).select("text, time, type").maybeSingle();
        await sendMessage(chatId, rem ? pickReminderCreated(activePersonality, rem.text, reminderScheduleLabel(new Date(rem.time), rem.type)) : "לא מצאתי את התזכורת הזאת.");
      } else if (data.startsWith("discard_reminder_")) {
        const id = data.replace("discard_reminder_", "");
        if (callback.message?.message_id) background(editMessageReplyMarkup(chatId, callback.message.message_id), "clear_markup");
        await supabase.from("reminders").delete().eq("id", id).eq("chat_id", chatId).eq("active", false);
        await sendMessage(chatId, "סבבה, לא קבעתי כלום.");
      } else if (data === "dismiss") {
        if (callback.message?.message_id) {
          background(editMessageReplyMarkup(chatId, callback.message.message_id), "clear_markup");
        }
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const message = update.message;
    if (!message) return new Response(JSON.stringify({ ok: true }), { status: 200 });

    const chatId = message.chat.id as number;
    let text = String(message.text || message.caption || "").trim();
    
    let media: MediaPart | null = null;
    let fileId: string | null = null;
    
    if (message.voice) {
      fileId = message.voice.file_id;
      if (!text) text = "(הודעה קולית)";
    } else if (message.photo && message.photo.length > 0) {
      fileId = message.photo[message.photo.length - 1].file_id;
      if (!text) text = "(תמונה)";
    } else if (message.sticker) {
      const sticker = message.sticker;
      const stickerEmoji = sticker.emoji ?? "";
      const stickerSetName = sticker.set_name ?? "";
      
      if (!sticker.is_animated && !sticker.is_video) {
        fileId = sticker.file_id;
      } else {
        // For animated (tgs) and video (webm) stickers, Gemini can't process them inline. 
        // We fetch the static thumbnail instead so the AI can "see" the custom sticker.
        fileId = sticker.thumbnail?.file_id || sticker.thumb?.file_id || null;
      }
      
      if (!text) text = `(סטיקר${stickerEmoji ? ` ${stickerEmoji}` : ""}${stickerSetName ? ` מתוך ${stickerSetName}` : ""})`;
    } else if (message.animation) {
      fileId = message.animation.thumbnail?.file_id || message.animation.thumb?.file_id || null;
      if (!text) text = "(אנימציה/גיף)";
    } else if (message.video) {
      fileId = message.video.thumbnail?.file_id || message.video.thumb?.file_id || null;
      if (!text) text = "(סרטון וידאו)";
    } else if (message.document) {
      if (message.document.mime_type === "text/vcard" || (message.document.file_name || "").endsWith(".vcf")) {
        // Handle vCard upload directly here
        const vcardFile = await getTelegramFile(message.document.file_id);
        if (vcardFile && vcardFile.mimeType === "text/vcard") {
          const bytes = Uint8Array.from(atob(vcardFile.data), (c) => c.charCodeAt(0));
          const vcardText = new TextDecoder().decode(bytes); // UTF-8 safe (Hebrew names)
          const birthdays: Array<{ name: string; month: number; day: number }> = [];
          let currentName = "איש קשר";
          for (const rawLine of vcardText.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (/^BEGIN:VCARD/i.test(line)) currentName = "איש קשר";
            if (/^FN[;:]/i.test(line)) currentName = line.slice(line.indexOf(":") + 1).trim() || currentName;
            if (/^BDAY[;:]/i.test(line)) {
              // Accepts 1990-05-17, 19900517, --05-17, --0517
              const value = line.slice(line.indexOf(":") + 1).trim();
              const m = value.match(/^(?:\d{4}|--)-?(\d{2})-?(\d{2})/);
              if (m) birthdays.push({ name: currentName, month: +m[1], day: +m[2] });
            }
          }
          if (birthdays.length > 0) {
            const now = new Date();
            const inserts = birthdays.map((b) => {
              // Reminder at 09:00 Israel time, two days before the birthday, next occurrence.
              const p = israelParts(now);
              let year = p.year;
              const at = (y: number) => {
                const naive = Date.UTC(y, b.month - 1, b.day - 2, 9, 0, 0);
                return israelTime(9, 0, new Date(naive));
              };
              let due = at(year);
              if (due.getTime() <= now.getTime()) due = at(++year);
              return {
                chat_id: chatId,
                text: `לקנות מתנה ליום ההולדת של ${b.name} (שחל ב-${String(b.day).padStart(2, "0")}/${String(b.month).padStart(2, "0")})`,
                type: "yearly",
                time: due.toISOString(),
                active: true,
              };
            });
            const { error: insertError } = await supabase.from("reminders").insert(inserts);
            await sendMessage(chatId, insertError
              ? "משהו השתבש בשמירת ימי ההולדת. נסה שוב עוד רגע."
              : `🎉 מיובא! סינכרנתי ${birthdays.length} ימי הולדת מאנשי הקשר שלך. אזכיר לך יומיים לפני כל יום הולדת כדי שתספיק להתארגן.`);
          } else {
            await sendMessage(chatId, "לא מצאתי תאריכי ימי הולדת בקובץ הזה. 🤷");
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
      }
      fileId = message.document.file_id;
      if (!text) text = `(קובץ מסוג ${message.document.mime_type})`;
    }

    if (fileId) {
      media = await getTelegramFile(fileId);
    }

    // Voice notes: transcribe first, so reminders/commands said out loud are understood like text
    // and the history/memory stores what was actually said instead of "(הודעה קולית)".
    if (message.voice && media?.mimeType.startsWith("audio/")) {
      background(sendChatAction(chatId, "typing"), "voice_typing");
      const transcript = await transcribeAudio(media);
      if (transcript) {
        text = message.caption ? `${transcript}\n${message.caption}` : transcript;
        media = null;
      }
    }
    
    if (!text && !media) return new Response(JSON.stringify({ ok: true }), { status: 200 });

    const firstName = message.from?.first_name ?? "חבר";

    background(sendChatAction(chatId, "typing"), "initial_typing");

    const { user, isNew } = await touchUser(chatId, firstName);
    const personality = resolveActivePersonality(user);

    if (isNew) {
      await sendMessage(
        chatId,
        "שלום וברוך הבא! 👋\nנעים להכיר, אני מוטי הבוט שלך למשימות ותזכורות.\nלפני שנתחיל — איך קוראים לך?",
      );
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (user.state === "awaiting_name") {
      let rawName = text.trim();
      let cleaned = rawName
        .replace(/^(?:שלום|היי)?\s*(?:נעים להכיר\s*)?(?:אני\s+|קוראים\s+לי\s+|שמי\s+(?:הוא\s+)?|השם\s+שלי\s+(?:הוא\s+)?)/i, "")
        .replace(/[.!?]+$/, "")
        .trim();
      if (!cleaned || cleaned.length > 40) {
        cleaned = firstName || "חבר";
      }

      // Check if Telegram provided gender
      const telegramGender = (message.from as any)?.gender;
      if (telegramGender === "female" || telegramGender === "male") {
        const addressStyle = telegramGender === "female" ? "לשון נקבה" : "לשון זכר";
        background(
          Promise.all([
            updateUser(chatId, { first_name: cleaned, gender: telegramGender, state: "chatting" }),
            saveProfile(supabase, chatId, { address_style: addressStyle }),
          ]),
          "save_onboarding",
        );
        const greeting = telegramGender === "female"
          ? `נעים להכיר, ${cleaned}! 😊\nבאיזה סגנון תרצי שנדבר? בחרי אישיות:`
          : `נעים להכיר, ${cleaned}! 😊\nבאיזה סגנון תרצה שנדבר? בחר אישיות:`;
        await sendMessage(chatId, greeting, personalityKeyboard());
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      // Telegram has no gender - ask the user
      background(updateUser(chatId, { first_name: cleaned, state: "awaiting_gender" }), "save_name");
      await sendMessage(
        chatId,
        `נעים להכיר, ${cleaned}! 😊\nאיך לפנות אליך?`,
        genderKeyboard(),
      );
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (user.state === "awaiting_gender") {
      const isFemale = /(?:נקבה|בת|אישה|בחורה|לשון\s*נקבה)/i.test(text);
      const isMale = /(?:זכר|בן|גבר|בחור|לשון\s*זכר)/i.test(text);

      if (isFemale || isMale) {
        const gender = isFemale ? "female" : "male";
        const addressStyle = isFemale ? "לשון נקבה" : "לשון זכר";
        background(
          Promise.all([
            updateUser(chatId, { gender, state: "chatting" }),
            saveProfile(supabase, chatId, { address_style: addressStyle }),
          ]),
          "save_gender_text",
        );
        const confirmText = isFemale
          ? "מעולה, נרשם בלשון נקבה! ✨\nבאיזה סגנון תרצי שנדבר? בחרי אישיות:"
          : "מעולה, נרשם בלשון זכר! ✨\nבאיזה סגנון תרצה שנדבר? בחר אישיות:";
        await sendMessage(chatId, confirmText, personalityKeyboard());
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      } else {
        await sendMessage(chatId, "לא הייתי בטוח — בחר בבקשה איך לפנות אליך:", genderKeyboard());
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    }

    const adminChatId = Deno.env.get("BOT_ADMIN_CHAT_ID") ?? await getConfig(supabase, "admin_chat_id");
    const adminOnly = ["DEBUG_MODELS", "/testai", "/diag"].includes(text);
    if (adminOnly && !isAdmin(chatId, adminChatId)) {
      // Not for regular users: fall through and treat it as normal chat text.
    } else if (text === "DEBUG_MODELS") {
      const models = await listAvailableModels(GEMINI_API_KEY) ?? [];
      const msg = `Models (${models.length}):\n${models.join(", ")}`;
      await sendMessage(chatId, msg);
      await supabase.from("messages").insert({ chat_id: chatId, role: "assistant", content: msg });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (adminOnly && isAdmin(chatId, adminChatId) && text === "/testai") {
      const res = await generateAiReply("test", [], "test");
      await sendMessage(chatId, `AI used model: ${res?.debug ?? "failed"}`);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (text === "/start") {
      const isFemale = user.gender === "female";
      const name = user.first_name || firstName;
      const promptText = isFemale ? `שלום ${name}! בחרי מי ידבר איתך:` : `שלום ${name}! בחר מי ידבר איתך:`;
      await sendMessage(chatId, promptText, personalityKeyboard());
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    // Name change intent in normal conversation
    const nameChangeMatch = text.trim().match(/^(?:תקרא\s+לי|שנה\s+(?:לי\s+)?(?:את\s+)?(?:ה)?שם\s+(?:שלי\s+)?ל|השם\s+שלי\s+הוא)\s+([א-תa-zA-Z\s'-]+)$/i);
    if (nameChangeMatch && nameChangeMatch[1]) {
      const newName = nameChangeMatch[1].trim();
      if (newName.length > 0 && newName.length <= 40) {
        await updateUser(chatId, { first_name: newName });
        await sendMessage(chatId, `סגור, מעכשיו אני קורא לך ${newName}! 👍`);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    }

    // Gender change intent in normal conversation
    if (/^(?:תפנה|תפני)\s+אליי\s+בלשון\s+(זכר|נקבה)/i.test(text.trim())) {
      await applyGender(chatId, /נקבה/i.test(text) ? "female" : "male");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (text === "/menu") {
      await sendMessage(chatId, "מה בא לך לעשות?", { inline_keyboard: [[{ text: "⏰ תזכורת", callback_data: "menu_reminder" }], [{ text: "🎭 אישיות", callback_data: "menu_personality" }]] });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (adminOnly && isAdmin(chatId, adminChatId) && text === "/diag") {
      const available = await listAvailableModels(GEMINI_API_KEY);
      const lines = [
        `מפתח Gemini: ${GEMINI_API_KEY ? "מוגדר ✅" : "חסר ❌"}`,
        `מודל פעיל: ${activeModel() ?? "עוד לא נבחר"}`,
        `מועמדים: ${candidateModels(available).join(", ")}`,
        `זמינים למפתח: ${available ? available.filter((m) => /gemini/.test(m)).slice(0, 10).join(", ") : "לא נבדק"}`,
      ];
      const probe = await callGoogleGeminiModel(GEMINI_API_KEY, candidateModels(available)[0], "ענה במילה אחת", [], "בדיקה", 8_000);
      lines.push(`בדיקת שיחה: ${probe.ok ? "עובד ✅" : `נכשל ❌ (${(probe as any).status})`}`);
      await sendMessage(chatId, lines.join("\n"));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (/^(סטטוס|הסטטוס שלי|הישגים)$/ui.test(text.trim())) {
      await showStatus(chatId);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (user.state === "awaiting_reminder_text") {
      background(updateUser(chatId, { state: "awaiting_reminder_time_once", pending_reminder_text: text }), "reminder_text_state");
      await sendMessage(chatId, "מתי? כתוב שעה כמו 08:30.");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (String(user.state ?? "").startsWith("awaiting_reminder_time_")) {
      if (text.trim().match(/^(ביטול|בטל|עזוב|לא משנה)$/ui) || detectReminderIntent(text)) {
        background(updateUser(chatId, { state: "chatting", pending_reminder_text: null }), "reset_state");
        if (detectReminderIntent(text)) {
          // Fall through to allow detectReminderIntent to handle it below!
          user.state = "chatting"; // Mutate local object so we don't hit other state checks
        } else {
          await sendMessage(chatId, "בוטל. מה עכשיו?");
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
      } else {
      const type = String(user.state).replace("awaiting_reminder_time_", "") as "once" | "daily" | "weekly";
      const time = text.trim().match(/^(?:ב\s*-?\s*|בשעה\s*)?([0-1]?\d|2[0-3])(?::([0-5]\d))?$/);
      let due: Date | null = null;
      if (time) {
        due = israelTime(+time[1], time[2] ? +time[2] : 0);
        if (due.getTime() <= Date.now()) due = israelTime(+time[1], time[2] ? +time[2] : 0, new Date(), 1);
      } else {
        // Natural answers: "מחר ב-8", "עוד שעה", "ביום שלישי ב-10"...
        due = parseReminder(`תזכיר לי ${text}`)?.dueAt ?? null;
      }
      if (!due) {
        await sendMessage(chatId, "לא הבנתי מתי. תכתוב למשל: 8, 14:30, מחר ב-9 או עוד שעה (או \"ביטול\").");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      await updateUser(chatId, { state: "idle", pending_reminder_text: null });
      await saveReminder(chatId, resolveActivePersonality(user), text, { task: String(user.pending_reminder_text ?? "תזכורת"), dueAt: due, type });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    }

    // ---- AI intent router ------------------------------------------------------------
    // Understands free-form requests ("תזיז את התזכורת של אמא למחר ב-10", "רצתי הבוקר"),
    // validated against the user's real reminders/habits. On any failure (null) we fall back
    // to the legacy regex pipeline below, so the bot keeps working if Gemini is down.
    const historyPromise = getHistory(chatId);
    let route: Action | null = null;
    const isImage = Boolean(media?.mimeType.startsWith("image/"));
    if (!isImage && text && !isLaugh(text)) {
      const recentHistory = await historyPromise;
      const lastBotMessage = [...recentHistory].reverse().find((m) => m.role === "assistant")?.content ?? "";
      if (looksActionable(text, lastBotMessage)) {
        const [{ data: routerReminders }, { data: routerHabits }] = await Promise.all([
          supabase.from("reminders").select("id, text, type, time").eq("chat_id", chatId).eq("active", true).order("time").limit(30),
          supabase.from("habits").select("id, title").eq("chat_id", chatId).eq("active", true).limit(30),
        ]);
        route = await routeMessage(text, {
          now: new Date(),
          reminders: routerReminders ?? [],
          habits: routerHabits ?? [],
          recent: recentHistory.slice(-6),
        }, async (payload) => callGeminiRaw(await extractionModel(GEMINI_API_KEY), payload, 8_000));
        if (route && route.kind !== "chat" && await handleAction(route, chatId, personality, text)) {
          return OK();
        }
      } else {
        route = { kind: "chat" }; // small talk: skip the router and the legacy command regexes
      }
    }
    const legacy = route === null;

    const switchRequest = legacy ? detectSwitchRequest(text) : null;
    if (switchRequest?.type === "personality") {
      await applyPersonality(chatId, switchRequest.key, switchRequest.scope === "permanent");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (switchRequest?.type === "tone") {
      background(updateUser(chatId, { tone_override: switchRequest.tone }), "switch_tone");
      await sendMessage(chatId, "סגור.");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (/^(\/reminders|התזכורות שלי|תזכורות)$/u.test(text)) {
      await showReminders(chatId);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    // Old check matched the letter "ה" (= almost any sentence), so "אני צריך לבטל את הפגישה"
    // was treated as "delete a reminder". Now it must mention a reminder, or be a short
    // "תמחק אותה" right after the bot talked about one.
    const deleteVerb = /(מחק|תמחק|תמחקי|לבטל|תבטל|תבטלי|הסר|תסיר|תסירי)/u.test(text);
    const aboutReminder = /(תזכורת|התזכורת|תזכורות|ההתראה)/u.test(text) || (/^\S+\s+(אותה|אותו)[.!]?$/u.test(text.trim()));
    if (legacy && deleteVerb && aboutReminder) {
      const reminder = await findReminderForDeletion(chatId, text);
      if (reminder) {
        await askDeleteReminder(chatId, reminder);
      } else {
        await sendMessage(chatId, "איזו תזכורת למחוק? כתוב \"התזכורות שלי\" ובחר בכפתור.");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const sinceHoursAgo = new Date(Date.now() - 16 * 3600 * 1000).toISOString();
    const [{ data: activeReminders }, { data: todayComps }] = await Promise.all([
      supabase.from("reminders").select("id, text").eq("chat_id", chatId).eq("active", true),
      supabase.from("reminder_completions").select("reminder_id").eq("chat_id", chatId).gte("completed_at", sinceHoursAgo)
    ]);
    const completedIds = new Set((todayComps ?? []).map((c: any) => c.reminder_id));
    const activeRemindersDue = (activeReminders ?? []).filter((r: any) => !completedIds.has(r.id));
    const completionInstruction = (activeRemindersDue && activeRemindersDue.length > 0) ? 
      `חוק קריטי: אם המשתמש מדווח בבירור שביצע או סיים את אחת מהמטלות שלו (במיוחד מהרשימה הבאה:\n${activeRemindersDue.map((r: any) => `- ${r.text} (ID: ${r.id})`).join("\n")}), עליך להוסיף בסוף התשובה שלך את הפקודה: [CMD_COMPLETE:ID] (כאשר ID הוא ה-ID של המטלה). דוגמה: "כל הכבוד שסיימת! [CMD_COMPLETE:1234]". הוסף את הפקודה הזו אך ורק בהודעה המדויקת שבה המשתמש מודיע לראשונה שסיים אותה עכשיו! אם המשתמש או אתה רק ממשיכים לדבר על זה בהודעות עוקבות (כמו "זה לא אקמול" או "על מה אתה מדבר"), אל תוסיף את הפקודה הזו שוב בשום פנים ואופן! אם אתה לא בטוח לאיזו מטלה הוא התכוון, פשוט תן עידוד מבלי לשאול "זה קשור ל...?". פרגן לו! **אזהרה חמורה**: אל תדבר על המטלות שברשימה ביוזמתך ואל תציק לו לבצע אותן, הרשימה נועדה אך ורק כדי לזהות אם הוא הודיע שהוא סיים אותן!` : "";
      
    if (legacy && /ספירה לאחור|כמה זמן נשאר/ui.test(text.trim())) {
      try {
        const timeFormatter = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "long" });
        const nowStr = timeFormatter.format(new Date());
        const model = await extractionModel(GEMINI_API_KEY);
        const prompt = `המשתמש ביקש ספירה לאחור: "${text}".
הזמן המקומי כרגע בישראל הוא: ${nowStr}.
נסה לחלץ את שם האירוע (title) והתאריך/שעה המדויקים (target_date). 
החזר אך ורק אובייקט JSON עם:
"title": שם האירוע (למשל "טיסה ללונדון", "עוד שעתיים", "2 דקות").
"target_date": זמן היעד בפורמט ISO 8601 מלא בעתיד (למשל "2026-10-15T12:00:00.000Z").
אל תחזיר טקסט מחוץ ל-JSON.`;
        
        const res = await callGoogleGeminiModel(GEMINI_API_KEY, model, prompt, [], "החזר JSON בלבד", 8_000);
        if (res.ok) {
          const smart = JSON.parse(res.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim());
          if (smart.target_date && smart.title) {
            const targetAt = new Date(smart.target_date);
            if (targetAt.getTime() > Date.now()) {
              await startCountdown(chatId, String(smart.title).slice(0, 80), targetAt);
              return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
          }
        }
      } catch (e) {
        console.error("[countdown] failed:", e);
      }
      await sendMessage(chatId, "לא הבנתי למתי הספירה לאחור. תפרט קצת יותר (למשל: ספירה לאחור לטיסה ב-20 באוקטובר שעה 10:00).");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (/^(הרעיונות שלי|הפתקים שלי|מתישהו)$/ui.test(text.trim())) {
      await showNotes(chatId);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const addHabitMatch = text.match(/^(?:הוסף הרגל|הרגל חדש)\s*(.+)/u);
    if (legacy && addHabitMatch?.[1]) {
      await addHabit(chatId, addHabitMatch[1].trim());
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const didMatch = text.match(/^(?:עשיתי|ביצעתי)\s*(.+)/u);
    if (legacy && didMatch?.[1] && await logHabit(chatId, null, didMatch[1].trim())) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (/^(הרגלים|ההרגלים שלי|גרף הרגלים)$/ui.test(text.trim())) {
      await showHabits(chatId);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const noteMatch = text.match(/^(?:רעיון|פתק|מתישהו|לזכור):\s*(.+)/u);
    if (legacy && noteMatch?.[1]) {
      await addNote(chatId, noteMatch[1].trim());
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (media && media.mimeType.startsWith("image/")) {
      try {
        const timeFormatter = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "long" });
        const nowStr = timeFormatter.format(new Date());
        const model = await extractionModel(GEMINI_API_KEY);
        const prompt = `אתה בוט חכם שיודע לקרוא טקסט מתמונות. התמונה שצורפה יכולה להיות פלייר, קבלה, הזמנה או פתק.
הזמן המקומי כרגע בישראל הוא: ${nowStr}.
אם יש בתמונה אזכור לאירוע, תור, פגישה או דד-ליין (למשל תור לרופא, חתונה, תשלום חשבון) - חלץ את המשימה ואת תאריך והשעה.
אם אין שעה ספציפית אבל יש תאריך, תציע 09:00 בבוקר או שעה הגיונית.
החזר אך ורק אובייקט JSON תקני עם השדות הבאים (ואם אין משימה רלוונטית בתמונה, החזר {"task": null}):
"task": ניסוח קצר של המשימה (למשל "תור לרופא", "חתונה של דוד").
"time": הזמן בפורמט ISO 8601 (חייב להיות עתידי).
"reason": למה בחרת בזמן הזה (למשל "מופיע בהזמנה", "מופיע בקבלה").
אל תחזיר שום טקסט מחוץ ל-JSON.`;

        const res = await callGoogleGeminiModel(GEMINI_API_KEY, model, prompt, [], "החזר JSON בלבד", 8_000, media);
        if (res.ok) {
          const smart = JSON.parse(res.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim());
          if (smart.task && smart.time) {
            const dueAt = new Date(smart.time);
            if (dueAt.getTime() > Date.now()) {
              // Saved inactive; the user confirms with a button (a meme with a date shouldn't create a reminder).
              const { data: pending } = await supabase.from("reminders").insert({ chat_id: chatId, text: String(smart.task).slice(0, 200), type: "once", time: dueAt.toISOString(), active: false }).select("id").single();
              if (pending?.id) {
                const label = reminderScheduleLabel(dueAt, "once");
                await sendMessage(chatId, `ראיתי בתמונה פרטים על "${smart.task}" (${label}).\nלקבוע לך תזכורת?${smart.reason ? `\n\n(${smart.reason})` : ""}`, {
                  inline_keyboard: [[
                    { text: "✅ כן, תזכיר לי", callback_data: `activate_reminder_${pending.id}` },
                    { text: "לא צריך", callback_data: `discard_reminder_${pending.id}` },
                  ]],
                });
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
              }
            }
          }
        }
      } catch (e) {
        console.error("[ocr] failed:", e);
      }
    }

    if (legacy && detectReminderIntent(text)) {
      const isWeatherDependent = /גשם|מטריה|גשום|שמש|חם|קר|מזג אוויר|סערה|שלג/ui.test(text);
      const parsed = isWeatherDependent ? null : parseReminder(text);
      const scheduled: NewReminder | null = parsed
        ? { task: parsed.task, dueAt: parsed.dueAt, type: parsed.type }
        : await smartSchedule(text);
      if (scheduled) {
        await saveReminder(chatId, personality, text, { ...scheduled, confirmNeeded: parseSmartHints(text).confirmNeeded === true });
      } else {
        await askWhen(chatId, text.replace(REMINDERTRIGGER, "").trim() || "את זה", "once");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const [histData, memRaw, profData, goalsData, eventsData, jokesData, phrasesData, remData] = await Promise.all([
      historyPromise,
      fetchMemories(supabase, chatId),
      fetchProfile(supabase, chatId),
      fetchGoals(supabase, chatId),
      fetchEvents(supabase, chatId),
      fetchInsideJokes(supabase, chatId),
      fetchRecentPhrases(supabase, chatId),
      supabase.from("reminders").select("id, text, time").eq("chat_id", chatId).eq("active", true),
    ]);
    const history = histData;
    const memories = rankMemories(memRaw).slice(0, 5);
    const profile = profData;
    const goals = goalsData.slice(0, 3);
    const events = eventsData.slice(0, 3);
    const jokes = jokesData;
    const recentPhrases = phrasesData;

    const remindersContext = (remData.data && remData.data.length > 0) ? `[מערכת]: התזכורות הפעילות של המשתמש כרגע (עם תאריך ושעה):\n${remData.data.map((r: any) => `- ${r.text} (זמן מתוכנן: ${new Date(r.time).toLocaleString("he-IL", { timeZone: TZ })})`).join("\n")}\nהשתמש במידע זה כדי לענות במדויק אם המשתמש שואל מתי תזכורת מסוימת.` : "";

    const lastBot = [...history].reverse().find((item) => item.role === "assistant")?.content ?? "";
    const pace = computePacing(text, lastBot, profile);

    // Instant reply strictly for single laughter triggers ("חחח", "😂")
    if (pace.instantReply && isLaugh(text)) {
      await sendMessage(chatId, pace.instantReply);
      background(saveMessage(chatId, "user", text), "save_user_instant");
      background(saveMessage(chatId, "assistant", pace.instantReply), "save_assistant_instant");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const lastMsg = history.length > 0 ? history[history.length - 1] : null;
    const gapMinutes = lastMsg?.created_at ? (Date.now() - new Date(lastMsg.created_at).getTime()) / 60_000 : 0;
    
    let timeGapLayer = "";
    if (gapMinutes > 20) { // 20 minutes is enough to break context on WhatsApp
      timeGapLayer = `שים לב: זו חזרה לשיחה אחרי הפסקה של ${Math.round(gapMinutes)} דקות. התייחס בעיקר להודעה החדשה של המשתמש (ההודעות הקודמות הן רק רקע). תהיה קצר ולעניין.`;
      // Keep only the last few messages: enough to resolve "זה"/"אותו", not enough to drag up stale topics.
      history.splice(0, Math.max(0, history.length - 4));
    }

    const mode = /אין לי כוח|קשה לי|עייף|שרוף|נמאס|מבאס/.test(text) ? "frustration" : /סיימתי|עשיתי|הצלחתי|שלחתי|סגרתי|קבעתי|השלמתי|בוצע|סגור|סידרתי|ניקיתי|הלכתי|כתבתי/.test(text) ? "success" : "casual";
    const mood = pickMood(personality, { mode, hourLocal: israelParts().hour, repeatStreak: 0, gapMinutes, prevMood: user.mood });
    const humor = humorPolicy({ text, mode, tone: "neutral", intensity: 0, mood, userHumorLevel: profile.humor_level });
    const deep = detectDeepMode(text, history);
    
    let praiseLayer = "";
    if (mode === "success") {
      praiseLayer = "המשתמש ציין שהוא סיים משימה או עשייה. פרגן לו! בנוסף: אם מדובר במשימה פיזית (כמו סידור החדר או אימון) ואתה במצב רוח ציני או חושד שהוא רק מתבדח/מורח אותך, אתגר אותו בהומור ובקש תמונה כהוכחה (למשל 'שלח תמונה של החדר לראות שהוא באמת מסודר'). לא חובה בכל פעם, רק כשזה מתאים לזרימה.";
    } else if (mode === "frustration") {
      praiseLayer = "המשתמש מתוסכל, עייף או שבוז. עזוב את הציניות בצד. תהיה חבר אמת! תגיד לו לעזוב את המשימות, תשאל מה קרה ותציע לו תמיכה אמיתית. (מצב Empathy Mode הופעל).";
    }

    const material = [...goals.map((g: any) => g.title), ...events.map((e: any) => e.title)];
    const surprise = rollSurprise(material.length > 0, deep.deep);
    const decision = decisionEngine({ text, pacing: pace, hasMemory: memories.length > 0, hasGoals: goals.length > 0, humorLevel: profile.humor_level, mood: moodLabel(mood) });

    const timeFormatter = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, weekday: "long", hour: "2-digit", minute: "2-digit" });
    const fullDateFormatter = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, year: "numeric", month: "long", day: "numeric" });
    const currentTimeStr = timeFormatter.format(new Date());
    const currentDateStr = fullDateFormatter.format(new Date());
    const currentTimeLayer = `[מידע רקע נסתר]: הזמן הנוכחי: יום ${currentTimeStr}, התאריך: ${currentDateStr}. אל תציין את היום או השעה בתשובה שלך בשום אופן.`;

    const pointsLayer = 'מידע פנימי: למשתמש יש כרגע ' + (user.points || 0) + ' נקודות, ורצף של ' + (user.streak_days || 0) + ' ימים. אם הוא שואל אותך על הנקודות שלו, חובה לענות לו עם המספרים האלו!';
    const isFemale = user.gender === "female" || profile.address_style?.includes("נקבה");
    const isMale = user.gender === "male" || profile.address_style?.includes("זכר");
    const genderLayer = isFemale
      ? "חוק ברזל לשוני: המשתמשת היא אישה! חובה מוחלטת לפנות אליה אך ורק בלשון נקבה (למשל: את, רוצה, תעשי, הלכת, תזכרי, איתך, שלך)!"
      : isMale
      ? "חוק ברזל לשוני: המשתמש הוא גבר! חובה מוחלטת לפנות אליו אך ורק בלשון זכר (למשל: אתה, רוצה, תעשה, הלכת, תזכור, איתך, שלך)!"
      : "";
    const nameLayer = user.first_name ? `שם המשתמש: ${user.first_name}. פנה אליו/אליה בשם זה בטבעיות מדי פעם.` : "";

    const layers = [
      currentTimeLayer,
      timeGapLayer,
      praiseLayer,
      genderLayer,
      nameLayer,
      pointsLayer,
      remindersContext,
      memoryContext(memories), confidenceContext(memories), profileContext(profile), goalContext(goals), eventContext(events), insideJokeContext(jokes),
      coreferenceInstruction(text, history), implicitIntentLayer(text, { events, goals, reminders: (remData.data ?? []).map((r: { text: string }) => r.text) }),
      moodInstruction(mood, 0), humor.instruction, toneOverrideInstruction(user.tone_override), followUpNudge(text), linkedReasoning(text, memories, goals, profile), selfCorrectionLayer(text, memories, goals),
      deep.deep ? deepModeInstruction(deep.topic) : pace.instruction, surpriseInstruction(surprise, material), antiRepetitionInstruction(recentPhrases), decision.layer,
      completionInstruction
    ];

    background(saveMessage(chatId, "user", text), "save_user");

    const reply = await askGemini(text, personality, history, "", layers, media);

    let finalReply = reply;
    
    const completeMatch = finalReply.match(/\[CMD_COMPLETE:\s*([^\]]+)\]/i);
    if (completeMatch) {
      finalReply = finalReply.replace(completeMatch[0], "").trim();
      const reminderId = completeMatch[1].trim();
      const pointsString = await markReminderDone(chatId, reminderId);
      if (pointsString) {
        finalReply += pointsString;
      }
    }

    let gifUrl: string | null = null;
    const stickerMatch = finalReply.match(/\[(?:GIF|STICKER):\s*(.+?)\]/i);
    if (stickerMatch) {
      finalReply = finalReply.replace(stickerMatch[0], "").trim();
      const GIPHY_API_KEY = Deno.env.get("GIPHY_API_KEY") ?? "";
      if (GIPHY_API_KEY) {
         try {
           const query = encodeURIComponent(stickerMatch[1].trim().slice(0, 50));
           const url = `https://api.giphy.com/v1/stickers/search?api_key=${GIPHY_API_KEY}&q=${query}&limit=5`;
           const gRes = await fetch(url);
           const gData = gRes.ok ? await gRes.json() : null;
           if (gData?.data?.length) {
             const randomSticker = gData.data[Math.floor(Math.random() * gData.data.length)];
             gifUrl = randomSticker?.images?.original?.url || null;
           }
         } catch (e) {
           console.error("[telegram] Giphy fetch failed", e);
         }
      }
    }
    
    if (gifUrl) {
       await sendTelegramAnimation(chatId, gifUrl, finalReply);
    } else {
       await sendMessage(chatId, finalReply);
    }
    
    // We should save the finalReply (without the hidden tag) to history
    background(saveMessage(chatId, "assistant", finalReply), "save_assistant");
    background(rememberPhrase(supabase, chatId, finalReply), "remember_phrase");
    background(logBehavior(supabase, chatId, "message", { len: text.length }), "log_message");
    if (isLaugh(text)) background(logBehavior(supabase, chatId, "laughed"), "log_laughed");
    background(learnFromBehavior(supabase, chatId, profile), "learn_behavior");
    background(runBackgroundPipelines(chatId, text, reply, history, memories, profile), "pipelines");

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (error) {
    // Log server-side only. Always answer 200 so Telegram doesn't retry the same update forever.
    console.error("[telegram] unhandled error:", error instanceof Error ? error.stack : error);
    background(supabase.from("bot_errors").insert({ code: "unhandled", message: String(error instanceof Error ? error.message : error).slice(0, 1000), status: 500 }), "log_error");
    return OK();
  }
});
