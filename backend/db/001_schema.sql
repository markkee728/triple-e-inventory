-- Triple E Metal Products — Inventory core schema (PostgreSQL)
-- Run order: 001_schema.sql, then 002_seed.sql
BEGIN;

CREATE TABLE roles (
  role_id   SERIAL PRIMARY KEY,
  role_key  TEXT UNIQUE NOT NULL,           -- finance | cashier | customer
  label     TEXT NOT NULL
);

CREATE TABLE users (
  user_id       SERIAL PRIMARY KEY,
  full_name     TEXT NOT NULL,
  username      TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role_id       INT NOT NULL REFERENCES roles(role_id),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE invitations (
  invitation_id SERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  full_name     TEXT,
  role_id       INT NOT NULL REFERENCES roles(role_id),
  token_hash    TEXT UNIQUE,             -- SHA-256 of the one-time sign-up link token (the token itself is never stored)
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_by    INT REFERENCES users(user_id)
);

CREATE TABLE audit_log (
  audit_id    BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     INT REFERENCES users(user_id),
  user_name   TEXT,
  role_label  TEXT,
  action      TEXT NOT NULL,
  detail      TEXT
);
CREATE INDEX idx_audit_time ON audit_log (occurred_at DESC);

CREATE TABLE categories (
  category_id SERIAL PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL
);

CREATE TABLE suppliers (
  supplier_id SERIAL PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,         
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  location    TEXT,
  contact     TEXT,
  supplies    TEXT
);

CREATE TABLE products (
  product_id    SERIAL PRIMARY KEY,
  sku           TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  department    TEXT NOT NULL CHECK (department IN
                  ('Raw Materials','Finished Goods','Finishing Supplies')),
  category_id   INT REFERENCES categories(category_id),
  grade         TEXT,
  form          TEXT,
  unit          TEXT NOT NULL,
  unit_cost     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  selling_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  on_hand       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reorder_level NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  location      TEXT,
  is_archived   BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX idx_products_dept ON products (department);

CREATE TABLE product_suppliers (
  product_id  INT NOT NULL REFERENCES products(product_id),
  supplier_id INT NOT NULL REFERENCES suppliers(supplier_id),
  is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (product_id, supplier_id)
);

CREATE SEQUENCE movement_ref_seq START 8000;

-- Append-only ledger. source_type/source_id will point at POS sales / online orders later.
CREATE TABLE stock_movements (
  movement_id   BIGSERIAL PRIMARY KEY,
  ref           TEXT UNIQUE NOT NULL DEFAULT ('MV-' || nextval('movement_ref_seq')),
  product_id    INT NOT NULL REFERENCES products(product_id),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('in','out')),
  reason        TEXT NOT NULL DEFAULT 'supplier_receipt' CHECK (reason IN
                  ('supplier_receipt','sale','online_order','write_off','damage','correction','return','refund')),
  quantity      NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  supplier_id   INT REFERENCES suppliers(supplier_id),
  handled_by    INT REFERENCES users(user_id),
  source_type   TEXT CHECK (source_type IN ('pos_sale','order')),
  source_id     BIGINT,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_mv_product ON stock_movements (product_id, created_at DESC);

-- Keep products.on_hand in sync inside the same transaction as the movement.
CREATE OR REPLACE FUNCTION apply_stock_movement() RETURNS trigger AS $$
DECLARE cur NUMERIC;
BEGIN
  SELECT on_hand INTO cur FROM products WHERE product_id = NEW.product_id FOR UPDATE;
  IF NEW.movement_type = 'out' AND cur < NEW.quantity THEN
    RAISE EXCEPTION 'Insufficient stock: % on hand, % requested', cur, NEW.quantity
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE products
     SET on_hand = on_hand + CASE WHEN NEW.movement_type = 'in' THEN NEW.quantity ELSE -NEW.quantity END
   WHERE product_id = NEW.product_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_apply_stock_movement
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

-- Ledger is append-only.
CREATE OR REPLACE FUNCTION block_movement_changes() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'stock_movements is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_movements_immutable
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION block_movement_changes();

-- Price / cost changes are audited automatically.
CREATE OR REPLACE FUNCTION audit_price_change() RETURNS trigger AS $$
DECLARE uid INT := NULLIF(current_setting('app.user_id', true), '')::INT;
BEGIN
  IF NEW.selling_price IS DISTINCT FROM OLD.selling_price OR NEW.unit_cost IS DISTINCT FROM OLD.unit_cost THEN
    INSERT INTO audit_log (user_id, user_name, role_label, action, detail)
    SELECT uid, u.full_name, r.label, 'Price changed',
           format('%s — cost %s→%s, price %s→%s', NEW.sku, OLD.unit_cost, NEW.unit_cost, OLD.selling_price, NEW.selling_price)
      FROM (SELECT 1) x LEFT JOIN users u ON u.user_id = uid LEFT JOIN roles r ON r.role_id = u.role_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_price
  AFTER UPDATE ON products FOR EACH ROW EXECUTE FUNCTION audit_price_change();

-- Views used by the dashboard / monitoring pages.
CREATE VIEW v_inventory AS
SELECT p.product_id, p.sku, p.name, p.department, c.name AS category, p.grade, p.form, p.unit,
       p.unit_cost, p.selling_price, p.on_hand, p.reorder_level, p.location, p.is_archived,
       CASE WHEN p.on_hand <= p.reorder_level THEN 'low'
            WHEN p.on_hand <= p.reorder_level * 1.2 THEN 'watch'
            ELSE 'ok' END AS stock_status,
       (SELECT s.name FROM product_suppliers ps JOIN suppliers s USING (supplier_id)
         WHERE ps.product_id = p.product_id AND ps.is_primary LIMIT 1) AS primary_source
  FROM products p LEFT JOIN categories c USING (category_id);

CREATE VIEW v_stock_value AS
SELECT department, SUM(on_hand * unit_cost) AS stock_value, COUNT(*) AS items
  FROM products WHERE NOT is_archived GROUP BY department;

COMMIT;
