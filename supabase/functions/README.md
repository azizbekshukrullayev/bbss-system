# BBSS SYSTEM Supabase Edge Function

This repository mirrors the currently deployed Supabase Edge Function source for reproducibility.

## Function

- Name: `bbss-video-url`
- Current deployed version when mirrored: 11
- Supabase JWT verification: `false` because the handler validates Telegram Mini App `initData` HMAC itself. Keep this configuration intentional; do not rely on the platform JWT check for this endpoint.
- Runtime secrets are configured only in Supabase Edge Function Secrets. Never add bot tokens, Bunny token keys, or Supabase service keys to GitHub.

## Deploy notes

Deploy the `index.ts` file through Supabase Dashboard → Edge Functions → `bbss-video-url` → Edit/Deploy, and preserve the current Secrets. Keep the existing private `student-avatars` Storage bucket and the existing database migrations.

The browser invokes this function for:
- `catalog`
- video URL generation (body includes `lessonId`)
- `grant_access`
- `admin_list_enrollments`
- `revoke_access`
- `upload_profile_photo`

Admin actions verify the Telegram user against `BBSS_ADMIN_TELEGRAM_ID` on the server. Video access is checked server-side against `enrollments`. The function returns short-lived Bunny embed URLs and private, time-limited avatar URLs.
