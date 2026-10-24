-- This migration was applied directly to the connected Supabase project.
-- It secures the internal RLS event-trigger function and resolves duplicate / unindexed-key findings.

REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;

-- A matching unique index already exists under enrollments_telegram_id_course_id_key.
DROP INDEX IF EXISTS public.enrollments_telegram_id_course_id_uidx;

CREATE INDEX IF NOT EXISTS enrollments_course_id_idx
  ON public.enrollments (course_id);

CREATE INDEX IF NOT EXISTS lesson_progress_lesson_id_idx
  ON public.lesson_progress (lesson_id);

CREATE INDEX IF NOT EXISTS payment_requests_course_id_idx
  ON public.payment_requests (course_id);

CREATE INDEX IF NOT EXISTS web_course_access_course_id_idx
  ON public.web_course_access (course_id);

CREATE INDEX IF NOT EXISTS web_payment_orders_course_id_idx
  ON public.web_payment_orders (course_id);

ALTER POLICY web_payment_orders_select_own
  ON public.web_payment_orders
  USING (user_id = (SELECT auth.uid()));

ALTER POLICY web_course_access_select_own
  ON public.web_course_access
  USING (user_id = (SELECT auth.uid()) AND revoked_at IS NULL);
