-- Automatic reorder level. backend/reorder.js creates these on start, so running this by hand is optional.
-- Existing products stay manual (FALSE); new products default to automatic from the product form.
ALTER TABLE products ADD COLUMN IF NOT EXISTS reorder_auto  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS reorder_basis TEXT;   -- the sentence shown under the box, e.g. "Average use 12.5 kg/day ... = 125 kg"
