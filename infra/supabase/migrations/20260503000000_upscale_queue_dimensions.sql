alter table upscale_queue
  add column if not exists width  integer default 0,
  add column if not exists height integer default 0;
