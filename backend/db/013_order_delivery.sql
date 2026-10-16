-- Delivery details for online orders: who delivers, when it left, and the proof collected.
-- backend/order-delivery.js creates these on start, so running this by hand is optional.
CREATE TABLE IF NOT EXISTS order_deliveries (
  order_id       BIGINT PRIMARY KEY REFERENCES orders(order_id),
  courier        TEXT,                                   -- Own rider, Lalamove, LBC...
  driver_name    TEXT,
  driver_phone   TEXT,
  vehicle_plate  TEXT,
  tracking_no    TEXT,
  dispatched_at  TIMESTAMPTZ,                            -- when it left (Out for Delivery)
  dispatched_by  INT REFERENCES users(user_id),
  delivery_notes TEXT,                                   -- internal; the customer does not see it
  delivered_at   TIMESTAMPTZ,                            -- when it arrived (Delivered)
  delivered_by   INT REFERENCES users(user_id),
  customer_received_at TIMESTAMPTZ,                      -- the customer tapped "I received my order"
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- proof photos (up to 3 per order), kept in the database
CREATE TABLE IF NOT EXISTS order_delivery_proofs (
  proof_id    BIGSERIAL PRIMARY KEY,
  order_id    BIGINT NOT NULL REFERENCES orders(order_id),
  mime        TEXT NOT NULL,
  data        BYTEA NOT NULL,
  uploaded_by INT REFERENCES users(user_id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_odp_order ON order_delivery_proofs (order_id);
-- for a database that already has order_deliveries from before this column existed
ALTER TABLE order_deliveries ADD COLUMN IF NOT EXISTS customer_received_at TIMESTAMPTZ;
