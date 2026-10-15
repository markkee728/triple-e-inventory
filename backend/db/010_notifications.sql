-- In-app Notification Center. The server also creates this on startup.
-- Low-stock rows use dedupe_key = 'low_stock:{product_id}' and stay unique while unresolved.
-- Restocking sets is_resolved so the same SKU can alert again on the next drop.

CREATE TABLE IF NOT EXISTS notifications (
  notification_id BIGSERIAL PRIMARY KEY,
  user_id         INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role_key        TEXT NOT NULL,
  category        TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  link            TEXT,
  entity_type     TEXT,
  entity_id       TEXT,
  dedupe_key      TEXT,
  severity        TEXT NOT NULL DEFAULT 'info',
  is_read         BOOLEAN NOT NULL DEFAULT FALSE,
  read_at         TIMESTAMPTZ,
  is_resolved     BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at     TIMESTAMPTZ,
  meta            JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_time
  ON notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id) WHERE NOT is_read;

CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_open_dedupe
  ON notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND NOT is_resolved;
