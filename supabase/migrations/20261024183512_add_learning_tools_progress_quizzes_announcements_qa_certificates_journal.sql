create unique index if not exists lesson_progress_telegram_lesson_uidx
  on public.lesson_progress (telegram_id, lesson_id);

create table if not exists public.saved_lessons (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  telegram_id text not null references public.students(telegram_id) on delete cascade,
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (course_id, telegram_id, lesson_id)
);
alter table public.saved_lessons enable row level security;

create table if not exists public.quizzes (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  module_id uuid references public.modules(id) on delete set null,
  title text not null check (char_length(title) between 1 and 140),
  description text not null default '',
  pass_percent integer not null default 70 check (pass_percent between 1 and 100),
  is_published boolean not null default false,
  created_by text references public.students(telegram_id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.quizzes enable row level security;

create table if not exists public.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  question text not null check (char_length(question) between 1 and 800),
  options jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 6),
  correct_index integer not null check (correct_index between 0 and 5),
  explanation text not null default '',
  position integer not null default 1 check (position > 0),
  created_at timestamptz not null default now()
);
alter table public.quiz_questions enable row level security;

create table if not exists public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  telegram_id text not null references public.students(telegram_id) on delete cascade,
  score integer not null check (score >= 0),
  total_questions integer not null check (total_questions > 0),
  passed boolean not null default false,
  answers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.quiz_attempts enable row level security;

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  body text not null check (char_length(body) between 1 and 5000),
  is_published boolean not null default false,
  is_pinned boolean not null default false,
  created_by text references public.students(telegram_id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
alter table public.announcements enable row level security;

create table if not exists public.qa_questions (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  telegram_id text not null references public.students(telegram_id) on delete cascade,
  lesson_id uuid references public.lessons(id) on delete set null,
  title text not null check (char_length(title) between 1 and 180),
  body text not null check (char_length(body) between 1 and 4000),
  status text not null default 'open' check (status in ('open','answered','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.qa_questions enable row level security;

create table if not exists public.qa_answers (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.qa_questions(id) on delete cascade,
  telegram_id text not null references public.students(telegram_id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.qa_answers enable row level security;

create table if not exists public.certificates (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  telegram_id text not null references public.students(telegram_id) on delete cascade,
  certificate_code text not null unique,
  completed_lessons integer not null check (completed_lessons >= 0),
  total_lessons integer not null check (total_lessons > 0),
  issued_at timestamptz not null default now(),
  unique (course_id, telegram_id)
);
alter table public.certificates enable row level security;

create table if not exists public.trading_journal_entries (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  telegram_id text not null references public.students(telegram_id) on delete cascade,
  symbol text not null check (symbol in ('XAUUSD','EURUSD')),
  direction text not null check (direction in ('LONG','SHORT')),
  entry_price numeric(16,6) not null check (entry_price > 0),
  stop_loss numeric(16,6) check (stop_loss is null or stop_loss > 0),
  take_profit numeric(16,6) check (take_profit is null or take_profit > 0),
  exit_price numeric(16,6) check (exit_price is null or exit_price > 0),
  outcome text not null default 'OPEN' check (outcome in ('WIN','LOSS','BE','OPEN')),
  setup text not null default '' check (char_length(setup) <= 180),
  notes text not null default '' check (char_length(notes) <= 3000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.trading_journal_entries enable row level security;

create index if not exists saved_lessons_user_course_idx on public.saved_lessons (telegram_id, course_id, created_at desc);
create index if not exists quizzes_course_published_idx on public.quizzes (course_id, is_published, created_at desc);
create index if not exists quiz_questions_order_idx on public.quiz_questions (quiz_id, position);
create index if not exists quiz_attempts_user_idx on public.quiz_attempts (telegram_id, quiz_id, created_at desc);
create index if not exists announcements_course_idx on public.announcements (course_id, is_published, is_pinned desc, published_at desc);
create index if not exists qa_questions_course_idx on public.qa_questions (course_id, status, created_at desc);
create index if not exists qa_answers_question_idx on public.qa_answers (question_id, created_at);
create index if not exists journal_user_idx on public.trading_journal_entries (telegram_id, course_id, created_at desc);
create index if not exists progress_user_idx on public.lesson_progress (telegram_id, lesson_id, is_completed);
