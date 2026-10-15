-- 1. Drop existing tables to ensure clean recreation
DROP TABLE IF EXISTS pos_return_items CASCADE;
DROP TABLE IF EXISTS pos_return_requests CASCADE;

-- 2. Create the main return requests table
CREATE TABLE pos_return_requests (
  return_id          BIGSERIAL PRIMARY KEY,
  sale_id            BIGINT NOT NULL REFERENCES pos_sales(sale_id),
  reason             TEXT NOT NULL,
  amount             NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  refund_method      TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  restock            BOOLEAN,
  requested_by       INT REFERENCES users(user_id),
  requested_shift_id BIGINT,
  refund_shift_id    BIGINT,
  decided_by         INT REFERENCES users(user_id),
  decision_note      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at         TIMESTAMPTZ
);

-- 3. Create the return line items table
CREATE TABLE pos_return_items (
  return_item_id BIGSERIAL PRIMARY KEY,
  return_id      BIGINT NOT NULL REFERENCES pos_return_requests(return_id) ON DELETE CASCADE,
  sale_item_id   BIGINT NOT NULL REFERENCES pos_sale_items(item_id),
  product_id     INT REFERENCES products(product_id),
  qty            NUMERIC(14,2) NOT NULL CHECK (qty > 0),
  unit_price     NUMERIC(12,2) NOT NULL,
  amount         NUMERIC(12,2) NOT NULL CHECK (amount >= 0)
);

-- 4. Create performance indexes
CREATE INDEX idx_pos_return_sale ON pos_return_requests (sale_id, status);
CREATE INDEX idx_pos_return_status ON pos_return_requests (status, created_at);
CREATE INDEX idx_pos_return_refund_shift ON pos_return_requests (refund_shift_id);
CREATE INDEX idx_pos_return_items_return ON pos_return_items (return_id);