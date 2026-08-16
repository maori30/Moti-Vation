// Life Loop for the proactive job — kept local so this function bundles standalone.
// Mirrors the LIFE LOOP section of telegram/awareness.ts:
// memories → goals → reminders → habits → past conversations → future events
// → is there a real reason to reach out right now?
/* eslint-disable @typescript-eslint/no-explicit-any */
type Supa = any;

export type LifeLoopReason = {
  score: number;
  kind: "event_soon" | "event_passed" | "goal_stale" | "memory_callback" | "habit" | "silence";
  message: string;
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function lifeLoopDecide(
  supabase: Supa,
  chatId: number,
  opts: { hoursSinceLastUser: number; hoursSinceLastProactive: number },
): Promise<LifeLoopReason | null> {
  const reasons: LifeLoopReason[] = [];
  const now = Date.now();
  try {
    const [{ data: events }, { data: goals }, { data: mems }] = await Promise.all([
      supabase
        .from("user_events")
        .select("id, title, when_at, when_text, importance, status, asked_after_at")
        .eq("chat_id", chatId)
        .limit(20),
      supabase.from("goals").select("id, title, progress, updated_at").eq("chat_id", chatId).eq("status", "open").limit(10),
      supabase
        .from("user_memories")
        .select("value, kind, created_at, importance")
        .eq("chat_id", chatId)
        .in("kind", ["project", "request"])
        .limit(10),
    ]);

    for (const e of events ?? []) {
      const imp = e.importance ?? 2;
      if (e.status === "open" && e.when_at) {
        const h = (new Date(e.when_at).getTime() - now) / 3_600_000;
        if (h > 2 && h < 30) {
          reasons.push({
            score: 6 + imp,
            kind: "event_soon",
            message: pick([
              `מחר יש לך את ${e.title}. רק אומר 😏`,
              `${e.title} מתקרב. מוכן, או שנעשה כאילו לא דיברנו?`,
              `תזכורת שקטה: ${e.title}. זהו, לא מציק יותר.`,
            ]),
          });
        }
      }
      if (e.status === "passed" && !e.asked_after_at) {
        reasons.push({
          score: 7 + imp,
          kind: "event_passed",
          message: pick([`נו? איך הלך עם ${e.title}?`, `לא סיפרת לי מה קרה עם ${e.title}. 👀`, `${e.title} — עבר. חי לספר?`]),
        });
      }
    }

    for (const g of goals ?? []) {
      const days = (now - new Date(g.updated_at ?? Date.now()).getTime()) / 86_400_000;
      if (days >= 12) {
        reasons.push({
          score: 5,
          kind: "goal_stale",
          message: pick([
            `עברו כמעט שבועיים מאז שאמרת שאתה רוצה ${g.title}. התקדמת?`,
            `${g.title} — עדיין על השולחן, או שעברנו לשלב ההכחשה?`,
          ]),
        });
      }
    }

    for (const m of mems ?? []) {
      const days = (now - new Date(m.created_at).getTime()) / 86_400_000;
      if (days >= 5) {
        reasons.push({
          score: 3 + (m.importance ?? 2) / 2,
          kind: "memory_callback",
          message: pick([`רגע, לא אמרת לי איך הלך עם "${m.value}".`, `"${m.value}" — עדיין רלוונטי, או שנשכח מזה יפה?`]),
        });
      }
    }

    if (opts.hoursSinceLastUser >= 60) {
      reasons.push({
        score: 2,
        kind: "silence",
        message: pick(["נעלמת. הכל טוב?", "יומיים שקט. או שסידרת הכל, או שאתה מתחבא 👀"]),
      });
    }

    if (!reasons.length) return null;
    if (opts.hoursSinceLastProactive < 20) return null;
    reasons.sort((a, b) => b.score - a.score);
    // A little randomness so it doesn't feel like a scheduler.
    const top = reasons.slice(0, 2);
    return top[Math.floor(Math.random() * top.length)];
  } catch (e) {
    console.error("[lifeloop] failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

export async function markLifeLoopSent(supabase: Supa, chatId: number, reason: LifeLoopReason) {
  try {
    if (reason.kind === "event_passed") {
      await supabase
        .from("user_events")
        .update({ asked_after_at: new Date().toISOString() })
        .eq("chat_id", chatId)
        .eq("status", "passed")
        .is("asked_after_at", null);
    }
  } catch {
    /* ignore */
  }
}