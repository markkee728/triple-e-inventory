-- Delivery fee by destination. Most specific match wins: province, then region, then the 'default' row.
-- pos-shop.js creates and seeds this table on start-up too; this file is for running the schema by hand.
CREATE TABLE IF NOT EXISTS delivery_rates (
  rate_id    SERIAL PRIMARY KEY,
  scope      TEXT NOT NULL CHECK (scope IN ('default','region','province')),
  name       TEXT NOT NULL,
  fee        NUMERIC(10,2) NOT NULL CHECK (fee >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_delivery_rates ON delivery_rates (scope, lower(name));
