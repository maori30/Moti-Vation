import { createFileRoute } from "@tanstack/react-router";
import { sendWhatsAppReminder } from "@/lib/whatsapp.server";

type Reminder = {
  id: string;
  phone: string;
  text: string;
  kind: "once" | "recurring" | "nag";
  at: string | null;
  time: string | null;
  days: number[] | null;
  timezone: string;
  nag_every_min: number | null;
  nag_until: string | null;
  active: boolean;
  last_sent_at: string | null;
};

function localParts(iso: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(iso).map((p) => [p.type, p.value]));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    hhmm: `${parts.hour}:${parts.minute}`,
    weekday: weekdayMap[parts.weekday as string] ?? -1,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function isDue(r: Reminder, now: Date): boolean {
  if (!r.active) return false;
  if (r.kind === "once") {
    if (!r.at) return false;
    if (r.last_sent_at) return false;
    return new Date(r.at).getTime() <= now.getTime();
  }
  if (r.kind === "recurring") {
    if (!r.time) return false;
    const { hhmm, weekday, date } = localParts(now, r.timezone);
    if (r.days && r.days.length > 0 && !r.days.includes(weekday)) return false;
    if (hhmm !== r.time) return false;
    if (r.last_sent_at) {
      const lastLocal = localParts(new Date(r.last_sent_at), r.timezone);
      if (lastLocal.date === date && lastLocal.hhmm === hhmm) return false;
    }
    return true;
  }
  if (r.kind === "nag") {
    if (r.nag_until && new Date(r.nag_until).getTime() < now.getTime()) return false;
    const every = (r.nag_every_min ?? 30) * 60_000;
    if (!r.last_sent_at) return true;
    return now.getTime() - new Date(r.last_sent_at).getTime() >= every;
  }
  return false;
}

export const Route = createFileRoute("/api/public/hooks/tick-reminders")({
  server: {
    handlers: {
      POST: async () => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin
          .from("reminders")
          .select("*")
          .eq("active", true);
        if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

        const now = new Date();
        const rows = (data ?? []) as Reminder[];
        const results: Array<{ id: string; ok: boolean; line?: string; error?: string }> = [];

        for (const r of rows) {
          if (!isDue(r, now)) continue;
          try {
            const res = await sendWhatsAppReminder(r.phone, r.text, { nag: r.kind === "nag" });
            const updates: Record<string, unknown> = { last_sent_at: now.toISOString() };
            if (r.kind === "once") updates.active = false;
            if (r.kind === "nag" && r.nag_until && new Date(r.nag_until).getTime() < now.getTime()) {
              updates.active = false;
            }
            await supabaseAdmin.from("reminders").update(updates).eq("id", r.id);
            results.push({ id: r.id, ok: res.ok, line: res.line });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            results.push({ id: r.id, ok: false, error: msg });
          }
        }

        return Response.json({ ok: true, processed: results.length, results });
      },
      GET: async () => Response.json({ ok: true, hint: "POST to trigger" }),
    },
  },
});