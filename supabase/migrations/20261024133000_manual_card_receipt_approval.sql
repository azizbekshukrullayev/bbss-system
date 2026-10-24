-- Manual card-receipt workflow for BBSS SYSTEM.
-- Telegram users submit a receipt; an admin verifies it and approves it.
-- The RPC is invoker-security and executable only by the server role.

CREATE UNIQUE INDEX IF NOT EXISTS payment_requests_one_pending_manual_card_uidx
  ON public.payment_requests (telegram_id, course_id)
  WHERE status = 'pending' AND payment_method = 'manual_card';

CREATE OR REPLACE FUNCTION public.approve_manual_payment_request(
  p_request_id uuid,
  p_admin_telegram_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_payment public.payment_requests%ROWTYPE;
  v_course public.courses%ROWTYPE;
BEGIN
  SELECT *
    INTO v_payment
    FROM public.payment_requests
   WHERE id = p_request_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment request not found';
  END IF;

  IF v_payment.status <> 'pending' THEN
    RAISE EXCEPTION 'Payment request is not pending';
  END IF;

  IF v_payment.payment_method <> 'manual_card'
     OR v_payment.currency <> 'UZS'
     OR v_payment.receipt_path IS NULL THEN
    RAISE EXCEPTION 'Payment request is not a valid manual card receipt';
  END IF;

  SELECT *
    INTO v_course
    FROM public.courses
   WHERE id = v_payment.course_id;

  IF NOT FOUND OR v_course.price_uzs IS NULL OR v_course.price_uzs <= 0 THEN
    RAISE EXCEPTION 'Course price is not configured';
  END IF;

  IF v_payment.amount <> v_course.price_uzs THEN
    RAISE EXCEPTION 'Receipt amount does not match the current course price';
  END IF;

  INSERT INTO public.students (telegram_id)
  VALUES (v_payment.telegram_id)
  ON CONFLICT (telegram_id) DO NOTHING;

  INSERT INTO public.enrollments (
    telegram_id,
    course_id,
    status,
    granted_at,
    expires_at
  )
  VALUES (
    v_payment.telegram_id,
    v_payment.course_id,
    'active',
    now(),
    NULL
  )
  ON CONFLICT (telegram_id, course_id)
  DO UPDATE SET
    status = 'active',
    granted_at = now(),
    expires_at = NULL;

  UPDATE public.payment_requests
     SET status = 'approved',
         reviewed_at = now(),
         admin_note = 'Approved by Telegram admin ID ' || coalesce(p_admin_telegram_id, 'unknown')
   WHERE id = p_request_id;

  RETURN jsonb_build_object(
    'ok', true,
    'telegram_id', v_payment.telegram_id,
    'course_id', v_payment.course_id,
    'course_title', v_course.title,
    'amount', v_payment.amount,
    'currency', v_payment.currency
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.approve_manual_payment_request(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_manual_payment_request(uuid, text)
  TO service_role;
