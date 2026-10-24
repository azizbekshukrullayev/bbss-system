# BBSS SYSTEM Supabase Edge Functions

This repository mirrors the currently deployed Supabase function sources for reproducibility. Never put runtime secrets in GitHub.

## Course access function

- Name: `bbss-video-url`
- Deployed version when audited: 11
- Supabase JWT verification: `false` because this handler validates Telegram Mini App `initData` HMAC itself. Keep this configuration intentional; the handler performs its own authentication.
- Runtime secrets stay in Supabase Edge Function Secrets only. Never add Telegram bot tokens, Bunny token keys, or Supabase service keys here.

Browser actions handled by `bbss-video-url`:
- `catalog`
- video URL generation (`lessonId`)
- `grant_access`
- `admin_list_enrollments`
- `revoke_access`
- `upload_profile_photo`

Admin actions verify the Telegram user against `BBSS_ADMIN_TELEGRAM_ID` on the server. Video access is checked against `enrollments`. Bunny embed URLs and avatar URLs are short-lived; student avatars use the private `student-avatars` bucket.

## Retired payment endpoints

The following deployed handlers have been replaced with a `410 PAYMENT_PROVIDER_DISABLED` response, because the selected workflow is manual card transfer with admin approval rather than Telegram Stars, Click, or Payme:
- `bbss-stars-payment`
- `create-web-order`
- `click-shop-api`
- `payme-merchant-api`
- `payment-status`

Their source stubs are in matching folders under this directory. The manual Telegram chat flow for showing card details and collecting receipts is a separate feature and is **not implemented by these retired handlers**. Until that flow is built, an admin can still manually verify a transfer and grant access through the course admin panel.

## Database changes

Migration `20261024131814_secure_rls_trigger_and_optimize_indexes.sql` was applied to the connected project and is checked into `supabase/migrations`. It:
- revokes direct execution of the internal RLS event-trigger function,
- removes a duplicate enrollment index,
- adds indexes for foreign-key columns,
- optimizes the two user-owned web-payment RLS predicates.

Several data tables intentionally have RLS enabled with no client policies: this means direct browser access is denied. Server operations use server-side credentials; do not add public policies to these tables just to silence the advisor.

## Deploy notes

Use the tracked `supabase/config.toml` JWT settings when deploying with the Supabase CLI. Keep the private `student-avatars` bucket and the database schema intact.
