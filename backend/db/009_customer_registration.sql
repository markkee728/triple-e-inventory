-- Customer registration: 3-step sign-up details, email verification, terms/privacy consent, optional company info.
-- The server runs the same statements at start-up, so running this by hand is optional. Safe to run more than once.

-- Existing accounts count as verified; the backfill runs only the first time the column is added.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'email_verified_at') THEN
    ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;
    UPDATE users SET email_verified_at = COALESCE(created_at, now());
  END IF;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS middle_name         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suffix              TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS birthdate           DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender              TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_name        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_position    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_tin         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at   TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_accepted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version       TEXT;

-- One-time email verification links (only a SHA-256 hash of the token is stored).
-- new_email is set when a signed-in customer is changing their address: the old one stays active until the link is used.
CREATE TABLE IF NOT EXISTS email_verifications (
  verification_id BIGSERIAL PRIMARY KEY,
  user_id         INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  new_email       TEXT,
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_verif_user ON email_verifications (user_id);
