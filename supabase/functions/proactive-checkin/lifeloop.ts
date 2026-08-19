/* eslint-disable @typescript-eslint/no-explicit-any */
type Supa = any;

export type LifeLoopReason = {
  score: number;
  kind: "event_soon" | "event_passed" | "goal_stale" | "memory_callback" | "silence";
  message: string;
};

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export async function lifeLoopDecide(
  supabase: Supa,
  chatId: number,
  opts: { hoursSinceLastUser: number; hoursSinceLastProactive: number },
): Promise<LifeLoopReason | null> {
  // Never start a generic conversation with someone who is still active.
  if (opts.hoursSinceLastProactive < 20) return null;

  const now = Date.now();
  const reasons: LifeLoopReason[] = [];

  try {
    const [{ data: events }, { data: goals }, { data: memories }] = await Promise.all([
      supabase
        .from("user_events")
        .select("id, title, when_at, importance, status, asked_after_at")
        .eq("chat_id", chatId)
        .limit(20),
      supabase
        .from("goals")
        .select("id, title, progress, updated_at")
        .eq("chat_id", chatId)
        .eq("status", "open")
        .limit(10),
      supabase
        .from("user_memories")
        .select("value, kind, created_at, importance")
        .eq("chat_id", chatId)
        .in("kind", ["project", "request"])
        .limit(10),
    ]);

    for (const event of events ?? []) {
      const importance = event.importance ?? 2;
      if (event.status === "open" && event.when_at) {
        const hoursUntil = (new Date(event.when_at).getTime() - now) / 3_600_000;
        if (hoursUntil > 2 && hoursUntil < 30) {
          reasons.push({
            score: 7 + importance,
            kind: "event_soon",
            message: pick([
              `מחר יש לך את ${event.title}. רק מזכיר בקטנה.`,
              `${event.title} מתקרב. מוכן לזה?`,
              `נזכרתי שיש לך ${event.title} בקרוב. הכול מסודר?`,
            ]),
          });
        }
      }

      if (event.status === "passed" && !event.asked_after_at) {
        reasons.push({
          score: 8 + importance,
          kind: "event_passed",
          message: pick([
            `נו, איך הלך עם ${event.title}?`,
            `לא סיפרת לי מה קרה עם ${event.title}.`,
            `${event.title} כבר עבר — איך היה?`,
          ]),
        });
      }
    }

    for (const goal of goals ?? []) {
      const staleDays = (now - new Date(goal.updated_at ?? now).getTime()) / 86_400_000;
      if (staleDays >= 14) {
        reasons.push({
          score: 5,
          kind: "goal_stale",
          message: pick([
            `מה קורה עם ${goal.title}? עדיין רלוונטי?`,
            `נזכרתי במטרה של ${goal.title}. התקדמת קצת?`,
          ]),
        });
      }
    }

    for (const memory of memories ?? []) {
      const staleDays = (now - new Date(memory.created_at).getTime()) / 86_400_000;
      if (staleDays >= 7 && (memory.importance ?? 2) >= 2) {
        reasons.push({
          score: 3 + (memory.importance ?? 2),
          kind: "memory_callback",
          message: pick([
            `נזכרתי ב"${memory.value}". מה קרה עם זה?`,
            `"${memory.value}" עדיין על הפרק?`,
          ]),
        });
      }
    }

    // A generic silence nudge is deliberately the lowest-priority option.
    if (opts.hoursSinceLastUser >= 72) {
      reasons.push({
        score: 1,
        kind: "silence",
        message: pick(["היי, הכול טוב אצלך?", "מה איתך בזמן האחרון?"]),
      });
    }

    if (!reasons.length) return null;
    reasons.sort((a, b) => b.score - a.score);
    return reasons[0];
  } catch (error) {
    console.error("[lifeloop] failed:", error);
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

    await supabase
      .from("users")
      .update({ last_life_loop_at: new Date().toISOString() })
      .eq("chat_id", chatId);
  } catch (error) {
    console.error("[lifeloop] mark sent failed:", error);
  }
}
