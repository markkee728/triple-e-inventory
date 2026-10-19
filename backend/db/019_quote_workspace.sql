-- 019_quote_workspace.sql — the Cashier Quotation Desk.
-- Adds the reference-drawing storage and the quotation -> order / POS hand-off bookkeeping.
-- Everything is additive: no table, column, constraint or record is dropped. Safe to run more than once.
--
-- The Node module backend/quote-desk.js runs these same statements by itself when the server starts, so on Cloud Run
-- this file is only needed when you want to apply the change ahead of the deployment (see README_DEPLOY.md).
--
--   psql "$DATABASE_URL" -f backend/db/019_quote_workspace.sql
-- or, through the Cloud SQL proxy (cloud-sql-proxy <CONNECTION_NAME> & then):
--   psql "host=127.0.0.1 port=5432 dbname=$DB_NAME user=$DB_USER password=$DB_PASSWORD" -f backend/db/019_quote_workspace.sql

BEGIN;

-- Walk-in customers often give an email and a company as well as a mobile number, and sometimes have no deadline.
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS contact_email   TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS company_name     TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS flexible_date    BOOLEAN NOT NULL DEFAULT FALSE;

-- What the desk list links to once a quotation has been turned into a real order (or handed to the counter).
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS converted_order_id   BIGINT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS converted_at         TIMESTAMPTZ;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS converted_note       TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS convert_request_id   TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS handover_sale_id     BIGINT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS handover_at          TIMESTAMPTZ;

-- Retrying the same conversion with the same identifier must not make a second order.
CREATE UNIQUE INDEX IF NOT EXISTS uq_quote_convert_request
  ON quote_requests (convert_request_id) WHERE convert_request_id IS NOT NULL;

-- Reference drawings / product photos attached to a quotation. Stored as bytes in the database, like the
-- proof-of-delivery photos (order_delivery_proofs), so Cloud Run's ephemeral disk is never the system of record.
CREATE TABLE IF NOT EXISTS quote_attachments (
  attachment_id BIGSERIAL PRIMARY KEY,
  quote_id      BIGINT   NOT NULL REFERENCES quote_requests(quote_id) ON DELETE CASCADE,
  file_name     TEXT     NOT NULL,
  mime          TEXT     NOT NULL,
  size_bytes    INT      NOT NULL,
  data          BYTEA    NOT NULL,
  uploaded_by   INT      REFERENCES users(user_id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quote_attachments ON quote_attachments (quote_id, attachment_id);

-- The desk filters and sorts the queue every few seconds; these keep that cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_quotes_desk_status  ON quote_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_desk_source  ON quote_requests (source, created_at DESC);

COMMIT;

-- Check what was created (read-only):
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'quote_requests' ORDER BY 1;
--   SELECT count(*) FROM quote_attachments;
