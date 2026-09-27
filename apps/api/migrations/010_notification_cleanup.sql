ALTER TABLE notifications ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS notifications_visible_user_time_idx
  ON notifications(user_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
