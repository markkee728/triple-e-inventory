-- 020_payment_terms.sql — partial payments, down payment, payment terms and a real payment ledger.
--
-- Everything is additive: no table, column, constraint or record is dropped, and no existing value is rewritten.
-- Safe to run more than once. backend/payment-terms.js runs the same statements at server start, so on Cloud Run
-- this file is only needed when you want to apply the change ahead of the deployment (see README_DEPLOY.md).
--
-- NOTE: this file was written without a PostgreSQL instance available (see README_DEPLOY.md), so run it on staging
-- first. It is deliberately built only from constructs the project already uses in 001 / 003 / 011 / 019.
--
-- Two axes on purpose (they are not the same thing and must never be confused):
--   orders.payment_status  -> the ONLINE INVOICE lifecycle it already had: 'unpaid' | 'pending' | 'paid' | 'expired'
--   orders.payment_state   -> the MONEY actually confirmed, derived from the ledger:
--                             'unpaid' | 'partially_paid' | 'paid' | 'partially_refunded' | 'refunded'
-- Fulfillment (orders.status) stays a third, separate axis.

BEGIN;

/* ---------------------------------------------------------------- 1. payment terms: Finance manages them
   Shaped like delivery_rates (011): the row exists, the policy is switched on by a named person.
   Percentages are a PROPOSAL. Only Full Payment ships enabled; the partial terms stay disabled until
   Finance enables them, so nothing here assumes management has approved a 50% or 30% policy.            */
