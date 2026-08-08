import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const TZ = Deno.env.get("BOT_TIMEZONE") ?? "Asia/Jerusalem";

async function sendTelegramMessage(chatId: number, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }) });
    if (!res.ok) { const errText = await res.text(); await supabase.from("bot_errors").insert({ status: res.status, code: "PROACTIVE_TG_SEND_FAILED", message: errText.slice(0, 400) }).then(() => {}, () => {}); return false; }
    return true;
  } catch { return false; }
}

function isQuietHoursNow(): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date()));
  return hour < 8 || hour >= 22;
}

const TOPICS: { keywords: RegExp; prompts: string[] }[] = [
  { keywords: /ביטוח|תעודת ביטוח|קופת חולים/, prompts: ["משהו חדש שאתה דוחה? אולי לסדר את ת'ביטוח או לקבוע לרופא שיניים? 😏", "עדיין לא סידרת את הביטוח? הוא לא יסתדר לבד, אתה יודע 😅", "רגע, מה קרה עם הביטוח מהשבוע שעבר? נעלם כמו גרב באמבטיה."] },
  { keywords: /רופא שיניים|שיניים|תור לרופא|רופא/, prompts: ["אז... קבעת כבר תור לרופא, או שאתה מחכה שהשן תתקן את עצמה? 🦷", "תזכורת עדינה: הכאב בשן לא נעלם כי התעלמת ממנו שבוע.", "מתי בפעם האחרונה שראית רופא? ולא, יוטיוב לא נחשב."] },
  { keywords: /תשלום|לשלם|חשבון|חוב|כרטיס אשראי/, prompts: ["יש חשבון שמחכה לך בפינה ומצטבר עליו ריבית של דאגה. שילמת?", "תזכורת לא נעימה: חשבונות לא נעלמים כשמתעלמים מהם, הם רק מתרבים 💸"] },
  { keywords: /ספר|ללמוד|בחינה|מבחן|קורס/, prompts: ["איך הולך עם הלימודים? או שגם היום ה'מחר אני מתחיל' עבד מצוין?", "מבחן מתקרב ואתה עדיין כאן מדבר איתי במקום ללמוד... בסדר, זה בסדר 😄"] },
  { keywords: /ספורט|כושר|לרוץ|חדר כושר|דיאטה/, prompts: ["היה לך תוכנית כושר השבוע. היא עדיין בתוכנית, או שהיא עברה לפרק 'תוכניות שנשכחו'?", "מתי בפעם האחרונה שזזת חוץ מללחוץ על המקלדת? 😅"] },
];
const GENERIC_PROMPTS = ["היי, מה נשמע? יש משהו שאתה דוחה כבר יותר מדי זמן? 👀", "לא שמעתי ממך כבר יומיים... נעלמת, או שפשוט אין לך תזכורות דחופות?", "בדיקת שפיות: אתה עדיין בחיים? תגיד לי שלא שכחת גם אותי 😂", "רגע של כנות — יש עוד דבר אחד שאתה דוחה שלא סיפרת לי עליו?"];
function pickRandom<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

async function findStaleTopicPrompt(chatId: number): Promise<string | null> {
  const { data: recentMessages } = await supabase.from("messages").select("content, role, created_at").eq("chat_id", chatId).eq("role", "user").order("created_at", { ascending: false }).limit(30);
  if (!recentMessages?.length) return null;
  const { data: activeReminders } = await supabase.from("reminders").select("text").eq("chat_id", chatId).eq("active", true);
  const activeText = (activeReminders ?? []).map((r) => r.text).join(" ");
  for (const msg of recentMessages) for (const topic of TOPICS) if (topic.keywords.test(msg.content) && !topic.keywords.test(activeText)) return pickRandom(topic.prompts);
  return null;
}

Deno.serve(async (_req: Request) => {
  try {
    if (isQuietHoursNow()) return new Response(JSON.stringify({ ok: true, skipped: "quiet_hours" }), { status: 200 });
    const { data: users, error } = await supabase.from("users").select("chat_id, last_proactive_at");
    if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 200 });
    let sent = 0; const now = new Date();
    for (const u of users ?? []) {
      if (u.last_proactive_at && (now.getTime() - new Date(u.last_proactive_at).getTime()) / 3600000 < 20) continue;
      const topicPrompt = await findStaleTopicPrompt(u.chat_id);
      const prompt = topicPrompt && Math.random() < 0.7 ? topicPrompt : pickRandom(GENERIC_PROMPTS);
      if (await sendTelegramMessage(u.chat_id, prompt)) { await supabase.from("users").update({ last_proactive_at: now.toISOString() }).eq("chat_id", u.chat_id); sent++; }
    }
    return new Response(JSON.stringify({ ok: true, sent }), { status: 200 });
  } catch (err) { console.error("[proactive-checkin] fatal:", err); return new Response(JSON.stringify({ ok: false }), { status: 200 }); }
});
