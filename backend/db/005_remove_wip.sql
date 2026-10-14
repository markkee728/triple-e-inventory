-- Removes the "Work In Progress" department from an EXISTING database.
-- (Fresh installs don't need this: 001_schema.sql / 002_seed.sql no longer include it.)
-- Run once:  psql "$DATABASE_URL" -f backend/db/005_remove_wip.sql
BEGIN;
DELETE FROM stock_movements WHERE product_id IN (SELECT product_id FROM products WHERE department = 'Work In Progress');
DELETE FROM product_suppliers WHERE product_id IN (SELECT product_id FROM products WHERE department = 'Work In Progress');
DELETE FROM products WHERE department = 'Work In Progress';
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_department_check;
ALTER TABLE products ADD CONSTRAINT products_department_check
  CHECK (department IN ('Raw Materials','Finished Goods','Finishing Supplies'));
COMMIT;
