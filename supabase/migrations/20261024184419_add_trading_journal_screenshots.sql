alter table public.trading_journal_entries
  add column if not exists screenshot_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'bbss-journal',
  'bbss-journal',
  false,
  786432,
  array['image/jpeg']::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
