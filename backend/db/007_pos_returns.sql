-- Partial returns of POS sales: the cashier requests, Finance approves, approved items can go back in stock.
-- The server also creates these tables by itself when it starts; this file is the same thing for running by hand.
CREATE TABLE IF NOT EXISTS pos_return_requests (
  return_id          BIGSERIAL PRIMARY KEY,
  sale_id            BIGINT NOT NULL REFERENCES pos_sales(sale_id),
  reason             TEXT NOT NULL,
  amount             NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  refund_method      TEXT NOT NULL,                       -- the sale's payment method; 'Cash' refunds come out of the cashier's drawer
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  restock            BOOLEAN,                             -- Finance's choice at approval: were the items resellable?
  requested_by       INT REFERENCES users(user_id),
  requested_shift_id BIGINT,                              -- cashier's open cash shift when the cash return was requested
  refund_shift_id    BIGINT,                              -- cash shift the refund was charged to when Finance approved
  decided_by         INT REFERENCES users(user_id),
  decision_note      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at         TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS pos_return_items (
  return_item_id BIGSERIAL PRIMARY KEY,
  return_id      BIGINT NOT NULL REFERENCES pos_return_requests(return_id),
  sale_item_id   BIGINT NOT NULL REFERENCES pos_sale_items(item_id),
  product_id     INT REFERENCES products(product_id),
  qty            NUMERIC(14,2) NOT NULL CHECK (qty > 0),
  unit_price     NUMERIC(12,2) NOT NULL,
  amount         NUMERIC(12,2) NOT NULL CHECK (amount >= 0)
);
CREATE INDEX IF NOT EXISTS idx_pos_return_sale ON pos_return_requests (sale_id, status);
CREATE INDEX IF NOT EXISTS idx_pos_return_status ON pos_return_requests (status, created_at);
CREATE INDEX IF NOT EXISTS idx_pos_return_refund_shift ON pos_return_requests (refund_shift_id);
CREATE INDEX IF NOT EXISTS idx_pos_return_items_return ON pos_return_items (return_id);
