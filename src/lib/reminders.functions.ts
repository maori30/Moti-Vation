import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const DAY_TO_INT: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const SaveInput = z.object({
  clientId: z.string(),
  phone: z.string().min(6),
  text: z.string().min(1),
  kind: z.enum(["once", "recurring", "nag"]),
  at: z.string().optional(),
  time: z.string().optional(),
  days: z.array(z.string()).optional(),
  nag_every_min: z.number().int().positive().optional(),
  nag_until: z.string().optional(),
  timezone: z.string().optional(),
});

export const saveReminder = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => SaveInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const days = data.days?.map((d) => DAY_TO_INT[d]).filter((n) => n !== undefined) as number[] | undefined;
    const { error } = await supabaseAdmin.from("reminders").insert({
      id: data.clientId,
      phone: data.phone,
      text: data.text,
      kind: data.kind,
      at: data.at ?? null,
      time: data.time ?? null,
      days: days ?? null,
      nag_every_min: data.nag_every_min ?? null,
      nag_until: data.nag_until ?? null,
      timezone: data.timezone ?? "Asia/Jerusalem",
    });
    if (error) {
      console.error("saveReminder error", error);
      throw new Error(error.message);
    }
    return { ok: true };
  });

const DeleteInput = z.object({ phone: z.string(), text: z.string() });

export const deleteReminderByText = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => DeleteInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("reminders")
      .delete()
      .eq("phone", data.phone)
      .eq("text", data.text);
    if (error) throw new Error(error.message);
    return { ok: true };
  });