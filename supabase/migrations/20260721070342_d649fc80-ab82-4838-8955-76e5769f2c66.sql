DROP POLICY IF EXISTS "Open access to reminders" ON public.reminders;
REVOKE ALL ON public.reminders FROM anon, authenticated, PUBLIC;
GRANT ALL ON public.reminders TO service_role;
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny all direct client access" ON public.reminders FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);