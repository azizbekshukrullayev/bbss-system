import { createClient } from 'npm:@supabase/supabase-js@2';

const SITE_ORIGIN = 'https://azizbekshukrullayev.github.io';
const APP_URL = 'https://azizbekshukrullayev.github.io/bbss-system/?v=20261025-progress-completion-fix-1';
const COURSE_SLUG = 'bbss-trading-course';
const BUNNY_LIBRARY_ID = '788308';
const AVATAR_BUCKET = 'student-avatars';
const JOURNAL_BUCKET = 'bbss-journal';
const AVATAR_SIGNED_URL_SECONDS = 60 * 60;
const MAX_AVATAR_BYTES = 750 * 1024;
const TOKEN_LIFETIME_SECONDS = 15 * 60;

const corsHeaders = {
  'Access-Control-Allow-Origin': SITE_ORIGIN,
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

async function hmacSha256(
  keyBytes: Uint8Array,
  messageBytes: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  return new Uint8Array(
    await crypto.subtle.sign('HMAC', key, messageBytes),
  );
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  );
}

async function callTelegramBotApi(
  botToken: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );

  let result: { ok?: boolean; description?: string; result?: unknown };
  try {
    result = await response.json();
  } catch {
    throw new Error(`Telegram API ${method} invalid JSON response`);
  }

  if (!response.ok || result.ok !== true) {
    throw new Error(
      `Telegram API ${method} failed: ${result.description || response.status}`,
    );
  }

  return result.result;
}

async function expectedTelegramWebhookSecret(botToken: string): Promise<string> {
  // Telegram secret token is derived server-side; the bot token itself is never sent to clients.
  return await sha256Hex(`${botToken}:bbss-manual-card-webhook-v1`);
}

function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;

  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diff === 0;
}

async function verifyTelegramInitData(
  initData: string,
  botToken: string,
) {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  const userRaw = params.get('user');
  const authDate = Number(params.get('auth_date') || 0);

  if (
    !receivedHash ||
    !userRaw ||
    !Number.isFinite(authDate) ||
    authDate <= 0
  ) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);

  if (authDate > now + 120 || now - authDate > 24 * 60 * 60) {
    return null;
  }

  const checkParts: string[] = [];

  for (const [key, value] of params.entries()) {
    if (key !== 'hash') {
      checkParts.push(`${key}=${value}`);
    }
  }

  checkParts.sort((a, b) => {
    const ka = a.slice(0, a.indexOf('='));
    const kb = b.slice(0, b.indexOf('='));
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const dataCheckString = checkParts.join('\n');
  const encoder = new TextEncoder();

  const secretKey = await hmacSha256(
    encoder.encode('WebAppData'),
    encoder.encode(botToken),
  );

  const expectedHash = bytesToHex(
    await hmacSha256(
      secretKey,
      encoder.encode(dataCheckString),
    ),
  );

  if (!safeHexEqual(expectedHash, receivedHash.toLowerCase())) {
    return null;
  }

  try {
    const user = JSON.parse(userRaw);

    if (user?.id === undefined || user?.id === null) {
      return null;
    }

    let photoUrl: string | null = null;

    if (
      typeof user.photo_url === 'string' &&
      user.photo_url.length <= 2048
    ) {
      try {
        const parsed = new URL(user.photo_url);

        if (parsed.protocol === 'https:') {
          photoUrl = parsed.href;
        }
      } catch {
        // Telegram profil rasmi ixtiyoriy.
      }
    }

    return {
      id: String(user.id),
      username:
        typeof user.username === 'string'
          ? user.username.slice(0, 64)
          : null,
      firstName:
        typeof user.first_name === 'string'
          ? user.first_name.slice(0, 128)
          : null,
      lastName:
        typeof user.last_name === 'string'
          ? user.last_name.slice(0, 128)
          : null,
      photoUrl,
    };
  } catch {
    return null;
  }
}

function getSupabaseServerKey(): string | null {
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (serviceRole) return serviceRole;

  const raw = Deno.env.get('SUPABASE_SECRET_KEYS');

  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (typeof parsed.default === 'string') {
      return parsed.default;
    }

    const firstString = Object.values(parsed).find(
      (value) => typeof value === 'string',
    );

    return typeof firstString === 'string' ? firstString : null;
  } catch {
    return null;
  }
}

async function syncTelegramStudentProfile(
  db: ReturnType<typeof createClient>,
  user: {
    id: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
  },
): Promise<void> {
  const profile: Record<string, string> = {
    telegram_id: user.id,
  };

  if (user.username !== null) {
    profile.username = user.username;
  }

  if (user.firstName !== null) {
    profile.first_name = user.firstName;
  }

  if (user.lastName !== null) {
    profile.last_name = user.lastName;
  }

  const { error } = await db
    .from('students')
    .upsert(profile, {
      onConflict: 'telegram_id',
    });

  if (error) {
    throw new Error(
      `Student profilini yangilab bo'lmadi: ${error.message}`,
    );
  }
}

async function resolveStudentPhotoUrl(
  db: ReturnType<typeof createClient>,
  student: { avatar_path?: string | null } | null,
): Promise<string | null> {
  if (!student?.avatar_path) return null;

  const { data, error } = await db.storage
    .from(AVATAR_BUCKET)
    .createSignedUrl(
      student.avatar_path,
      AVATAR_SIGNED_URL_SECONDS,
    );

  if (error || !data?.signedUrl) {
    console.error(
      'Student avatar signed URL failed:',
      error?.message || 'unknown storage error',
    );

    return null;
  }

  return data.signedUrl;
}

async function resolveJournalScreenshotUrl(
  db: ReturnType<typeof createClient>,
  path: string | null | undefined,
): Promise<string | null> {
  if (!path || !/^\d{5,20}\/[0-9a-f-]{36}\.jpg$/i.test(path)) return null;
  const { data, error } = await db.storage
    .from(JOURNAL_BUCKET)
    .createSignedUrl(path, AVATAR_SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) {
    console.warn('Trading journal screenshot URL failed:', error?.message || 'unknown storage error');
    return null;
  }
  return data.signedUrl;
}

async function createCatalog(
  db: ReturnType<typeof createClient>,
  telegramId: string,
  isAdmin: boolean,
) {
  const { data: course, error: courseError } = await db
    .from('courses')
    .select(
      'id,title,slug,description,price,currency,price_uzs,is_published',
    )
    .eq('slug', COURSE_SLUG)
    .maybeSingle();

  if (courseError) {
    throw new Error(`Course lookup failed: ${courseError.message}`);
  }

  if (!course) {
    return {
      course: null,
      modules: [],
      admin: isAdmin,
      accessRequired: false,
    };
  }

  let accessGranted = isAdmin;

  if (!isAdmin) {
    const { data: enrollment, error: enrollmentError } = await db
      .from('enrollments')
      .select('id,status,expires_at')
      .eq('telegram_id', telegramId)
      .eq('course_id', course.id)
      .eq('status', 'active')
      .maybeSingle();

    if (enrollmentError) {
      throw new Error(
        `Enrollment lookup failed: ${enrollmentError.message}`,
      );
    }

    const expired = !!(
      enrollment?.expires_at &&
      new Date(enrollment.expires_at).getTime() <= Date.now()
    );

    accessGranted = !!enrollment && !expired;
  }

  if (!accessGranted) {
    const { data: accessRequest, error: accessRequestError } = await db
      .from('access_requests')
      .select('status')
      .eq('telegram_id', telegramId)
      .eq('course_id', course.id)
      .maybeSingle();

    if (accessRequestError) {
      throw new Error(
        `Access request lookup failed: ${accessRequestError.message}`,
      );
    }

    return {
      course: null,
      modules: [],
      admin: false,
      accessRequired: true,
      accessRequestStatus: accessRequest?.status || null,
    };
  }

  const { data: modules, error: moduleError } = await db
    .from('modules')
    .select(
      'id,course_id,title,description,sort_order,is_published',
    )
    .eq('course_id', course.id)
    .order('sort_order', { ascending: true });

  if (moduleError) {
    throw new Error(`Module lookup failed: ${moduleError.message}`);
  }

  const moduleRows = modules || [];

  if (moduleRows.length === 0) {
    return {
      course,
      modules: [],
      admin: isAdmin,
      accessGranted: true,
    };
  }

  const moduleIds = moduleRows.map((module) => module.id);

  const { data: lessons, error: lessonError } = await db
    .from('lessons')
    .select(
      'id,module_id,title,description,content_type,sort_order,duration_seconds,is_published',
    )
    .in('module_id', moduleIds)
    .order('sort_order', { ascending: true });

  if (lessonError) {
    throw new Error(`Lesson lookup failed: ${lessonError.message}`);
  }

  return {
    course,
    modules: moduleRows.map((module) => ({
      ...module,
      lessons: (lessons || []).filter(
        (lesson) => lesson.module_id === module.id,
      ),
    })),
    admin: isAdmin,
    accessGranted: true,
  };
}

async function getAuthorizedChatCourseId(
  db: ReturnType<typeof createClient>,
  telegramId: string,
  isAdmin: boolean,
): Promise<string | null> {
  const { data: course, error: courseError } = await db
    .from('courses')
    .select('id')
    .eq('slug', COURSE_SLUG)
    .maybeSingle();

  if (courseError) throw new Error('Kursni tekshirib bo‘lmadi: ' + courseError.message);
  if (!course) return null;
  if (isAdmin) return String(course.id);

  const { data: enrollment, error: enrollmentError } = await db
    .from('enrollments')
    .select('id,status,expires_at')
    .eq('telegram_id', telegramId)
    .eq('course_id', course.id)
    .eq('status', 'active')
    .maybeSingle();

  if (enrollmentError) {
    throw new Error('Kirish huquqini tekshirib bo‘lmadi: ' + enrollmentError.message);
  }

  const expired = !!(
    enrollment?.expires_at &&
    new Date(enrollment.expires_at).getTime() <= Date.now()
  );

  return enrollment && !expired ? String(course.id) : null;
}

