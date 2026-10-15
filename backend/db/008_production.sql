-- Production-based inventory deduction: material requirements per finished product + production records.
-- The server also creates these by itself when it starts; this file is the same thing for running by hand:
--   psql "$DATABASE_URL" -f backend/db/008_production.sql
BEGIN;
CREATE SEQUENCE IF NOT EXISTS production_ref_seq START 1;

-- materials needed to make ONE unit of a finished product (reused for every future production)
CREATE TABLE IF NOT EXISTS product_materials (
  requirement_id      BIGSERIAL PRIMARY KEY,
  finished_product_id INT NOT NULL REFERENCES products(product_id),
  material_product_id INT NOT NULL REFERENCES products(product_id),
  qty_per_unit        NUMERIC(14,4) NOT NULL CHECK (qty_per_unit > 0),
  unit                TEXT NOT NULL,
  updated_by          INT REFERENCES users(user_id),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (finished_product_id, material_product_id),
  CHECK (finished_product_id <> material_product_id)
);

-- one row per confirmed production; request_key stops a double click from being recorded twice
CREATE TABLE IF NOT EXISTS production_records (
  production_id       BIGSERIAL PRIMARY KEY,
  ref                 TEXT UNIQUE NOT NULL,
  finished_product_id INT NOT NULL REFERENCES products(product_id),
  product_sku         TEXT NOT NULL,
  product_name        TEXT NOT NULL,
  unit                TEXT NOT NULL,
  quantity            NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  status              TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed')),
  note                TEXT,
  request_key         TEXT UNIQUE,
  fg_movement_ref     TEXT,
  recorded_by         INT REFERENCES users(user_id),
  recorded_by_name    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- frozen copy of the materials actually used (stays correct even if the requirements change later)
CREATE TABLE IF NOT EXISTS production_items (
  item_id             BIGSERIAL PRIMARY KEY,
  production_id       BIGINT NOT NULL REFERENCES production_records(production_id),
  material_product_id INT NOT NULL REFERENCES products(product_id),
  material_sku        TEXT NOT NULL,
  material_name       TEXT NOT NULL,
  department          TEXT NOT NULL,
  unit                TEXT NOT NULL,
  qty_per_unit        NUMERIC(14,4) NOT NULL,
  calculated_qty      NUMERIC(14,2) NOT NULL,
  actual_qty          NUMERIC(14,2) NOT NULL CHECK (actual_qty >= 0),
  movement_ref        TEXT
);
CREATE INDEX IF NOT EXISTS idx_prod_items_prod ON production_items (production_id);
CREATE INDEX IF NOT EXISTS idx_prod_records_time ON production_records (created_at DESC);

-- the ledger may point at a production record (source_type 'production')
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'stock_movements'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%source_type%' AND pg_get_constraintdef(oid) NOT ILIKE '%production%'
  LOOP EXECUTE format('ALTER TABLE stock_movements DROP CONSTRAINT %I', c.conname); END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'stock_movements'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) ILIKE '%source_type%') THEN
    ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_source_type_check
      CHECK (source_type IS NULL OR source_type IN ('pos_sale','order','production'));
  END IF;
END $$;
COMMIT;