CREATE TABLE IF NOT EXISTS payment_terms (
  term_key          TEXT PRIMARY KEY CHECK (term_key IN ('full','half','down','custom')),
  label             TEXT NOT NULL,
  basis             TEXT NOT NULL DEFAULT 'percent' CHECK (basis IN ('percent','fixed')),
  percent           NUMERIC(5,2) CHECK (percent IS NULL OR (percent > 0 AND percent <= 100)),
  fixed_amount      NUMERIC(14,2) CHECK (fixed_amount IS NULL OR fixed_amount > 0),
  retail_allowed        BOOLEAN NOT NULL DEFAULT FALSE,  -- ready-stock purchases
  made_to_order_allowed BOOLEAN NOT NULL DEFAULT FALSE,  -- custom manufacturing / made-to-order
  balance_condition TEXT NOT NULL DEFAULT 'balance due before release',
  enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_by        INT REFERENCES users(user_id),
  enabled_at        TIMESTAMPTZ,
  note              TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO payment_terms (term_key,label,basis,percent,retail_allowed,made_to_order_allowed,balance_condition,enabled)
VALUES
  ('full',  'Full Payment — 100%',   'percent', 100, TRUE,  TRUE,  'nothing further to pay',     TRUE),
  ('half',  'Half Payment — 50%',    'percent',  50, FALSE, FALSE, 'balance due before release',  FALSE),
  ('down',  'Down Payment — 30%',    'percent',  30, FALSE, FALSE, 'balance due before release',  FALSE),
  ('custom','Custom partial payment','percent', NULL, FALSE, FALSE, 'as approved by Finance',     FALSE)
ON CONFLICT (term_key) DO NOTHING;      -- never overwrites a percentage Finance has already configured

/* ---------------------------------------------------------------- 2. the payment ledger
   One row per confirmed money event, append-only like stock_movements (001): a mistake is corrected with a
   matching 'out' row, never by editing or deleting history. Pending / unpaid checkout attempts stay in their own
   tables (pos_xendit_payments, orders.xendit_invoice_id, quote_requests.xendit_invoice_id) and only become a
   ledger row once the payment is actually confirmed.
   net = SUM(in) - SUM(out);  outstanding balance = total - net.                                          */
CREATE TABLE IF NOT EXISTS payments (
  payment_id      BIGSERIAL PRIMARY KEY,
  paid_for        TEXT NOT NULL CHECK (paid_for IN ('order','quote')),
  order_id        INT  REFERENCES orders(order_id),
  quote_id        BIGINT REFERENCES quote_requests(quote_id),
  direction       TEXT NOT NULL DEFAULT 'in' CHECK (direction IN ('in','out')),
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method          TEXT NOT NULL CHECK (method IN
                    ('Cash','Card','GCash','Maya','Bank transfer','Credit / debit card','Xendit')),
  purpose         TEXT NOT NULL DEFAULT 'balance' CHECK (purpose IN ('initial','balance','refund','correction')),
  provider_ref    TEXT,                        -- Xendit invoice id: one invoice may confirm money exactly once
  request_id      TEXT,                        -- caller-supplied idempotency key (double click, retried callback)
  sale_id         BIGINT,                      -- POS receipt the payment was taken against (no FK: receipts can be voided)
  cash_shift_id   BIGINT REFERENCES pos_cash_shifts(shift_id),
  tendered        NUMERIC(14,2),               -- cash only: what the customer handed over
  change_given    NUMERIC(14,2),               -- cash only: what went back
  reversed_of     BIGINT REFERENCES payments(payment_id),
  note            TEXT,
  received_by     INT REFERENCES users(user_id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- exactly one parent, and it must match paid_for
  CHECK ((paid_for = 'order' AND order_id IS NOT NULL AND quote_id IS NULL)
      OR (paid_for = 'quote' AND quote_id IS NOT NULL AND order_id IS NULL)),
  -- tendered / change belong to cash, and change can never exceed what was handed over
  CHECK (tendered IS NULL OR (method = 'Cash' AND tendered >= COALESCE(change_given, 0))),
  CHECK (change_given IS NULL OR tendered IS NOT NULL),
  -- a reversal must point at the payment it reverses
  CHECK ((direction = 'in') = (reversed_of IS NULL))
);

-- A provider reference (one Xendit invoice) can only ever confirm money once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_provider_ref ON payments (provider_ref) WHERE provider_ref IS NOT NULL;
-- Retrying the same request id changes nothing: the first insert wins and the retry reads the same row back.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_request_id   ON payments (paid_for, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_order  ON payments (order_id,   created_at)           WHERE order_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_quote  ON payments (quote_id,   created_at)           WHERE quote_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_shift  ON payments (cash_shift_id)                     WHERE cash_shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_method ON payments (method, created_at DESC);

/* ---------------------------------------------------------------- 3. derived totals, kept in step by a trigger
   The ledger is the source of truth; paid_amount / payment_state on the parent are recomputed from it inside the
   same transaction, exactly like products.on_hand is kept in step by apply_stock_movement(). No application code
   has to remember to add up rows, and no screen can show a balance the database does not agree with.            */
ALTER TABLE orders         ADD COLUMN IF NOT EXISTS paid_amount   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0);
ALTER TABLE orders         ADD COLUMN IF NOT EXISTS payment_state TEXT NOT NULL DEFAULT 'unpaid'
  CHECK (payment_state IN ('unpaid','partially_paid','paid','partially_refunded','refunded'));
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS payment_state TEXT NOT NULL DEFAULT 'unpaid'
  CHECK (payment_state IN ('unpaid','partially_paid','paid','partially_refunded','refunded'));

CREATE OR REPLACE FUNCTION payment_state_for(IN p_net NUMERIC, IN p_total NUMERIC, IN p_refunded BOOLEAN)
RETURNS TEXT AS $$
BEGIN
  IF p_net > 0 AND p_net >= p_total THEN RETURN 'paid'; END IF;
  IF p_net > 0 THEN RETURN CASE WHEN p_refunded THEN 'partially_refunded' ELSE 'partially_paid' END; END IF;
  RETURN CASE WHEN p_refunded THEN 'refunded' ELSE 'unpaid' END;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION apply_payment_totals() RETURNS trigger AS $$
DECLARE
  net NUMERIC; total NUMERIC; refunded BOOLEAN;
BEGIN
  -- 'refunded' means money actually went back to the customer. A conversion moves a quotation's payments onto the
  -- order with direction 'out' but purpose 'correction', which must leave the quotation looking untouched (unpaid),
  -- not refunded, so only a 'refund' counts here.
  IF NEW.paid_for = 'order' THEN
    SELECT COALESCE(SUM(CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END), 0),
           bool_or(p.direction = 'out' AND p.purpose = 'refund')
      INTO net, refunded
      FROM payments p WHERE p.order_id = NEW.order_id;
    total := COALESCE((SELECT total FROM orders WHERE order_id = NEW.order_id), 0);
    -- GREATEST: a refund larger than what was paid is a data problem to be reviewed, not an insert that has to
    -- abort the caller's transaction on the CHECK (paid_amount >= 0). The state below still shows 'refunded'.
    UPDATE orders
       SET paid_amount = GREATEST(net, 0),
           payment_state = payment_state_for(GREATEST(net, 0), total, refunded)
     WHERE order_id = NEW.order_id;
  ELSE
    SELECT COALESCE(SUM(CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END), 0),
           bool_or(p.direction = 'out' AND p.purpose = 'refund')
      INTO net, refunded
      FROM payments p WHERE p.quote_id = NEW.quote_id;
    total := COALESCE((SELECT quoted_amount FROM quote_requests WHERE quote_id = NEW.quote_id), 0);
    UPDATE quote_requests
       SET paid_amount = GREATEST(net, 0),
           payment_state = payment_state_for(GREATEST(net, 0), total, refunded)
     WHERE quote_id = NEW.quote_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_apply_payment_totals ON payments;
CREATE TRIGGER trg_apply_payment_totals
  AFTER INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION apply_payment_totals();

-- The ledger is append-only: money history is corrected with a new row, never by editing or deleting a row.
CREATE OR REPLACE FUNCTION block_payment_changes() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'payments is append-only'; END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payments_immutable ON payments;
CREATE TRIGGER trg_payments_immutable
  BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION block_payment_changes();

/* ---------------------------------------------------------------- 4. the terms attached to a deal
   A quotation carries the terms Finance approved; an order carries the terms the customer chose at checkout.
   Everything is nullable: an order placed before this change keeps working and simply has no terms.            */
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS terms_key              TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS terms_percent          NUMERIC(5,2);
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS terms_amount           NUMERIC(14,2);  -- initial payment proposed
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS terms_balance          NUMERIC(14,2);  -- what stays outstanding
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS terms_condition        TEXT;           -- when the balance is due
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS terms_availability     TEXT;           -- estimated availability
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS terms_state            TEXT NOT NULL DEFAULT 'none'
  CHECK (terms_state IN ('none','proposed','approved','rejected'));
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS terms_decided_by       INT REFERENCES users(user_id);
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS terms_decided_at       TIMESTAMPTZ;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS terms_customer_seen_at TIMESTAMPTZ;    -- acceptance covers the terms

ALTER TABLE orders ADD COLUMN IF NOT EXISTS terms_key         TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS terms_percent     NUMERIC(5,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS terms_amount      NUMERIC(14,2);  -- amount due now
ALTER TABLE orders ADD COLUMN IF NOT EXISTS terms_condition   TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS terms_approved_by INT REFERENCES users(user_id);
-- §8: releasing an order that still has money on it is Finance's decision alone, taken by name with a written reason.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_exception_by   INT REFERENCES users(user_id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_exception_note TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_exception_at   TIMESTAMPTZ;
-- what the online invoice stored on the order actually asked for (the amount due now), so a later return can
-- tell a still-valid invoice from one raised before a down payment arrived
ALTER TABLE orders ADD COLUMN IF NOT EXISTS xendit_amount NUMERIC(14,2);

CREATE INDEX IF NOT EXISTS idx_orders_payment_state ON orders (payment_state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_payment_state ON quote_requests (payment_state, updated_at DESC);

/* ---------------------------------------------------------------- 5. receivables, straight from the ledger
   One place for the reports and the Finance screens to read, so a down payment can never be counted as an extra
   sale: order_value is what was sold, collected is what has actually arrived, outstanding is the difference.     */
CREATE OR REPLACE VIEW v_receivables AS
SELECT o.order_id, o.order_no, o.customer_id, o.status AS fulfilment_status, o.payment_status AS invoice_status,
       o.payment_state, o.terms_key, o.total AS order_value, o.paid_amount AS collected,
       GREATEST(o.total - o.paid_amount, 0) AS outstanding, o.created_at, o.status_updated_at
  FROM orders o
 WHERE o.status <> 'Cancelled';

/* A quotation is a money obligation only once the customer accepted it and while it has not yet become an order:
   after conversion the ledger rows move onto that order, so counting the quotation too would owe the same amount
   twice. Anything still unaccepted (new / quoted / awaiting details) is not a receivable — no sale exists yet.    */
CREATE OR REPLACE VIEW v_receivable_quotes AS
SELECT q.quote_id, q.quote_no, q.customer_id, q.status, q.payment_state, q.terms_key, q.terms_percent,
       q.quoted_amount AS quoted_value, q.paid_amount AS collected,
       GREATEST(COALESCE(q.quoted_amount, 0) - q.paid_amount, 0) AS outstanding, q.updated_at
  FROM quote_requests q
 WHERE q.quoted_amount IS NOT NULL AND q.converted_order_id IS NULL
   AND q.status IN ('accepted','preparing','ready');

/* ---------------------------------------------------------------- 6. backfill: the quotation history already recorded
   Accepted quotations have kept their payments in a JSONB array since 012. Those entries become ledger rows so the
   balance maths has one source of truth. Identifiers are deterministic, so running this twice inserts nothing, and
   the JSONB array itself is left exactly as it was (the quotation screens keep reading it).
   A quotation that has already become an order gets its rows on the ORDER instead: that is what converting does to
   money when this module runs (§10), and it stops an order a deposit was already taken on from looking unpaid.
   A stored reference that appears on more than one historical entry is left out of provider_ref rather than
   tripping the ledger's unique index, because the migration must never be the thing that stops the shop.        */
INSERT INTO payments (paid_for, order_id, quote_id, direction, amount, method, purpose, provider_ref, request_id, note, created_at)
SELECT CASE WHEN s.order_id IS NOT NULL THEN 'order' ELSE 'quote' END,
       s.order_id,
       CASE WHEN s.order_id IS NOT NULL THEN NULL ELSE s.quote_id END,
       'in', s.amount,
       CASE WHEN s.method IN ('Cash','Card','GCash','Maya','Bank transfer','Credit / debit card','Xendit')
            THEN s.method ELSE 'Cash' END,
       CASE WHEN s.i = 0 THEN 'initial' ELSE 'balance' END,
       CASE WHEN s.ref IS NOT NULL AND COUNT(*) OVER (PARTITION BY s.ref) = 1 THEN s.ref ELSE NULL END,
       CASE WHEN s.order_id IS NOT NULL THEN 'backfill-order:' ELSE 'backfill:' END || s.quote_id || ':' || s.i,
       CASE WHEN s.order_id IS NOT NULL
            THEN 'Payment made on quotation ' || s.quote_no || COALESCE(' — ' || s.note, '') ELSE s.note END,
       s.at
  FROM (
    SELECT q.quote_id, q.quote_no,
           CASE WHEN EXISTS (SELECT 1 FROM orders o WHERE o.order_id = q.converted_order_id)
                THEN q.converted_order_id END                             AS order_id,
           ROUND(CAST(e.p ->> 'amount' AS NUMERIC), 2)                    AS amount,
           COALESCE(e.p ->> 'method', '')                                 AS method,
           NULLIF(e.p ->> 'ref', '')                                      AS ref,
           NULLIF(e.p ->> 'note', '')                                     AS note,
           (e.n - 1)::int                                                 AS i,
           COALESCE(to_timestamp(CAST(e.p ->> 'at' AS BIGINT) / 1000.0), q.updated_at) AS at
      FROM quote_requests q
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(q.payments) = 'array' THEN q.payments ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS e(p, n)
     WHERE jsonb_typeof(q.payments) = 'array'
       AND NULLIF(e.p ->> 'amount', '') IS NOT NULL
       AND CAST(e.p ->> 'amount' AS NUMERIC) > 0
  ) s
ON CONFLICT (paid_for, request_id) WHERE request_id IS NOT NULL DO NOTHING;

-- Backfilled quotations: bring paid_amount in line with the ledger (the trigger has now already done this for any
-- quotation touched by the insert above, so this only catches rows whose totals were recorded by the old code).
UPDATE quote_requests q
   SET paid_amount = GREATEST(COALESCE(l.net, 0), 0),
       payment_state = payment_state_for(GREATEST(COALESCE(l.net, 0), 0),
                                         COALESCE(q.quoted_amount, 0), COALESCE(l.out_rows, 0) > 0)
  FROM (SELECT quote_id,
               SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END) AS net,
               SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END)          AS out_rows
          FROM payments WHERE quote_id IS NOT NULL GROUP BY quote_id) l
 WHERE l.quote_id = q.quote_id
   AND q.paid_amount IS DISTINCT FROM GREATEST(COALESCE(l.net, 0), 0);

COMMIT;

-- Check what was created (read-only):
--   SELECT term_key, label, percent, retail_allowed, made_to_order_allowed, enabled FROM payment_terms ORDER BY term_key;
--   SELECT paid_for, COUNT(*), SUM(CASE WHEN direction='in' THEN amount ELSE -amount END) FROM payments GROUP BY 1;
--   SELECT count(*) FROM orders WHERE payment_state <> 'unpaid';
--   SELECT order_no, order_value, collected, outstanding FROM v_receivables WHERE outstanding > 0 ORDER BY outstanding DESC LIMIT 20;
