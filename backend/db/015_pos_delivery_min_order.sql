-- 015: POS delivery mode + company-wide minimum order (manufacturing).
-- The server also runs these on start (pos-shop.js / shop-extras.js), so this file is only for running by hand.

-- Minimum order: Finance sets it per product between 20 and 50 (MIN_ORDER_FLOOR / MIN_ORDER_CAP in .env). New products start at 20.
-- Old rows that still say 1 are treated as 20 by the server; this makes the stored value match.
ALTER TABLE products ALTER COLUMN min_order_qty SET DEFAULT 20;
UPDATE products SET min_order_qty = 20 WHERE department = 'Finished Goods' AND min_order_qty < 20;

-- POS delivery: the address, fee and recipient are kept on the sale (the fee is part of total).
ALTER TABLE pos_sales
  ADD COLUMN IF NOT EXISTS fulfillment           TEXT NOT NULL DEFAULT 'Walk-in',   -- 'Walk-in' | 'Delivery'
  ADD COLUMN IF NOT EXISTS delivery_fee          NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivery_recipient    TEXT,
  ADD COLUMN IF NOT EXISTS delivery_address_line TEXT,
  ADD COLUMN IF NOT EXISTS delivery_landmark     TEXT,
  ADD COLUMN IF NOT EXISTS delivery_barangay     TEXT,
  ADD COLUMN IF NOT EXISTS delivery_city         TEXT,
  ADD COLUMN IF NOT EXISTS delivery_province     TEXT,
  ADD COLUMN IF NOT EXISTS delivery_region       TEXT,
  ADD COLUMN IF NOT EXISTS delivery_zip          TEXT,
  ADD COLUMN IF NOT EXISTS delivery_address      TEXT;                              -- the full address as the shop writes it

ALTER TABLE pos_xendit_payments ADD COLUMN IF NOT EXISTS delivery JSONB;             -- fee + address kept until the online payment is verified
