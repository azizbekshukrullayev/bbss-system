import { createClient } from 'npm:@supabase/supabase-js@2';

const SITE_ORIGIN = 'https://azizbekshukrullayev.github.io';
const COURSE_SLUG = 'bbss-trading-course';
const BUNNY_LIBRARY_ID = '788308';
const AVATAR_BUCKET = 'student-avatars';
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
    return {
      course: null,
      modules: [],
      admin: false,
      accessRequired: true,
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