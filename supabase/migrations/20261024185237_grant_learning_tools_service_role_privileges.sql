GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.lesson_progress,
  public.saved_lessons,
  public.quizzes,
  public.quiz_questions,
  public.quiz_attempts,
  public.announcements,
  public.qa_questions,
  public.qa_answers,
  public.certificates,
  public.trading_journal_entries
TO service_role;
