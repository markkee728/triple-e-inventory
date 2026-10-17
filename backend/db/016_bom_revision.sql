-- 016: Bill of Materials (BOM) revision — "which raw materials and finishing supplies make each finished good".
-- Run AFTER 001 and 008 (product_materials). Safe to run again. Nothing here changes how the app already works;
-- it makes the data rules stricter and adds read-only views for reports and for the presentation.
BEGIN;

-- 1. Rules the database itself now enforces (before, only the server checked them):
--    a finished good is a "Finished Goods" product; a material is a "Raw Materials" or "Finishing Supplies" product;
--    the unit recorded on the BOM line is always the material's own stock unit.
CREATE OR REPLACE FUNCTION check_bom_line() RETURNS trigger AS $$
DECLARE fg_dept TEXT; m_dept TEXT; m_unit TEXT;
BEGIN
  SELECT department INTO fg_dept FROM products WHERE product_id = NEW.finished_product_id;
  SELECT department, unit INTO m_dept, m_unit FROM products WHERE product_id = NEW.material_product_id;
  IF fg_dept IS DISTINCT FROM 'Finished Goods' THEN
    RAISE EXCEPTION 'A bill of materials can only be set on a Finished Goods product (got %)', fg_dept USING ERRCODE = 'check_violation';
  END IF;
  IF m_dept NOT IN ('Raw Materials', 'Finishing Supplies') THEN
    RAISE EXCEPTION 'Only Raw Materials and Finishing Supplies can be used to make a finished good (got %)', m_dept USING ERRCODE = 'check_violation';
  END IF;
  NEW.unit := m_unit;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_bom_line ON product_materials;
CREATE TRIGGER trg_check_bom_line BEFORE INSERT OR UPDATE ON product_materials
  FOR EACH ROW EXECUTE FUNCTION check_bom_line();

-- Fast lookups in both directions: "what makes this product" and "which products use this material".
CREATE INDEX IF NOT EXISTS idx_bom_finished ON product_materials (finished_product_id);
CREATE INDEX IF NOT EXISTS idx_bom_material ON product_materials (material_product_id);

-- 2. Views (read-only reports)

-- 2a. The full recipe of every finished good: one row per material, with its type and current stock.
CREATE OR REPLACE VIEW v_product_bom AS
SELECT fg.sku                         AS finished_sku,
       fg.name                        AS finished_good,
       fg.unit                        AS finished_unit,
       m.sku                          AS material_sku,
       m.name                         AS material,
       CASE m.department WHEN 'Raw Materials' THEN 'Raw material' ELSE 'Finishing supply' END AS material_type,
       pm.qty_per_unit,
       pm.unit                        AS material_unit,
       m.unit_cost                    AS material_unit_cost,
       ROUND(pm.qty_per_unit * m.unit_cost, 4) AS cost_per_finished_unit,
       m.on_hand                      AS material_on_hand
  FROM product_materials pm
  JOIN products fg ON fg.product_id = pm.finished_product_id
  JOIN products m  ON m.product_id  = pm.material_product_id
 WHERE NOT fg.is_archived;

-- 2b. Material cost of ONE finished unit, split into raw materials and finishing supplies, compared with the selling price.
CREATE OR REPLACE VIEW v_bom_cost AS
SELECT fg.product_id, fg.sku, fg.name, fg.unit, fg.selling_price,
       COUNT(pm.requirement_id)::int AS material_lines,
       COALESCE(SUM(pm.qty_per_unit * m.unit_cost) FILTER (WHERE m.department = 'Raw Materials'), 0)::NUMERIC(12,2)      AS raw_material_cost,
       COALESCE(SUM(pm.qty_per_unit * m.unit_cost) FILTER (WHERE m.department = 'Finishing Supplies'), 0)::NUMERIC(12,2) AS finishing_cost,
       COALESCE(SUM(pm.qty_per_unit * m.unit_cost), 0)::NUMERIC(12,2) AS material_cost,
       (fg.selling_price - COALESCE(SUM(pm.qty_per_unit * m.unit_cost), 0))::NUMERIC(12,2) AS gross_margin_before_labour
  FROM products fg
  LEFT JOIN product_materials pm ON pm.finished_product_id = fg.product_id
  LEFT JOIN products m ON m.product_id = pm.material_product_id
 WHERE fg.department = 'Finished Goods' AND NOT fg.is_archived
 GROUP BY fg.product_id;

-- 2c. How many units of each finished good the CURRENT material stock can still produce, and which material runs out first.
CREATE OR REPLACE VIEW v_producible_units AS
SELECT DISTINCT ON (fg.product_id)
       fg.sku, fg.name,
       FLOOR(m.on_hand / pm.qty_per_unit)::BIGINT AS units_producible,
       m.sku  AS limiting_material_sku,
       m.name AS limiting_material
  FROM products fg
  JOIN product_materials pm ON pm.finished_product_id = fg.product_id
  JOIN products m ON m.product_id = pm.material_product_id
 WHERE fg.department = 'Finished Goods' AND NOT fg.is_archived
 ORDER BY fg.product_id, (m.on_hand / pm.qty_per_unit) ASC;

-- 2d. Where-used: which finished goods use each raw material / finishing supply.
CREATE OR REPLACE VIEW v_material_where_used AS
SELECT m.sku AS material_sku, m.name AS material, m.department, m.unit, m.on_hand,
       COUNT(pm.requirement_id)::int AS used_in_products,
       STRING_AGG(fg.name, ', ' ORDER BY fg.name) AS finished_goods
  FROM products m
  LEFT JOIN product_materials pm ON pm.material_product_id = m.product_id
  LEFT JOIN products fg ON fg.product_id = pm.finished_product_id AND NOT fg.is_archived
 WHERE m.department IN ('Raw Materials', 'Finishing Supplies') AND NOT m.is_archived
 GROUP BY m.product_id;

-- 2e. Actual consumption: what each confirmed production run really used (frozen copy kept by the app).
CREATE OR REPLACE VIEW v_production_usage AS
SELECT pr.ref AS production_ref, pr.created_at, pr.product_sku, pr.product_name, pr.quantity AS units_produced,
       pi.material_sku, pi.material_name, pi.department, pi.unit,
       pi.calculated_qty AS planned_qty, pi.actual_qty,
       (pi.actual_qty - pi.calculated_qty) AS variance
  FROM production_records pr JOIN production_items pi USING (production_id);

COMMIT;
