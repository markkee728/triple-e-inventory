-- Quote requests, minimum order, back-in-stock alerts and verified reviews for the online shop.
-- The server also creates all of this by itself when it starts (shop-extras.js), so running this file is optional.
-- Run once against the SAME database the app uses. Safe to rerun:
--   psql "$DATABASE_URL" -f backend/db/006_shop_extras.sql
ALTER TABLE products ADD COLUMN IF NOT EXISTS min_order_qty NUMERIC(14,2) NOT NULL DEFAULT 1 CHECK (min_order_qty > 0);
CREATE SEQUENCE IF NOT EXISTS quote_no_seq START 1001;
CREATE TABLE IF NOT EXISTS quote_requests (
  quote_id BIGSERIAL PRIMARY KEY,
  quote_no TEXT UNIQUE NOT NULL DEFAULT ('QR-' || nextval('quote_no_seq')),
  customer_id INT NOT NULL REFERENCES users(user_id),
  contact_name TEXT NOT NULL, phone TEXT NOT NULL,
  product_sku TEXT, product_name TEXT,
  quantity TEXT NOT NULL, details TEXT NOT NULL,
  needed_by DATE, fulfillment TEXT CHECK (fulfillment IN ('Delivery','Pickup')), area TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','quoted','closed')),
  quoted_amount NUMERIC(14,2) CHECK (quoted_amount >= 0), reply_note TEXT,
  handled_by INT REFERENCES users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_quotes_customer ON quote_requests (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quote_requests (status, created_at DESC);
CREATE TABLE IF NOT EXISTS stock_alerts (
  alert_id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(user_id),
  product_id INT NOT NULL REFERENCES products(product_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), notified_at TIMESTAMPTZ,
  UNIQUE (user_id, product_id));
CREATE TABLE IF NOT EXISTS product_reviews (
  review_id BIGSERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(product_id),
  user_id INT NOT NULL REFERENCES users(user_id),
  order_id BIGINT NOT NULL,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden')),
  hidden_by INT REFERENCES users(user_id), hidden_at TIMESTAMPTZ, hidden_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id));
CREATE INDEX IF NOT EXISTS idx_reviews_product ON product_reviews (product_id, status, created_at DESC);