function getDiagnostic(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === 'object') {
    const err = error as {
      message?: unknown;
      code?: unknown;
      details?: unknown;
      hint?: unknown;
    };

    return [
      typeof err.message === 'string' ? err.message : '',
      typeof err.code === 'string' ? `code=${err.code}` : '',
      typeof err.details === 'string' ? `details=${err.details}` : '',
      typeof err.hint === 'string' ? `hint=${err.hint}` : '',
    ].filter(Boolean).join(' | ') || JSON.stringify(error);
  }

  return String(error);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse(
      { error: 'Faqat POST so‘rovi qabul qilinadi.' },
      405,
    );
  }

  const origin = req.headers.get('origin');

  if (origin && origin !== SITE_ORIGIN) {
    return jsonResponse(
      { error: 'Bu domen uchun ruxsat yo‘q.' },
      403,
    );
  }

  const telegramBotToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const bunnyTokenKey = Deno.env.get('BUNNY_EMBED_TOKEN_KEY');
  const adminTelegramId =
    Deno.env.get('BBSS_ADMIN_TELEGRAM_ID') || '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServerKey = getSupabaseServerKey();

  if (!telegramBotToken || !supabaseUrl || !supabaseServerKey) {
    console.error(
      'Server configuration missing. Check Edge Function secrets and Supabase injected keys.',
    );

    return jsonResponse(
      {
        error:
          'Server sozlamalari to‘liq emas. Secrets sozlamalarini tekshiring.',
      },
      500,
    );
  }

  let body: {
    initData?: string;
    lessonId?: string;
    action?: string;
    targetTelegramId?: string;
    imageData?: string;
    requestId?: string;
    decision?: string;
    message?: string;
    messageId?: string;
    replyToId?: string;
    peerTelegramId?: string;
    includePhotos?: boolean;
    lessonId?: string;
    quizId?: string;
    questionId?: string;
    title?: string;
    description?: string;
    bodyText?: string;
    passPercent?: number;
    questions?: unknown;
    answers?: unknown;
    symbol?: string;
    direction?: string;
    entryPrice?: number | string;
    stopLoss?: number | string | null;
    takeProfit?: number | string | null;
    exitPrice?: number | string | null;
    outcome?: string;
    setup?: string;
    notes?: string;
    saved?: boolean;
    completed?: boolean;
  };

  try {
    body = await req.json();
  } catch {
    return jsonResponse(
      { error: 'So‘rov formati noto‘g‘ri.' },
      400,
    );
  }

  const initData =
    typeof body.initData === 'string' ? body.initData : '';

  if (!initData) {
    return jsonResponse(
      {
        error:
          'Telegram sessiyasi topilmadi. Mini App’ni bot ichidan oching.',
      },
      400,
    );
  }

  const telegramUser = await verifyTelegramInitData(
    initData,
    telegramBotToken,
  );

  if (!telegramUser) {
    return jsonResponse(
      {
        error:
          'Telegram sessiyasi tasdiqlanmadi. Mini App’ni bot ichidan qayta oching.',
      },
      401,
    );
  }

  const isAdmin =
    adminTelegramId.length > 0 &&
    telegramUser.id === adminTelegramId;

  const db = createClient(supabaseUrl, supabaseServerKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  // One-time admin action: configure the Telegram webhook with a secret header.
  // This prevents arbitrary callers from spoofing bot updates.
  if (body.action === 'configure_bot_webhook') {
    if (!isAdmin) {
      return jsonResponse(
        { error: 'Bot webhookini faqat admin sozlashi mumkin.' },
        403,
      );
    }

    try {
      const webhookSecret = await expectedTelegramWebhookSecret(telegramBotToken);
      const webhookUrl = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/bbss-stars-payment`;

      await callTelegramBotApi(telegramBotToken, 'setWebhook', {
        url: webhookUrl,
        secret_token: webhookSecret,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false,
      });

      // Cache-busting URL: eski Telegram WebView nusxasini chetlab o‘tish.
      await callTelegramBotApi(telegramBotToken, 'setChatMenuButton', {
        menu_button: {
          type: 'web_app',
          text: 'BBSS SYSTEM',
          web_app: { url: APP_URL },
        },
      });

      return jsonResponse({
        ok: true,
        message:
          'Telegram webhooki sozlandi. Bot menyusidagi Mini App havolasi yangi versiyaga yangilandi; ilovani menyudan qayta oching.',
      });
    } catch (error) {
      const diagnostic = getDiagnostic(error);
      console.error('Telegram webhook setup failed:', diagnostic);
      return jsonResponse(
        { error: `Telegram webhookini sozlab bo‘lmadi: ${diagnostic}` },
        502,
      );
    }
  }

  // Telegram tomonidan imzosi tekshirilgan ma'lumotlarni saqlaymiz.
  try {
    await syncTelegramStudentProfile(db, {
      id: telegramUser.id,
      username: telegramUser.username,
      firstName: telegramUser.firstName,
      lastName: telegramUser.lastName,
    });
  } catch (profileSyncError) {
    console.error(
      'Telegram student profile sync failed:',
      getDiagnostic(profileSyncError),
    );
  }

  // Ta'lim vositalari: barcha o'quvchi amallari tasdiqlangan kurs ruxsati bilan tekshiriladi.
  async function getLearningCourseId() {
    const courseId = await getAuthorizedChatCourseId(db, telegramUser.id, isAdmin);
    if (!courseId) throw new Error('Bu bo‘lim faqat kursga kirish huquqi faol bo‘lgan studentlar uchun ochiq.');
    return courseId;
  }

  async function validateLearningLesson(courseId: string, lessonId: string, allowUnpublished = false) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lessonId)) {
      throw new Error('Dars identifikatori noto‘g‘ri.');
    }
    const { data: lesson, error: lessonError } = await db.from('lessons')
      .select('id,module_id,is_published').eq('id', lessonId).maybeSingle();
    if (lessonError) throw lessonError;
    if (!lesson || (!allowUnpublished && !lesson.is_published)) throw new Error('Dars topilmadi yoki e’lon qilinmagan.');
    const { data: module, error: moduleError } = await db.from('modules')
      .select('id,course_id,is_published').eq('id', lesson.module_id).eq('course_id', courseId).maybeSingle();
    if (moduleError) throw moduleError;
    if (!module || (!allowUnpublished && !module.is_published)) throw new Error('Dars ushbu kursga tegishli emas.');
    return lesson;
  }

  if (body.action === 'learning_dashboard') {
    try {
      const courseId = await getLearningCourseId();
      const { data: modules, error: modulesError } = await db.from('modules')
        .select('id,title,sort_order,is_published').eq('course_id', courseId).order('sort_order');
      if (modulesError) throw modulesError;
      // Admin preview sees unpublished content for QA; students only receive published modules.
      const moduleRows = (modules || []).filter((item) => isAdmin || item.is_published === true);
      const moduleIds = moduleRows.map((item) => item.id);
      const lessonQuery = moduleIds.length
        ? await db.from('lessons').select('id,module_id,title,description,content_type,duration_seconds,sort_order,is_published')
            .in('module_id', moduleIds).order('sort_order')
        : { data: [], error: null };
      if (lessonQuery.error) throw lessonQuery.error;
      const lessons = (lessonQuery.data || [])
        .filter((lesson) => isAdmin || lesson.is_published === true)
        .map((lesson) => ({
          ...lesson,
          moduleTitle: moduleRows.find((mod) => mod.id === lesson.module_id)?.title || 'Modul',
        }));
      const lessonIds = lessons.map((lesson) => lesson.id);
      const publishedLessonIds = lessons.filter((lesson) => lesson.is_published === true).map((lesson) => lesson.id);

      const progressQuery = lessonIds.length
        ? await db.from('lesson_progress').select('lesson_id,is_completed,completed_at')
            .eq('telegram_id', telegramUser.id).eq('is_completed', true).in('lesson_id', lessonIds)
        : { data: [], error: null };
      if (progressQuery.error) throw progressQuery.error;
      const savedQuery = await db.from('saved_lessons').select('lesson_id')
        .eq('course_id', courseId).eq('telegram_id', telegramUser.id);
      if (savedQuery.error) throw savedQuery.error;
      const quizQuery = await db.from('quizzes').select('id,title,description,pass_percent,created_at')
        .eq('course_id', courseId).eq('is_published', true).order('created_at', { ascending: false }).limit(50);
      if (quizQuery.error) throw quizQuery.error;
      const announcementQuery = await db.from('announcements').select('id,title,body,is_pinned,published_at,created_at')
        .eq('course_id', courseId).eq('is_published', true)
        .order('is_pinned', { ascending: false }).order('published_at', { ascending: false }).limit(20);
      if (announcementQuery.error) throw announcementQuery.error;
      const qaQuery = await db.from('qa_questions')
        .select('id,telegram_id,lesson_id,title,body,status,created_at')
        .eq('course_id', courseId).order('created_at', { ascending: false }).limit(30);
      if (qaQuery.error) throw qaQuery.error;
      const qaRows = qaQuery.data || [];
      const questionIds = qaRows.map((row) => row.id);
      let answerRows: any[] = [];
      if (questionIds.length) {
        const answersQuery = await db.from('qa_answers')
          .select('id,question_id,telegram_id,body,is_admin,created_at')
          .in('question_id', questionIds).order('created_at', { ascending: true });
        if (answersQuery.error) throw answersQuery.error;
        answerRows = answersQuery.data || [];
      }
      const authorIds = [...new Set([
        ...qaRows.map((row) => String(row.telegram_id)),
        ...answerRows.map((row) => String(row.telegram_id)),
      ])];
      const profilesQuery = authorIds.length
        ? await db.from('students').select('telegram_id,username,first_name,last_name').in('telegram_id', authorIds)
        : { data: [], error: null };
      if (profilesQuery.error) throw profilesQuery.error;
      const profileMap = new Map((profilesQuery.data || []).map((profile) => [String(profile.telegram_id), profile]));
      const displayName = (telegramId: string) => {
        const profile = profileMap.get(telegramId);
        return [profile?.first_name || '', profile?.last_name || ''].filter(Boolean).join(' ').trim()
          || (profile?.username ? '@' + profile.username : 'BBSS o‘quvchisi');
      };
      const questions = qaRows.map((row) => ({
        id: String(row.id),
        telegramId: String(row.telegram_id),
        author: displayName(String(row.telegram_id)),
        isMine: String(row.telegram_id) === telegramUser.id,
        lessonId: row.lesson_id ? String(row.lesson_id) : null,
        title: row.title,
        body: row.body,
        status: row.status,
        createdAt: row.created_at,
        answers: answerRows.filter((answer) => String(answer.question_id) === String(row.id)).map((answer) => ({
          id: String(answer.id),
          telegramId: String(answer.telegram_id),
          author: displayName(String(answer.telegram_id)),
          body: answer.body,
          isAdmin: !!answer.is_admin,
          createdAt: answer.created_at,
        })),
      }));
      const journalQuery = await db.from('trading_journal_entries')
        .select('id,symbol,direction,entry_price,stop_loss,take_profit,exit_price,outcome,setup,notes,screenshot_path,created_at')
        .eq('course_id', courseId).eq('telegram_id', telegramUser.id)
        .order('created_at', { ascending: false }).limit(50);
      if (journalQuery.error) throw journalQuery.error;
      const journalEntries = await Promise.all((journalQuery.data || []).map(async (entry) => ({
        ...entry,
        screenshotUrl: await resolveJournalScreenshotUrl(db, entry.screenshot_path),
      })));
      const certQuery = await db.from('certificates')
        .select('id,certificate_code,completed_lessons,total_lessons,issued_at')
        .eq('course_id', courseId).eq('telegram_id', telegramUser.id).order('issued_at', { ascending: false });
      if (certQuery.error) throw certQuery.error;

      let adminStats: Record<string, unknown> | null = null;
      let adminProgress: Array<Record<string, unknown>> = [];
      if (isAdmin) {
        const [enrollments, payments, requests, openQuestions, attempts, journalEntries, completed] = await Promise.all([
          db.from('enrollments').select('id', { count: 'exact', head: true }).eq('course_id', courseId).eq('status', 'active'),
          db.from('payment_requests').select('id', { count: 'exact', head: true }).eq('course_id', courseId).eq('status', 'pending'),
          db.from('access_requests').select('id', { count: 'exact', head: true }).eq('course_id', courseId).eq('status', 'pending'),
          db.from('qa_questions').select('id', { count: 'exact', head: true }).eq('course_id', courseId).eq('status', 'open'),
          db.from('quiz_attempts').select('id', { count: 'exact', head: true }),
          db.from('trading_journal_entries').select('id', { count: 'exact', head: true }).eq('course_id', courseId),
          db.from('lesson_progress').select('id', { count: 'exact', head: true }).eq('is_completed', true).in('lesson_id', publishedLessonIds.length ? publishedLessonIds : ['00000000-0000-0000-0000-000000000000']),
        ]);
        for (const query of [enrollments,payments,requests,openQuestions,attempts,journalEntries,completed]) if (query.error) throw query.error;
        const activeRowsQuery = await db.from('enrollments')
          .select('telegram_id,expires_at')
          .eq('course_id', courseId).eq('status', 'active').limit(500);
        if (activeRowsQuery.error) throw activeRowsQuery.error;
        const nowForEnrollments = Date.now();
        const activeIds = [...new Set((activeRowsQuery.data || [])
          .filter((row) => !row.expires_at || new Date(row.expires_at).getTime() > nowForEnrollments)
          .map((row) => String(row.telegram_id)))];
        const activeProfilesQuery = activeIds.length
          ? await db.from('students').select('telegram_id,username,first_name,last_name').in('telegram_id', activeIds)
          : { data: [], error: null };
        if (activeProfilesQuery.error) throw activeProfilesQuery.error;
        const activeProgressQuery = activeIds.length && publishedLessonIds.length
          ? await db.from('lesson_progress').select('telegram_id,lesson_id')
              .eq('is_completed', true).in('telegram_id', activeIds).in('lesson_id', publishedLessonIds)
          : { data: [], error: null };
        if (activeProgressQuery.error) throw activeProgressQuery.error;
        const completedByStudent = new Map<string, Set<string>>();
        for (const row of activeProgressQuery.data || []) {
          const studentId = String(row.telegram_id);
          if (!completedByStudent.has(studentId)) completedByStudent.set(studentId, new Set());
          completedByStudent.get(studentId)!.add(String(row.lesson_id));
        }
        adminProgress = (activeProfilesQuery.data || []).map((profile) => {
          const id = String(profile.telegram_id);
          const completedCount = completedByStudent.get(id)?.size || 0;
          return {
            telegramId: id,
            displayName: [profile.first_name || '', profile.last_name || ''].filter(Boolean).join(' ').trim()
              || (profile.username ? '@' + profile.username : 'BBSS o‘quvchisi'),
            username: profile.username || null,
            completedLessons: completedCount,
            totalLessons: publishedLessonIds.length,
            percent: publishedLessonIds.length ? Math.round(completedCount * 100 / publishedLessonIds.length) : 0,
          };
        }).sort((a, b) => String(a.displayName).localeCompare(String(b.displayName), 'uz'));
        adminStats = {
          activeStudents: activeIds.length,
          pendingPayments: payments.count || 0,
          pendingAccessRequests: requests.count || 0,
          openQuestions: openQuestions.count || 0,
          quizAttempts: attempts.count || 0,
          journalEntries: journalEntries.count || 0,
          completedLessons: completed.count || 0,
        };
      }

      return jsonResponse({
        ok: true,
        dashboard: {
          lessons,
          completedLessonIds: (progressQuery.data || []).map((row) => String(row.lesson_id)),
          savedLessonIds: (savedQuery.data || []).map((row) => String(row.lesson_id)),
          quizzes: quizQuery.data || [],
          announcements: announcementQuery.data || [],
          questions,
          journal: journalEntries,
          certificates: certQuery.data || [],
          stats: {
            totalLessons: lessons.length,
            completedLessons: (progressQuery.data || []).length,
            savedLessons: (savedQuery.data || []).length,
          },
          adminStats,
          adminProgress,
        },
      });
    } catch (error) {
      const diagnostic = getDiagnostic(error);
      console.error('Learning dashboard failed:', diagnostic);
      return jsonResponse({ error: 'O‘quv vositalarini yuklab bo‘lmadi: ' + diagnostic }, 500);
    }
  }

  if (body.action === 'lesson_progress_set') {
    try {
      const courseId = await getLearningCourseId();
      const lessonId = typeof body.lessonId === 'string' ? body.lessonId.trim() : '';
      const completed = body.completed === true;
      await validateLearningLesson(courseId, lessonId, isAdmin);
      const { error } = await db.from('lesson_progress').upsert({
        telegram_id: telegramUser.id,
        lesson_id: lessonId,
        is_completed: completed,
        completed_at: completed ? new Date().toISOString() : null,
      }, { onConflict: 'telegram_id,lesson_id' });
      if (error) throw error;
      return jsonResponse({ ok: true, completed });
    } catch (error) {
      return jsonResponse({ error: getDiagnostic(error) || 'Dars progressini saqlab bo‘lmadi.' }, 400);
    }
  }

  if (body.action === 'saved_lesson_toggle') {
    try {
      const courseId = await getLearningCourseId();
      const lessonId = typeof body.lessonId === 'string' ? body.lessonId.trim() : '';
      const saved = body.saved === true;
      await validateLearningLesson(courseId, lessonId, isAdmin);
      if (saved) {
        const { error } = await db.from('saved_lessons').upsert({
          course_id: courseId, telegram_id: telegramUser.id, lesson_id: lessonId,
        }, { onConflict: 'course_id,telegram_id,lesson_id', ignoreDuplicates: true });
        if (error) throw error;
      } else {
        const { error } = await db.from('saved_lessons').delete()
          .eq('course_id', courseId).eq('telegram_id', telegramUser.id).eq('lesson_id', lessonId);
        if (error) throw error;
      }
      return jsonResponse({ ok: true, saved });
    } catch (error) {
      return jsonResponse({ error: getDiagnostic(error) || 'Saqlangan dars yangilanmadi.' }, 400);
    }
  }

  if (body.action === 'quiz_detail') {
    try {
      const courseId = await getLearningCourseId();
      const quizId = typeof body.quizId === 'string' ? body.quizId.trim() : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(quizId)) {
        return jsonResponse({ error: 'Test ID noto‘g‘ri.' }, 400);
      }
      const quizQuery = await db.from('quizzes').select('id,title,description,pass_percent')
        .eq('id', quizId).eq('course_id', courseId).eq('is_published', true).maybeSingle();
      if (quizQuery.error) throw quizQuery.error;
      if (!quizQuery.data) return jsonResponse({ error: 'Test topilmadi.' }, 404);
      const questionsQuery = await db.from('quiz_questions')
        .select('id,question,options,explanation,position')
        .eq('quiz_id', quizId).order('position');
      if (questionsQuery.error) throw questionsQuery.error;
      return jsonResponse({ ok: true, quiz: quizQuery.data, questions: questionsQuery.data || [] });
    } catch (error) {
      return jsonResponse({ error: getDiagnostic(error) }, 400);
    }
  }

  if (body.action === 'quiz_submit') {
    try {
      const courseId = await getLearningCourseId();
      const quizId = typeof body.quizId === 'string' ? body.quizId.trim() : '';
      const answers = Array.isArray(body.answers) ? body.answers : [];
      const quizQuery = await db.from('quizzes').select('id,pass_percent,title')
        .eq('id', quizId).eq('course_id', courseId).eq('is_published', true).maybeSingle();
      if (quizQuery.error) throw quizQuery.error;
      if (!quizQuery.data) return jsonResponse({ error: 'Test topilmadi.' }, 404);
      const questionsQuery = await db.from('quiz_questions').select('id,correct_index,explanation,options')
        .eq('quiz_id', quizId).order('position');
      if (questionsQuery.error) throw questionsQuery.error;
      const questions = questionsQuery.data || [];
      if (!questions.length || answers.length !== questions.length) {
        return jsonResponse({ error: 'Barcha savollarga javob bering.' }, 400);
      }
      let score = 0;
      const answerResults = questions.map((question, index) => {
        const answerIndex = Number(answers[index]);
        const isCorrect = Number.isInteger(answerIndex) && answerIndex === question.correct_index;
        if (isCorrect) score++;
        return { questionId: question.id, correctIndex: question.correct_index, isCorrect, explanation: question.explanation || '' };
      });
      const passed = Math.round((score / questions.length) * 100) >= quizQuery.data.pass_percent;
      const { data: attempt, error: attemptError } = await db.from('quiz_attempts').insert({
        quiz_id: quizId, telegram_id: telegramUser.id, score, total_questions: questions.length,
        passed, answers: answers.map((answer) => Number(answer)),
      }).select('id,score,total_questions,passed,created_at').single();
      if (attemptError) throw attemptError;
      return jsonResponse({ ok: true, attempt, passPercent: quizQuery.data.pass_percent, results: answerResults });
    } catch (error) {
      return jsonResponse({ error: getDiagnostic(error) || 'Test natijasini hisoblab bo‘lmadi.' }, 400);
    }
  }

  if (body.action === 'quiz_admin_create') {
    if (!isAdmin) return jsonResponse({ error: 'Testni faqat admin yaratishi mumkin.' }, 403);
    try {
      const courseId = await getLearningCourseId();
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 140) : '';
      const description = typeof body.description === 'string' ? body.description.trim().slice(0, 1000) : '';
      const passPercent = Math.max(1, Math.min(100, Number(body.passPercent) || 70));
      const rawQuestions = Array.isArray(body.questions) ? body.questions : [];
      if (!title || rawQuestions.length < 1 || rawQuestions.length > 20) {
        return jsonResponse({ error: 'Test nomi va 1–20 ta savol kiriting.' }, 400);
      }
      const questions = rawQuestions.map((raw: any, index: number) => {
        const question = typeof raw?.question === 'string' ? raw.question.trim().slice(0,800) : '';
        const options = Array.isArray(raw?.options) ? raw.options.map((option: unknown) => String(option).trim().slice(0,300)).filter(Boolean).slice(0,6) : [];
        const correctIndex = Number(raw?.correctIndex);
        if (!question || options.length < 2 || !Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
          throw new Error('Har bir savolda matn, kamida 2 ta variant va to‘g‘ri javob raqami bo‘lishi kerak.');
        }
        return {
          question, options, correct_index: correctIndex,
          explanation: typeof raw?.explanation === 'string' ? raw.explanation.trim().slice(0,1000) : '',
          position: index + 1,
        };
      });
      const { data: quiz, error: quizError } = await db.from('quizzes').insert({
        course_id: courseId, title, description, pass_percent: passPercent,
        is_published: true, created_by: telegramUser.id,
      }).select('id,title,description,pass_percent').single();
      if (quizError) throw quizError;
      const { error: questionsError } = await db.from('quiz_questions').insert(questions.map((question) => ({ ...question, quiz_id: quiz.id })));
      if (questionsError) {
        await db.from('quizzes').delete().eq('id', quiz.id);
        throw questionsError;
      }
      return jsonResponse({ ok: true, quiz });
    } catch (error) {
      return jsonResponse({ error: getDiagnostic(error) || 'Test yaratilmadi.' }, 400);
    }
  }

  if (body.action === 'announcement_admin_create') {
    if (!isAdmin) return jsonResponse({ error: 'E’lonni faqat admin joylaydi.' }, 403);
    try {
      const courseId = await getLearningCourseId();
      const title = typeof body.title === 'string' ? body.title.trim().slice(0,160) : '';
      const announcementBody = typeof body.bodyText === 'string' ? body.bodyText.trim().slice(0,5000) : '';
      if (!title || !announcementBody) return jsonResponse({ error: 'E’lon sarlavhasi va matnini to‘ldiring.' }, 400);
      const { data, error } = await db.from('announcements').insert({
        course_id: courseId, title, body: announcementBody, is_published: true,
        is_pinned: body.saved === true, created_by: telegramUser.id, published_at: new Date().toISOString(),
      }).select('id,title,body,is_pinned,published_at,created_at').single();
      if (error) throw error;
      return jsonResponse({ ok: true, announcement: data });
    } catch (error) {
      return jsonResponse({ error: getDiagnostic(error) || 'E’lonni joylab bo‘lmadi.' }, 400);
    }
  }

  if (body.action === 'qa_question_create') {
    try {
      const courseId = await getLearningCourseId();
      const title = typeof body.title === 'string' ? body.title.trim().slice(0,180) : '';
      const questionBody = typeof body.bodyText === 'string' ? body.bodyText.trim().slice(0,4000) : '';
      if (!title || !questionBody) return jsonResponse({ error: 'Savol sarlavhasi va matnini kiriting.' }, 400);
      const lessonId = typeof body.lessonId === 'string' ? body.lessonId.trim() : '';
      if (lessonId) await validateLearningLesson(courseId, lessonId, isAdmin);
      const { data, error } = await db.from('qa_questions').insert({
        course_id: courseId, telegram_id: telegramUser.id, lesson_id: lessonId || null,
        title, body: questionBody, status: 'open',
      }).select('id,title,body,status,created_at').single();
      if (error) throw error;
      return jsonResponse({ ok: true, question: data });
    } catch (error) {
      return jsonResponse({ error: getDiagnostic(error) || 'Savol yuborilmadi.' }, 400);
    }
  }

  if (body.action === 'qa_answer') {
    try {
      const courseId = await getLearningCourseId();
      const questionId = typeof body.questionId === 'string' ? body.questionId.trim() : '';
      const answerBody = typeof body.bodyText === 'string' ? body.bodyText.trim().slice(0,4000) : '';
      if (!questionId || !answerBody) return jsonResponse({ error: 'Savolni va javob matnini tekshiring.' }, 400);
      const { data: question, error: questionError } = await db.from('qa_questions')
        .select('id,course_id,status,telegram_id,title').eq('id', questionId).eq('course_id', courseId).maybeSingle();
      if (questionError) throw questionError;
      if (!question) return jsonResponse({ error: 'Savol topilmadi.' }, 404);
      const { error: answerError } = await db.from('qa_answers').insert({
        question_id: questionId, telegram_id: telegramUser.id,
        body: answerBody, is_admin: isAdmin,
      });
      if (answerError) throw answerError;
      const { error: statusError } = await db.from('qa_questions')
        .update({ status: 'answered', updated_at: new Date().toISOString() })
        .eq('id', questionId).eq('course_id', courseId);
      if (statusError) throw statusError;

      const questionAuthorId = String(question.telegram_id || '');
      if (questionAuthorId && questionAuthorId !== telegramUser.id) {
        const answererName = [
          typeof telegramUser.firstName === 'string' ? telegramUser.firstName.trim() : '',
          typeof telegramUser.lastName === 'string' ? telegramUser.lastName.trim() : '',
        ].filter(Boolean).join(' ').slice(0, 120)
          || (telegramUser.username ? '@' + telegramUser.username : 'BBSS SYSTEM o‘quvchisi');
        try {
          await callTelegramBotApi(telegramBotToken, 'sendMessage', {
            chat_id: questionAuthorId,
            text: '💬 Savolingizga javob keldi!\n\n' +
              'Savol: ' + String(question.title || '').slice(0, 180) + '\n' +
              'Javob yozgan: ' + answererName + '\n\n' +
              'Javobni BBSS SYSTEM ichidagi Savol-javob bo‘limidan o‘qing.',
            reply_markup: {
              inline_keyboard: [[{
                text: 'BBSS SYSTEM’ni ochish',
                web_app: { url: APP_URL },
              }]],
            },
          });
        } catch (noticeError) {
          console.warn('Q&A answer notification failed:', getDiagnostic(noticeError));
        }
      }
      return jsonResponse({ ok: true });
    } catch (error) {
      return jsonResponse({ error: getDiagnostic(error) || 'Javob yuborilmadi.' }, 400);
    }
  }

  if (body.action === 'journal_add') {
    let screenshotPath: string | null = null;
    try {
      const courseId = await getLearningCourseId();
      const symbol = typeof body.symbol === 'string' ? body.symbol : '';
      const direction = typeof body.direction === 'string' ? body.direction : '';
      const entryPrice = Number(body.entryPrice);
      const numberOrNull = (value: unknown) => value === null || value === undefined || value === '' ? null : Number(value);
      const stopLoss = numberOrNull(body.stopLoss);
      const takeProfit = numberOrNull(body.takeProfit);
      const exitPrice = numberOrNull(body.exitPrice);
      const outcome = typeof body.outcome === 'string' ? body.outcome : 'OPEN';
      const setup = typeof body.setup === 'string' ? body.setup.trim().slice(0,180) : '';
      const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0,3000) : '';
      if (!['XAUUSD','EURUSD'].includes(symbol) || !['LONG','SHORT'].includes(direction) ||
          !Number.isFinite(entryPrice) || entryPrice <= 0 ||
          !['WIN','LOSS','BE','OPEN'].includes(outcome) ||
          [stopLoss,takeProfit,exitPrice].some((value) => value !== null && (!Number.isFinite(value) || value <= 0))) {
        return jsonResponse({ error: 'Bitim ma’lumotlarini to‘g‘ri kiriting.' }, 400);
      }

      // Ixtiyoriy grafik skrinshoti: faqat JPEG, o‘lchami cheklangan va private bucket’da saqlanadi.
      const imageData = typeof body.imageData === 'string' ? body.imageData : '';
      if (imageData) {
        const imageMatch = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(imageData);
        if (!imageMatch || imageMatch[1].length > 1_050_000) {
          return jsonResponse({ error: 'Skrinshot JPEG formatida bo‘lishi kerak.' }, 400);
        }
        const binary = atob(imageMatch[1]);
        if (binary.length > MAX_AVATAR_BYTES) {
          return jsonResponse({ error: 'Skrinshot 750 KB dan kichik bo‘lishi kerak.' }, 413);
        }
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
          return jsonResponse({ error: 'Skrinshot fayli JPEG sifatida tasdiqlanmadi.' }, 400);
        }
        screenshotPath = telegramUser.id + '/' + crypto.randomUUID() + '.jpg';
        const upload = await db.storage.from(JOURNAL_BUCKET).upload(screenshotPath, bytes, {
          contentType: 'image/jpeg',
          cacheControl: '3600',
          upsert: false,
        });
        if (upload.error) throw new Error('Skrinshot saqlanmadi: ' + upload.error.message);
      }

      const { data, error } = await db.from('trading_journal_entries').insert({
        course_id: courseId, telegram_id: telegramUser.id, symbol, direction,
        entry_price: entryPrice, stop_loss: stopLoss, take_profit: takeProfit,
        exit_price: exitPrice, outcome, setup, notes, screenshot_path: screenshotPath,
      }).select('id,symbol,direction,entry_price,stop_loss,take_profit,exit_price,outcome,setup,notes,screenshot_path,created_at').single();
      if (error) throw error;
      return jsonResponse({
        ok: true,
        entry: { ...data, screenshotUrl: await resolveJournalScreenshotUrl(db, data.screenshot_path) },
      });
    } catch (error) {
      if (screenshotPath) {
        const cleanup = await db.storage.from(JOURNAL_BUCKET).remove([screenshotPath]);
        if (cleanup.error) console.warn('Orphan journal screenshot cleanup failed:', cleanup.error.message);
      }
      return jsonResponse({ error: getDiagnostic(error) || 'Bitim saqlanmadi.' }, 400);
    }
  }

  if (body.action === 'journal_delete') {
    try {
      const courseId = await getLearningCourseId();
      const id = typeof body.questionId === 'string' ? body.questionId.trim() : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return jsonResponse({ error: 'Bitim ID noto‘g‘ri.' }, 400);
      const { data, error } = await db.from('trading_journal_entries').delete()
        .eq('id', id).eq('course_id', courseId).eq('telegram_id', telegramUser.id).select('id,screenshot_path').maybeSingle();
      if (error) throw error;
      if (!data) return jsonResponse({ error: 'Bitim topilmadi.' }, 404);
      if (data.screenshot_path) {
        const cleanup = await db.storage.from(JOURNAL_BUCKET).remove([data.screenshot_path]);
        if (cleanup.error) console.warn('Journal screenshot delete failed:', cleanup.error.message);
      }
      return jsonResponse({ ok: true });
    } catch (error) {
      return jsonResponse({ error: getDiagnostic(error) || 'Bitim o‘chirilmadi.' }, 400);
    }
  }

  if (body.action === 'certificate_issue') {
    try {
      const courseId = await getLearningCourseId();
      const modulesQuery = await db.from('modules').select('id').eq('course_id', courseId).eq('is_published', true);
      if (modulesQuery.error) throw modulesQuery.error;
      const moduleIds = (modulesQuery.data || []).map((row) => row.id);
      const lessonsQuery = moduleIds.length
        ? await db.from('lessons').select('id').in('module_id', moduleIds).eq('is_published', true)
        : { data: [], error: null };
      if (lessonsQuery.error) throw lessonsQuery.error;
      const lessons = lessonsQuery.data || [];
      if (!lessons.length) return jsonResponse({ error: 'Sertifikat uchun e’lon qilingan darslar mavjud emas.' }, 400);
      const progressQuery = await db.from('lesson_progress').select('lesson_id')
        .eq('telegram_id', telegramUser.id).eq('is_completed', true).in('lesson_id', lessons.map((lesson) => lesson.id));
      if (progressQuery.error) throw progressQuery.error;
      const completed = new Set((progressQuery.data || []).map((row) => String(row.lesson_id))).size;
      if (completed < lessons.length) {
        return jsonResponse({ error: 'Sertifikat olish uchun barcha darslarni tugating: ' + completed + '/' + lessons.length }, 400);
      }
      const { data: certificate, error } = await db.from('certificates').upsert({
        course_id: courseId,
        telegram_id: telegramUser.id,
        certificate_code: 'BBSS-' + crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase(),
        completed_lessons: completed,
        total_lessons: lessons.length,
      }, { onConflict: 'course_id,telegram_id', ignoreDuplicates: true }).select('id,certificate_code,completed_lessons,total_lessons,issued_at').maybeSingle();
      if (error) throw error;
      if (certificate) return jsonResponse({ ok: true, certificate });
      const existing = await db.from('certificates').select('id,certificate_code,completed_lessons,total_lessons,issued_at')
        .eq('course_id', courseId).eq('telegram_id', telegramUser.id).single();
      if (existing.error) throw existing.error;
      return jsonResponse({ ok: true, certificate: existing.data });
    } catch (error) {
      return jsonResponse({ error: getDiagnostic(error) || 'Sertifikat tayyorlanmadi.' }, 400);
    }
  }

  // Student kursga kirish uchun admin tasdig'ini so'raydi.
  if (body.action === 'request_access') {
    if (isAdmin) {
      return jsonResponse({
        ok: true,
        status: 'approved',
        alreadyEnrolled: true,
        message: 'Admin uchun qo‘shimcha ruxsat so‘rovi kerak emas.',
      });
    }

    try {
      const { data: course, error: courseError } = await db
        .from('courses')
        .select('id,title')
        .eq('slug', COURSE_SLUG)
        .maybeSingle();

      if (courseError) throw courseError;
      if (!course) {
        return jsonResponse({ error: 'BBSS SYSTEM kursi topilmadi.' }, 404);
      }

      const { data: enrollment, error: enrollmentError } = await db
        .from('enrollments')
        .select('id,status,expires_at')
        .eq('telegram_id', telegramUser.id)
        .eq('course_id', course.id)
        .eq('status', 'active')
        .maybeSingle();

      if (enrollmentError) throw enrollmentError;

      const accessIsActive = !!enrollment && (
        !enrollment.expires_at ||
        new Date(enrollment.expires_at).getTime() > Date.now()
      );

      if (accessIsActive) {
        return jsonResponse({
          ok: true,
          status: 'approved',
          alreadyEnrolled: true,
          message: 'Sizda kursga kirish huquqi allaqachon mavjud.',
        });
      }

      const { error: studentError } = await db
        .from('students')
        .upsert(
          { telegram_id: telegramUser.id },
          { onConflict: 'telegram_id', ignoreDuplicates: true },
        );
      if (studentError) throw studentError;

      const { data: existingRequest, error: existingError } = await db
        .from('access_requests')
        .select('id,status')
        .eq('telegram_id', telegramUser.id)
        .eq('course_id', course.id)
        .maybeSingle();

      if (existingError) throw existingError;

      if (existingRequest?.status === 'pending') {
        return jsonResponse({
          ok: true,
          status: 'pending',
          alreadyPending: true,
          message: 'So‘rovingiz allaqachon admin ko‘rib chiqishini kutmoqda.',
        });
      }

      const { error: upsertError } = await db
        .from('access_requests')
        .upsert(
          {
            telegram_id: telegramUser.id,
            course_id: course.id,
            status: 'pending',
            created_at: new Date().toISOString(),
            reviewed_at: null,
            reviewed_by: null,
          },
          { onConflict: 'telegram_id,course_id' },
        );

      if (upsertError) throw upsertError;

      return jsonResponse({
        ok: true,
        status: 'pending',
        alreadyPending: false,
        message: 'Ruxsat so‘rovi adminga yuborildi.',
      });
    } catch (error) {
      const diagnostic = getDiagnostic(error);
      console.error('Student access request failed:', diagnostic);
      return jsonResponse(
        { error: `Ruxsat so‘rovini yuborib bo‘lmadi: ${diagnostic}` },
        500,
      );
    }
  }

  // O'quvchining o'z profil rasmidan boshqa rasm yuklashiga ruxsat yo'q.
  if (body.action === 'upload_profile_photo') {
    const imageData =
      typeof body.imageData === 'string' ? body.imageData : '';

    const match =
      /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(imageData);

    if (!match || match[1].length > 1_050_000) {
      return jsonResponse(
        { error: 'Rasm formati noto‘g‘ri. JPEG rasm tanlang.' },
        400,
      );
    }

    try {
      const binary = atob(match[1]);

      if (binary.length > MAX_AVATAR_BYTES) {
        return jsonResponse(
          {
            error:
              'Siqilgan rasm 750 KB dan kichik bo‘lishi kerak.',
          },
          413,
        );
      }

      const bytes = new Uint8Array(binary.length);

      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      // JPEG faylining haqiqiy imzo baytlarini tekshiramiz.
      if (
        bytes.length < 3 ||
        bytes[0] !== 0xff ||
        bytes[1] !== 0xd8 ||
        bytes[2] !== 0xff
      ) {
        return jsonResponse(
          { error: 'Fayl JPEG rasm sifatida tasdiqlanmadi.' },
          400,
        );
      }

      const path = `${telegramUser.id}/avatar.jpg`;

      const { error: uploadError } = await db.storage
        .from(AVATAR_BUCKET)
        .upload(path, bytes, {
          contentType: 'image/jpeg',
          cacheControl: '3600',
          upsert: true,
        });

      if (uploadError) {
        console.error(
          'Student avatar storage upload failed:',
          uploadError.message,
        );

        throw new Error(
          `Rasm saqlanmadi. '${AVATAR_BUCKET}' private bucket mavjudligini tekshiring. ${uploadError.message}`,
        );
      }

      const { error: profileUpdateError } = await db
        .from('students')
        .update({ avatar_path: path })
        .eq('telegram_id', telegramUser.id);

      if (profileUpdateError) {
        throw new Error(
          `Profil bazasini yangilashda xatolik: ${profileUpdateError.message}`,
        );
      }

      const { data: signedUrlData, error: signedUrlError } =
        await db.storage
          .from(AVATAR_BUCKET)
          .createSignedUrl(path, AVATAR_SIGNED_URL_SECONDS);

      if (signedUrlError || !signedUrlData?.signedUrl) {
        throw new Error(
          `Rasm saqlandi, lekin ko‘rsatish havolasi yaratilmadi: ${
            signedUrlError?.message || 'unknown error'
          }`,
        );
      }

      return jsonResponse({
        ok: true,
        photoUrl: signedUrlData.signedUrl,
        message: 'Profil rasmi saqlandi.',
      });
    } catch (error) {
      const diagnostic = getDiagnostic(error);

      console.error(
        'Student profile photo upload failed:',
        diagnostic,
      );

      return jsonResponse({ error: diagnostic }, 500);
    }
  }

  // Faqat admin ruxsat bera oladi.
  if (body.action === 'grant_access') {
    if (!isAdmin) {
      return jsonResponse(
        { error: 'Bu amal faqat admin uchun.' },
        403,
      );
    }

    const targetTelegramId =
      typeof body.targetTelegramId === 'string'
        ? body.targetTelegramId.trim()
        : '';

    if (
      !/^\d{5,20}$/.test(targetTelegramId) ||
      /^0+$/.test(targetTelegramId)
    ) {
      return jsonResponse(
        {
          error:
            'Telegram ID faqat raqamlardan iborat bo‘lishi kerak. Telefon raqami emas, Telegram Akkaunt ID kiriting.',
        },
        400,
      );
    }

    try {
      const { data: course, error: courseError } = await db
        .from('courses')
        .select('id,title')
        .eq('slug', COURSE_SLUG)
        .maybeSingle();

      if (courseError) throw courseError;

      if (!course) {
        return jsonResponse({ error: 'Kurs topilmadi.' }, 404);
      }

      // Avval students jadvaliga yozuv kiritamiz.
      const { error: studentError } = await db
        .from('students')
        .upsert(
          { telegram_id: targetTelegramId },
          {
            onConflict: 'telegram_id',
            ignoreDuplicates: true,
          },
        );

      if (studentError) {
        throw new Error(
          `Student upsert failed: ${studentError.message}`,
        );
      }

      const { error: grantError } = await db
        .from('enrollments')
        .upsert(
          {
            telegram_id: targetTelegramId,
            course_id: course.id,
            status: 'active',
            granted_at: new Date().toISOString(),
            expires_at: null,
          },
          { onConflict: 'telegram_id,course_id' },
        );

      if (grantError) throw grantError;

      return jsonResponse({
        ok: true,
        telegramId: targetTelegramId,
        courseTitle: course.title || 'BBSS SYSTEM kursi',
        message: 'Kursga kirish huquqi berildi.',
      });
    } catch (error) {
      const diagnostic = getDiagnostic(error);
      console.error('Admin grant access failed:', diagnostic);

      return jsonResponse(
        {
          error:
            `Kirish huquqini saqlab bo‘lmadi: ${diagnostic || 'noma’lum xatolik'}`,
        },
        500,
      );
    }
  }

  // Admin ilovasi ichida kelgan ruxsat so'rovlarini ko'rsatish.
  if (body.action === 'admin_list_access_requests') {
    if (!isAdmin) {
      return jsonResponse({ error: 'Bu amal faqat admin uchun.' }, 403);
    }

    try {
      const { data: course, error: courseError } = await db
        .from('courses')
        .select('id')
        .eq('slug', COURSE_SLUG)
        .maybeSingle();

      if (courseError) throw courseError;
      if (!course) {
        return jsonResponse({ error: 'Kurs topilmadi.' }, 404);
      }

      const { data: rows, error: requestError } = await db
        .from('access_requests')
        .select('id,telegram_id,course_id,status,created_at')
        .eq('course_id', course.id)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(200);

      if (requestError) throw requestError;

      const ids = [...new Set((rows || []).map((row) => String(row.telegram_id)))];
      let studentRows: Array<{
        telegram_id: string;
        username: string | null;
        first_name: string | null;
        last_name: string | null;
      }> = [];

      if (ids.length > 0) {
        const { data, error } = await db
          .from('students')
          .select('telegram_id,username,first_name,last_name')
          .in('telegram_id', ids);

        if (error) throw error;
        studentRows = data || [];
      }

      const studentsById = new Map(
        studentRows.map((student) => [String(student.telegram_id), student]),
      );

      const requests = (rows || []).map((row) => {
        const telegramId = String(row.telegram_id);
        const student = studentsById.get(telegramId);
        const displayName = [
          student?.first_name || '',
          student?.last_name || '',
        ].filter(Boolean).join(' ') || 'BBSS o‘quvchisi';

        return {
          id: String(row.id),
          telegramId,
          username: student?.username || null,
          displayName,
          createdAt: row.created_at,
        };
      });

      return jsonResponse({ ok: true, requests });
    } catch (error) {
      const diagnostic = getDiagnostic(error);
      console.error('Admin access request list failed:', diagnostic);
      return jsonResponse(
        { error: `Ruxsat so‘rovlarini yuklab bo‘lmadi: ${diagnostic}` },
        500,
      );
    }
  }

  // Admin tasdiqlaydi yoki rad etadi; tasdiq va enrollment bitta DB tranzaksiyasida.
  if (body.action === 'admin_review_access_request') {
    if (!isAdmin) {
      return jsonResponse({ error: 'Bu amal faqat admin uchun.' }, 403);
    }

    const requestId = typeof body.requestId === 'string'
      ? body.requestId.trim()
      : '';
    const decision = typeof body.decision === 'string'
      ? body.decision.trim()
      : '';

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId) ||
      !['approved', 'rejected'].includes(decision)
    ) {
      return jsonResponse(
        { error: 'Ruxsat so‘rovi yoki amal turi noto‘g‘ri.' },
        400,
      );
    }

    const { data, error } = await db.rpc('bbss_review_access_request', {
      p_request_id: requestId,
      p_decision: decision,
      p_admin_telegram_id: telegramUser.id,
    });

    if (error) {
      const diagnostic = getDiagnostic(error);
      if (diagnostic.includes('request_not_pending')) {
        return jsonResponse(
          { error: 'Bu so‘rov avval ko‘rib chiqilgan. Ro‘yxatni yangilang.' },
          409,
        );
      }
      if (diagnostic.includes('request_not_found')) {
        return jsonResponse({ error: 'Ruxsat so‘rovi topilmadi.' }, 404);
      }

      console.error('Admin access request review failed:', diagnostic);
      return jsonResponse(
        { error: `Ruxsat so‘rovini ko‘rib chiqib bo‘lmadi: ${diagnostic}` },
        500,
      );
    }

    return jsonResponse({
      ok: true,
      ...(data && typeof data === 'object' ? data : {}),
      message: decision === 'approved'
        ? 'O‘quvchiga kursga kirish huquqi berildi.'
        : 'Ruxsat so‘rovi rad etildi.',
    });
  }

  // Admin uchun faol ruxsatlar va profil rasmlari ro'yxati.
  if (body.action === 'admin_list_enrollments') {
    if (!isAdmin) {
      return jsonResponse(
        { error: 'Bu amal faqat admin uchun.' },
        403,
      );
    }

    try {
      const { data: course, error: courseError } = await db
        .from('courses')
        .select('id,title')
        .eq('slug', COURSE_SLUG)
        .maybeSingle();

      if (courseError) throw courseError;

      if (!course) {
        return jsonResponse({ error: 'Kurs topilmadi.' }, 404);
      }

      const { data: rows, error: enrollmentsError } = await db
        .from('enrollments')
        .select('id,telegram_id,status,granted_at,expires_at')
        .eq('course_id', course.id)
        .eq('status', 'active')
        .order('granted_at', { ascending: false })
        .limit(500);

      if (enrollmentsError) throw enrollmentsError;

      const now = Date.now();

      const activeRows = (rows || []).filter((row) =>
        !row.expires_at ||
        new Date(row.expires_at).getTime() > now
      );

      const ids = [
        ...new Set(activeRows.map((row) => String(row.telegram_id))),
      ];

      let students: Array<{
        telegram_id: string;
        username: string | null;
        first_name: string | null;
        last_name: string | null;
        avatar_path: string | null;
      }> = [];

      if (ids.length > 0) {
        const { data: studentRows, error: studentsError } =
          await db
            .from('students')
            .select(
              'telegram_id,username,first_name,last_name,avatar_path',
            )
            .in('telegram_id', ids);

        if (studentsError) throw studentsError;
        students = studentRows || [];
      }

      const studentsById =
        new Map<string, typeof students[number]>();

      for (const student of students) {
        studentsById.set(
          String(student.telegram_id),
          student,
        );
      }

      const enrollments = await Promise.all(
        activeRows.map(async (row) => {
          const student = studentsById.get(
            String(row.telegram_id),
          );

          const fullName = [
            student?.first_name,
            student?.last_name,
          ]
            .filter(
              (part) =>
                typeof part === 'string' && part.trim(),
            )
            .join(' ')
            .trim();

          const displayName =
            fullName ||
            (student?.username
              ? `@${student.username.replace(/^@/, '')}`
              : `Telegram ID ${row.telegram_id}`);

          const photoUrl = await resolveStudentPhotoUrl(
            db,
            student || null,
          );

          return {
            telegramId: String(row.telegram_id),
            displayName,
            username: student?.username || null,
            photoUrl,
            grantedAt: row.granted_at,
            expiresAt: row.expires_at,
          };
        }),
      );

      return jsonResponse({
        ok: true,
        courseTitle: course.title || 'BBSS SYSTEM kursi',
        enrollments,
      });
    } catch (error) {
      const diagnostic = getDiagnostic(error);
      console.error('Admin enrollment list failed:', diagnostic);

      return jsonResponse(
        {
          error:
            `O‘quvchilar ro‘yxatini yuklab bo‘lmadi: ${diagnostic}`,
        },
        500,
      );
    }
  }

  // Admin o'quvchining kursga kirish huquqini bekor qilishi mumkin.
  if (body.action === 'revoke_access') {
    if (!isAdmin) {
      return jsonResponse(
        { error: 'Bu amal faqat admin uchun.' },
        403,
      );
    }

    const targetTelegramId =
      typeof body.targetTelegramId === 'string'
        ? body.targetTelegramId.trim()
        : '';

    if (
      !/^\d{5,20}$/.test(targetTelegramId) ||
      /^0+$/.test(targetTelegramId)
    ) {
      return jsonResponse(
        {
          error:
            'Telegram ID noto‘g‘ri. Faqat raqamli Telegram Akkaunt ID kiriting.',
        },
        400,
      );
    }

    try {
      const { data: course, error: courseError } = await db
        .from('courses')
        .select('id,title')
        .eq('slug', COURSE_SLUG)
        .maybeSingle();

      if (courseError) throw courseError;

      if (!course) {
        return jsonResponse({ error: 'Kurs topilmadi.' }, 404);
      }

      const { data: revokedRows, error: revokeError } =
        await db
          .from('enrollments')
          .update({
            status: 'revoked',
            expires_at: new Date().toISOString(),
          })
          .eq('telegram_id', targetTelegramId)
          .eq('course_id', course.id)
          .eq('status', 'active')
          .select('id,telegram_id');

      if (revokeError) throw revokeError;

      if (!revokedRows || revokedRows.length === 0) {
        return jsonResponse(
          { error: 'Bu o‘quvchi uchun faol ruxsat topilmadi.' },
          404,
        );
      }

      return jsonResponse({
        ok: true,
        telegramId: targetTelegramId,
        message: 'Kursga kirish huquqi bekor qilindi.',
      });
    } catch (error) {
      const diagnostic = getDiagnostic(error);
      console.error('Admin revoke access failed:', diagnostic);

      return jsonResponse(
        {
          error:
            `Kirish huquqini bekor qilib bo‘lmadi: ${diagnostic}`,
        },
        500,
      );
    }
  }

  // Guruh chat xabarlari va reply preview.
  if (body.action === 'community_chat_list') {
    try {
      const courseId = await getAuthorizedChatCourseId(db, telegramUser.id, isAdmin);
      if (!courseId) return jsonResponse({ error: 'Chat faqat admin tasdiqlagan o‘quvchilar uchun ochiq.' }, 403);
      const { data: rows, error } = await db.from('community_chat_messages')
        .select('id,telegram_id,message,created_at,is_deleted,reply_to')
        .eq('course_id', courseId).order('created_at', { ascending: false }).limit(80);
      if (error) throw error;
      const list = (rows || []).reverse();
      const parentIds = [...new Set(list.map((x) => x.reply_to).filter(Boolean).map(String))];
      let parents: any[] = [];
      if (parentIds.length) {
        const r = await db.from('community_chat_messages').select('id,telegram_id,message,is_deleted')
          .eq('course_id', courseId).in('id', parentIds);
        if (r.error) throw r.error;
        parents = r.data || [];
      }
      const ids = [...new Set([...list.map((x) => String(x.telegram_id)), ...parents.map((x) => String(x.telegram_id))])];
      let students: any[] = [];
      if (ids.length) {
        const r = await db.from('students').select('telegram_id,username,first_name,last_name').in('telegram_id', ids);
        if (r.error) throw r.error;
        students = r.data || [];
      }
      const byStudent = new Map(students.map((x) => [String(x.telegram_id), x]));
      const byParent = new Map(parents.map((x) => [String(x.id), x]));
      const nameFor = (id: string) => {
        const s = byStudent.get(id);
        return [s?.first_name || '', s?.last_name || ''].filter(Boolean).join(' ').trim()
          || (s?.username ? '@' + s.username : 'BBSS o‘quvchisi');
      };
      return jsonResponse({ ok: true, messages: list.map((x) => {
        const parent = x.reply_to ? byParent.get(String(x.reply_to)) : null;
        return {
          id: String(x.id), telegramId: String(x.telegram_id),
          message: x.is_deleted ? 'Xabar olib tashlangan.' : x.message,
          isDeleted: x.is_deleted === true, createdAt: x.created_at,
          displayName: nameFor(String(x.telegram_id)),
          isOwn: String(x.telegram_id) === telegramUser.id,
          canDelete: isAdmin && x.is_deleted !== true,
          replyTo: parent ? { id:String(parent.id), displayName:nameFor(String(parent.telegram_id)),
            message:parent.is_deleted ? 'Xabar olib tashlangan' : String(parent.message || ''), isDeleted:parent.is_deleted===true } : null
        };
      })});
    } catch (error) {
      const diagnostic = getDiagnostic(error);
      console.error('Community chat list failed:', diagnostic);
      return jsonResponse({ error: 'Guruh chatini yuklab bo‘lmadi: ' + diagnostic }, 500);
    }
  }

  if (body.action === 'community_chat_send') {
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const replyToId = typeof body.replyToId === 'string' ? body.replyToId.trim() : '';
    if (!message) return jsonResponse({ error: 'Xabar matnini kiriting.' }, 400);
    if (message.length > 1200) return jsonResponse({ error: 'Xabar 1200 belgidan oshmasin.' }, 413);
    if (replyToId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(replyToId)) {
      return jsonResponse({ error: 'Javob xabari noto‘g‘ri.' }, 400);
    }
    try {
      const courseId = await getAuthorizedChatCourseId(db, telegramUser.id, isAdmin);
      if (!courseId) return jsonResponse({ error: 'Chatga yozish uchun admin tasdig‘i kerak.' }, 403);
      let replyTo: string | null = null;
      if (replyToId) {
        const p = await db.from('community_chat_messages').select('id,is_deleted')
          .eq('id', replyToId).eq('course_id', courseId).maybeSingle();
        if (p.error) throw p.error;
        if (!p.data || p.data.is_deleted) return jsonResponse({ error: 'Javob xabari topilmadi.' }, 404);
        replyTo = String(p.data.id);
      }
      const { data: inserted, error } = await db.from('community_chat_messages')
        .insert({ course_id:courseId, telegram_id:telegramUser.id, message, reply_to:replyTo })
        .select('id,created_at,reply_to').single();
      if (error) throw error;
      return jsonResponse({ ok:true, messageId:inserted.id, createdAt:inserted.created_at, replyToId:inserted.reply_to || null });
    } catch (error) {
      const diagnostic = getDiagnostic(error);
      console.error('Community chat send failed:', diagnostic);
      return jsonResponse({ error:'Xabar yuborilmadi: ' + diagnostic }, 500);
    }
  }

  // Personal chat uchun faqat aktiv ruxsati bor o‘quvchilar ro‘yxati.
  if (body.action === 'direct_chat_directory') {
    try {
      const courseId = await getAuthorizedChatCourseId(db, telegramUser.id, isAdmin);
      if (!courseId) return jsonResponse({ error:'Chat faqat tasdiqlangan o‘quvchilar uchun ochiq.' }, 403);
      const { data: enrollments, error } = await db.from('enrollments')
        .select('telegram_id,expires_at').eq('course_id',courseId).eq('status','active').limit(500);
      if (error) throw error;
      const now = Date.now();
      const ids = [...new Set((enrollments || [])
        .filter((x) => !x.expires_at || new Date(x.expires_at).getTime() > now)
        .map((x) => String(x.telegram_id)).filter((id) => id !== telegramUser.id))];
      if (!ids.length) return jsonResponse({ ok:true, students:[] });
      // O‘qilmagan shaxsiy xabarlarni yuboruvchisi bo‘yicha sanaymiz.
      // PostgREST sahifalashidan foydalanamiz, shunda 1000 dan oshgan yozuvlar ham hisobdan tushmaydi.
      const unreadCounts = new Map<string, number>();
      let unreadOffset = 0;
      while (true) {
        const unreadPage = await db.from('direct_chat_messages')
          .select('id,sender_telegram_id')
          .eq('course_id', courseId)
          .eq('recipient_telegram_id', telegramUser.id)
          .is('read_at', null)
          .eq('is_deleted', false)
          .in('sender_telegram_id', ids)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(unreadOffset, unreadOffset + 999);
        if (unreadPage.error) throw unreadPage.error;
        const unreadRows = unreadPage.data || [];
        for (const row of unreadRows) {
          const senderId = String(row.sender_telegram_id);
          unreadCounts.set(senderId, (unreadCounts.get(senderId) || 0) + 1);
        }
        if (unreadRows.length < 1000) break;
        unreadOffset += unreadRows.length;
      }

      // Har 4.5 soniyadagi o‘qilmagan xabarlar tekshiruvida avatar URL’larini qayta yaratmaymiz.
      // Frontend faqat birinchi yuklashda yoki signed URL muddati tugashiga yaqinlashganda so‘raydi.
      const includePhotos = body.includePhotos !== false;
      const studentColumns = includePhotos
        ? 'telegram_id,username,first_name,last_name,avatar_path'
        : 'telegram_id,username,first_name,last_name';
      const sr = await db.from('students').select(studentColumns).in('telegram_id', ids);
      if (sr.error) throw sr.error;
      const students = await Promise.all((sr.data || []).map(async (s) => {
        const student: Record<string, unknown> = {
          telegramId: String(s.telegram_id),
          username: s.username || null,
          displayName: [s.first_name || '', s.last_name || ''].filter(Boolean).join(' ').trim()
            || (s.username ? '@' + s.username : 'BBSS o‘quvchisi'),
          unreadCount: unreadCounts.get(String(s.telegram_id)) || 0,
        };
        if (includePhotos) {
          student.photoUrl = await resolveStudentPhotoUrl(db, s);
        }
        return student;
      }));
      students.sort((a,b) => a.displayName.localeCompare(b.displayName,'uz'));
      return jsonResponse({ ok:true, students });
    } catch (error) {
      const diagnostic = getDiagnostic(error);
      console.error('Direct directory failed:', diagnostic);
      return jsonResponse({ error:'Studentlar ro‘yxati yuklanmadi: '+diagnostic },500);
    }
  }

  if (body.action === 'direct_chat_list') {
    const peerId = typeof body.peerTelegramId === 'string' ? body.peerTelegramId.trim() : '';
    if (!/^\d{5,20}$/.test(peerId) || peerId === telegramUser.id) return jsonResponse({error:'Student akkaunti noto‘g‘ri tanlangan.'},400);
    try {
      const courseId = await getAuthorizedChatCourseId(db, telegramUser.id, isAdmin);
      if (!courseId) return jsonResponse({error:'Personal chat uchun admin tasdig‘i kerak.'},403);
      const er = await db.from('enrollments').select('telegram_id,expires_at')
        .eq('course_id',courseId).eq('telegram_id',peerId).eq('status','active').maybeSingle();
      if (er.error) throw er.error;
      if (!er.data || (er.data.expires_at && new Date(er.data.expires_at).getTime() <= Date.now())) {
        return jsonResponse({error:'Bu studentning chatga kirish huquqi faol emas.'},403);
      }
      // Shaxsiy suhbat ochilganda, aynan shu peer yuborgan va joriy foydalanuvchiga yetkazilgan
      // o‘qilmagan xabarlarni o‘qilgan deb belgilaymiz.
      const { error: markReadError } = await db.from('direct_chat_messages')
        .update({ read_at: new Date().toISOString() })
        .eq('course_id', courseId)
        .eq('sender_telegram_id', peerId)
        .eq('recipient_telegram_id', telegramUser.id)
        .is('read_at', null)
        .eq('is_deleted', false);
      if (markReadError) throw markReadError;

      const cols='id,sender_telegram_id,recipient_telegram_id,message,created_at,is_deleted,reply_to';
      const a=await db.from('direct_chat_messages').select(cols).eq('course_id',courseId)
        .eq('sender_telegram_id',telegramUser.id).eq('recipient_telegram_id',peerId).order('created_at',{ascending:false}).limit(80);
      if (a.error) throw a.error;
      const b=await db.from('direct_chat_messages').select(cols).eq('course_id',courseId)
        .eq('sender_telegram_id',peerId).eq('recipient_telegram_id',telegramUser.id).order('created_at',{ascending:false}).limit(80);
      if (b.error) throw b.error;
      const list=[...(a.data||[]),...(b.data||[])].sort((x,y)=>new Date(x.created_at).getTime()-new Date(y.created_at).getTime()).slice(-80);
      const parentIds=[...new Set(list.map((x)=>x.reply_to).filter(Boolean).map(String))];
      let parents:any[]=[];
      if(parentIds.length){
        const p=await db.from('direct_chat_messages').select('id,sender_telegram_id,recipient_telegram_id,message,is_deleted')
          .eq('course_id',courseId).in('id',parentIds);
        if(p.error)throw p.error;
        parents=(p.data||[]).filter((x)=>
          (String(x.sender_telegram_id)===telegramUser.id&&String(x.recipient_telegram_id)===peerId)||
          (String(x.sender_telegram_id)===peerId&&String(x.recipient_telegram_id)===telegramUser.id));
      }
      const ids=[...new Set([telegramUser.id,peerId,...list.flatMap((x)=>[String(x.sender_telegram_id),String(x.recipient_telegram_id)]),...parents.flatMap((x)=>[String(x.sender_telegram_id),String(x.recipient_telegram_id)])])];
      const sr=await db.from('students').select('telegram_id,username,first_name,last_name').in('telegram_id',ids);
      if(sr.error)throw sr.error;
      const byStudent=new Map((sr.data||[]).map((x)=>[String(x.telegram_id),x]));
      const byParent=new Map(parents.map((x)=>[String(x.id),x]));
      const nameFor=(id:string)=>{
        const x=byStudent.get(id);
        return [x?.first_name||'',x?.last_name||''].filter(Boolean).join(' ').trim()||
          (x?.username?'@'+x.username:(id===telegramUser.id?'Siz':'BBSS o‘quvchisi'));
      };
      const messages=list.map((x)=>{
        const parent=x.reply_to?byParent.get(String(x.reply_to)):null;
        return {
          id:String(x.id),message:x.is_deleted?'Xabar olib tashlangan.':x.message,
          isDeleted:x.is_deleted===true,createdAt:x.created_at,
          senderTelegramId:String(x.sender_telegram_id),displayName:nameFor(String(x.sender_telegram_id)),
          isOwn:String(x.sender_telegram_id)===telegramUser.id,
          canDelete:isAdmin||String(x.sender_telegram_id)===telegramUser.id,
          replyTo:parent?{id:String(parent.id),displayName:nameFor(String(parent.sender_telegram_id)),
            message:parent.is_deleted?'Xabar olib tashlangan':String(parent.message||''),isDeleted:parent.is_deleted===true}:null
        };
      });
      return jsonResponse({ok:true,messages});
    } catch(error) {
      const diagnostic=getDiagnostic(error);
      console.error('Direct chat list failed:',diagnostic);
      return jsonResponse({error:'Personal chat yuklanmadi: '+diagnostic},500);
    }
  }

  if (body.action === 'direct_chat_send') {
    const peerId=typeof body.peerTelegramId==='string'?body.peerTelegramId.trim():'';
    const message=typeof body.message==='string'?body.message.trim():'';
    const replyToId=typeof body.replyToId==='string'?body.replyToId.trim():'';
    if(!/^\d{5,20}$/.test(peerId)||peerId===telegramUser.id)return jsonResponse({error:'Student akkaunti noto‘g‘ri tanlangan.'},400);
    if(!message)return jsonResponse({error:'Xabar matnini kiriting.'},400);
    if(message.length>1200)return jsonResponse({error:'Xabar 1200 belgidan oshmasin.'},413);
    if(replyToId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(replyToId))return jsonResponse({error:'Javob xabari noto‘g‘ri.'},400);
    try {
      const courseId=await getAuthorizedChatCourseId(db,telegramUser.id,isAdmin);
      if(!courseId)return jsonResponse({error:'Personal chat uchun admin tasdig‘i kerak.'},403);
      const er=await db.from('enrollments').select('telegram_id,expires_at').eq('course_id',courseId).eq('telegram_id',peerId).eq('status','active').maybeSingle();
      if(er.error)throw er.error;
      if(!er.data||(er.data.expires_at&&new Date(er.data.expires_at).getTime()<=Date.now()))return jsonResponse({error:'Bu studentning chat huquqi faol emas.'},403);
      let replyTo:string|null=null;
      if(replyToId){
        const p=await db.from('direct_chat_messages').select('id,sender_telegram_id,recipient_telegram_id,is_deleted').eq('id',replyToId).eq('course_id',courseId).maybeSingle();
        if(p.error)throw p.error;
        const x=p.data;
        const matches=!!x&&((String(x.sender_telegram_id)===telegramUser.id&&String(x.recipient_telegram_id)===peerId)||(String(x.sender_telegram_id)===peerId&&String(x.recipient_telegram_id)===telegramUser.id));
        if(!x||!matches||x.is_deleted)return jsonResponse({error:'Javob xabari topilmadi.'},404);
        replyTo=String(x.id);
      }
      const ins=await db.from('direct_chat_messages').insert({course_id:courseId,sender_telegram_id:telegramUser.id,recipient_telegram_id:peerId,message,reply_to:replyTo}).select('id,created_at,reply_to').single();
      if(ins.error)throw ins.error;

      // Shaxsiy chatga yangi xabar yetkazilganda, qabul qiluvchiga Telegram orqali bildirishnoma yuboramiz.
      // Botga xabar yuborish ishlamasa ham, bazaga saqlangan chat xabari muvaffaqiyatsiz bo‘lib ko‘rinmasin.
      const senderName = [
        typeof telegramUser.firstName === 'string' ? telegramUser.firstName.trim() : '',
        typeof telegramUser.lastName === 'string' ? telegramUser.lastName.trim() : '',
      ].filter(Boolean).join(' ').slice(0, 120)
        || (telegramUser.username ? '@' + telegramUser.username : 'BBSS SYSTEM o‘quvchisi');
      try {
        await callTelegramBotApi(telegramBotToken, 'sendMessage', {
          chat_id: peerId,
          text: '📩 Sizda yangi xabar bor!\n' +
            'Yuboruvchi: ' + senderName + '\n\n' +
            'Xabarni BBSS SYSTEM ilovasidagi Chats bo‘limidan o‘qing.',
          reply_markup: {
            inline_keyboard: [[
              {
                text: 'BBSS SYSTEM’ni ochish',
                web_app: { url: APP_URL },
              },
            ]],
          },
        });
      } catch (notificationError) {
        console.warn(
          'Direct chat notification failed for recipient ' + peerId + ':',
          getDiagnostic(notificationError),
        );
      }

      return jsonResponse({ok:true,messageId:ins.data.id,createdAt:ins.data.created_at,replyToId:ins.data.reply_to||null});
    }catch(error){
      const diagnostic=getDiagnostic(error);
      console.error('Direct chat send failed:',diagnostic);
      return jsonResponse({error:'Shaxsiy xabar yuborilmadi: '+diagnostic},500);
    }
  }

  if (body.action === 'direct_chat_delete') {
    const messageId=typeof body.messageId==='string'?body.messageId.trim():'';
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId))return jsonResponse({error:'Xabar ID noto‘g‘ri.'},400);
    try{
      const courseId=await getAuthorizedChatCourseId(db,telegramUser.id,isAdmin);
      if(!courseId)return jsonResponse({error:'Chatga kirish huquqi yo‘q.'},403);
      let q=db.from('direct_chat_messages').update({message:'[Xabar olib tashlandi]',is_deleted:true,deleted_at:new Date().toISOString(),deleted_by:telegramUser.id})
        .eq('id',messageId).eq('course_id',courseId).eq('is_deleted',false);
      if(!isAdmin)q=q.eq('sender_telegram_id',telegramUser.id);
      const d=await q.select('id').maybeSingle();
      if(d.error)throw d.error;
      if(!d.data)return jsonResponse({error:'Xabar topilmadi yoki uni olib tashlashga ruxsat yo‘q.'},404);
      return jsonResponse({ok:true});
    }catch(error){
      const diagnostic=getDiagnostic(error);
      console.error('Direct chat delete failed:',diagnostic);
      return jsonResponse({error:'Xabarni olib tashlab bo‘lmadi: '+diagnostic},500);
    }
  }

  // Admin chatdagi nomaqbul xabarni o‘chirishi mumkin (soft-delete).
  if (body.action === 'community_chat_delete') {
    if (!isAdmin) {
      return jsonResponse({ error: 'Xabarni faqat admin o‘chira oladi.' }, 403);
    }

    const messageId = typeof body.messageId === 'string'
      ? body.messageId.trim()
      : '';

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)) {
      return jsonResponse({ error: 'Xabar ID noto‘g‘ri.' }, 400);
    }

    try {
      const courseId = await getAuthorizedChatCourseId(
        db,
        telegramUser.id,
        true,
      );

      if (!courseId) {
        return jsonResponse({ error: 'Kurs topilmadi.' }, 404);
      }

      const { data: deleted, error: deleteError } = await db
        .from('community_chat_messages')
        .update({
          message: '[Xabar admin tomonidan olib tashlandi]',
          is_deleted: true,
          deleted_at: new Date().toISOString(),
          deleted_by: telegramUser.id,
        })
        .eq('id', messageId)
        .eq('course_id', courseId)
        .eq('is_deleted', false)
        .select('id')
        .maybeSingle();

      if (deleteError) throw deleteError;
      if (!deleted) {
        return jsonResponse({ error: 'Xabar topilmadi yoki allaqachon olib tashlangan.' }, 404);
      }

      return jsonResponse({ ok: true, message: 'Xabar olib tashlandi.' });
    } catch (error) {
      const diagnostic = getDiagnostic(error);
      console.error('Community chat delete failed:', diagnostic);
      return jsonResponse(
        { error: 'Xabarni o‘chirib bo‘lmadi: ' + diagnostic },
        500,
      );
    }
  }

  // Katalog, kursga kirish huquqi va foydalanuvchi profil rasmi.
  if (body.action === 'catalog') {
    try {
      const catalog = await createCatalog(
        db,
        telegramUser.id,
        isAdmin,
      );

      const { data: ownProfile, error: ownProfileError } =
        await db
          .from('students')
          .select('avatar_path')
          .eq('telegram_id', telegramUser.id)
          .maybeSingle();

      if (ownProfileError) {
        console.error(
          'Student avatar lookup failed:',
          ownProfileError.message,
        );
      }

      const uploadedPhotoUrl = ownProfileError
        ? null
        : await resolveStudentPhotoUrl(db, ownProfile);

      const profilePhotoUrl =
        uploadedPhotoUrl || telegramUser.photoUrl || null;

      return jsonResponse({
        ...catalog,
        profilePhotoUrl,
      });
    } catch (error) {
      console.error(
        'Catalog lookup failed:',
        getDiagnostic(error),
      );

      return jsonResponse(
        {
          error:
            'Kurs va darslarni yuklashda xatolik yuz berdi.',
        },
        500,
      );
    }
  }

  // Video URL faqat kursga ruxsati bor foydalanuvchiga beriladi.
  if (!bunnyTokenKey) {
    return jsonResponse(
      { error: 'Bunny token key server Secrets ichida topilmadi.' },
      500,
    );
  }

  const lessonId =
    typeof body.lessonId === 'string' ? body.lessonId : '';

  if (!lessonId || lessonId.length > 100) {
    return jsonResponse(
      { error: 'Dars ID yetishmayapti.' },
      400,
    );
  }

  const { data: lesson, error: lessonError } = await db
    .from('lessons')
    .select(
      'id,title,module_id,content_type,storage_path,is_published',
    )
    .eq('id', lessonId)
    .maybeSingle();

  if (lessonError) {
    console.error('Lesson lookup failed:', lessonError.message);

    return jsonResponse(
      { error: 'Darsni tekshirishda xatolik yuz berdi.' },
      500,
    );
  }

  if (!lesson) {
    return jsonResponse({ error: 'Dars topilmadi.' }, 404);
  }

  if (lesson.content_type !== 'video') {
    return jsonResponse(
      { error: 'Bu dars video formatida emas.' },
      400,
    );
  }

  const videoId =
    typeof lesson.storage_path === 'string'
      ? lesson.storage_path.trim()
      : '';

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      videoId,
    )
  ) {
    return jsonResponse(
      { error: 'Bu darsga Bunny Video ID hali ulanmagan.' },
      409,
    );
  }

  const { data: moduleRow, error: moduleError } = await db
    .from('modules')
    .select('id,course_id,is_published')
    .eq('id', lesson.module_id)
    .maybeSingle();

  if (moduleError || !moduleRow) {
    if (moduleError) {
      console.error('Module lookup failed:', moduleError.message);
    }

    return jsonResponse(
      { error: 'Dars modulini tekshirib bo‘lmadi.' },
      500,
    );
  }

  const { data: course, error: courseError } = await db
    .from('courses')
    .select('id,is_published')
    .eq('id', moduleRow.course_id)
    .maybeSingle();

  if (courseError || !course) {
    if (courseError) {
      console.error('Course lookup failed:', courseError.message);
    }

    return jsonResponse(
      { error: 'Kursni tekshirib bo‘lmadi.' },
      500,
    );
  }

  if (!isAdmin) {
    const { data: enrollment, error: enrollmentError } = await db
      .from('enrollments')
      .select('id,status,expires_at')
      .eq('telegram_id', telegramUser.id)
      .eq('course_id', course.id)
      .eq('status', 'active')
      .maybeSingle();

    if (enrollmentError) {
      console.error(
        'Enrollment lookup failed:',
        enrollmentError.message,
      );

      return jsonResponse(
        {
          error:
            'Kursga kirish huquqini tekshirib bo‘lmadi.',
        },
        500,
      );
    }

    const expired = !!(
      enrollment?.expires_at &&
      new Date(enrollment.expires_at).getTime() <= Date.now()
    );

    if (!enrollment || expired) {
      return jsonResponse(
        {
          error:
            'Bu kurs uchun faol ruxsatingiz yo‘q. Administrator tasdig‘ini kuting.',
        },
        403,
      );
    }
  }

  const expires =
    Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS;

  const token = await sha256Hex(
    `${bunnyTokenKey}${videoId}${expires}`,
  );

  const embedUrl =
    `https://player.mediadelivery.net/embed/${BUNNY_LIBRARY_ID}/${encodeURIComponent(videoId)}?token=${token}&expires=${expires}`;

  return jsonResponse({
    lessonId: lesson.id,
    title: lesson.title,
    embedUrl,
    expires,
  });
});