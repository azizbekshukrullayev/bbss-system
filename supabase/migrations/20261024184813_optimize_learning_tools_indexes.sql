drop index if exists public.lesson_progress_telegram_lesson_uidx;

create index if not exists announcements_created_by_idx
  on public.announcements (created_by);
create index if not exists certificates_user_course_idx
  on public.certificates (telegram_id, course_id);
create index if not exists qa_answers_author_idx
  on public.qa_answers (telegram_id);
create index if not exists qa_questions_lesson_idx
  on public.qa_questions (lesson_id);
create index if not exists qa_questions_author_idx
  on public.qa_questions (telegram_id);
create index if not exists quiz_attempts_quiz_idx
  on public.quiz_attempts (quiz_id);
create index if not exists quizzes_module_idx
  on public.quizzes (module_id);
create index if not exists quizzes_created_by_idx
  on public.quizzes (created_by);
create index if not exists saved_lessons_lesson_idx
  on public.saved_lessons (lesson_id);
create index if not exists journal_course_idx
  on public.trading_journal_entries (course_id);
