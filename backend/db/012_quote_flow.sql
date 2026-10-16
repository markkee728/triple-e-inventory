-- Quote requests: "needed within N months" instead of a date, dropdown size/detail choices,
-- Finance reply details (lead time, validity) and the customer's answer (accept / decline).
-- shop-extras.js also does this on start, so running this by hand is optional.
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS needed_months INT CHECK (needed_months BETWEEN 1 AND 24);
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS specs JSONB;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS lead_time TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS valid_until DATE;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS response_note TEXT;
ALTER TABLE quote_requests DROP CONSTRAINT IF EXISTS quote_requests_status_check;
ALTER TABLE quote_requests ADD CONSTRAINT quote_requests_status_check CHECK (status IN ('new','quoted','accepted','declined','closed'));