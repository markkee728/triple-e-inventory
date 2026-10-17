-- 017: Sample catalogue that matches the company — aluminum die-cast and forged brass products — with the bill of materials.
-- Use on a fresh / presentation database after 001, 004, 006, 008, 014, 016 (skip 002, which holds generic steel sample data).
-- Safe to run again (existing SKUs are left alone). ALL costs, prices, stock levels and quantities-per-piece below are
-- SAMPLE VALUES for the demo: replace them with the Finance/Admin Officer's real figures from the Excel files.
BEGIN;

INSERT INTO categories (name) VALUES
  ('Aluminum Alloy'), ('Brass / Copper Alloy'), ('Plating & Chemicals'), ('Polishing & Abrasives'), ('Casting Consumables'), ('Packaging'),
  ('Aluminum Die-Cast Products'), ('Forged Brass Products')
ON CONFLICT (name) DO NOTHING;

-- Raw materials -----------------------------------------------------------------------------------------------
INSERT INTO products (sku, name, department, category_id, grade, form, unit, unit_cost, selling_price, on_hand, reorder_level, location) VALUES
 ('RM-AL-ADC12',  'Aluminum Alloy Ingot ADC12',         'Raw Materials', (SELECT category_id FROM categories WHERE name='Aluminum Alloy'),      'ADC12',  'Ingot',  'kg', 185.00, 0, 6000, 2000, 'RM-A / Rack 01'),
 ('RM-AL-A380',   'Aluminum Alloy Ingot A380',          'Raw Materials', (SELECT category_id FROM categories WHERE name='Aluminum Alloy'),      'A380',   'Ingot',  'kg', 192.00, 0, 2500, 1000, 'RM-A / Rack 02'),
 ('RM-BRS-C37700','Brass Forging Rod C37700 Ø25mm',     'Raw Materials', (SELECT category_id FROM categories WHERE name='Brass / Copper Alloy'),'C37700', 'Rod',    'kg', 435.00, 0, 3800, 1500, 'RM-B / Rack 01'),
 ('RM-BRS-C36000','Brass Billet C36000 Ø32mm',          'Raw Materials', (SELECT category_id FROM categories WHERE name='Brass / Copper Alloy'),'C36000', 'Billet', 'kg', 420.00, 0, 5200, 2000, 'RM-B / Rack 02'),
-- Finishing supplies ------------------------------------------------------------------------------------------
 ('FS-NI-SALT',   'Nickel Plating Salt',                'Finishing Supplies', (SELECT category_id FROM categories WHERE name='Plating & Chemicals'),     NULL, NULL, 'kg',  980.00, 0,  120,  40, 'CHEM / Cabinet A'),
 ('FS-CR-ACID',   'Chromic Acid (Chrome Plating)',      'Finishing Supplies', (SELECT category_id FROM categories WHERE name='Plating & Chemicals'),     NULL, NULL, 'kg',  760.00, 0,   60,  20, 'CHEM / Cabinet A'),
 ('FS-PWD-BLK',   'Powder Coat Black (Matte)',          'Finishing Supplies', (SELECT category_id FROM categories WHERE name='Plating & Chemicals'),     NULL, NULL, 'kg',  350.00, 0,  200,  60, 'CHEM / Rack 03'),
 ('FS-POL-CMP',   'Polishing Compound',                 'Finishing Supplies', (SELECT category_id FROM categories WHERE name='Polishing & Abrasives'),   NULL, NULL, 'kg',  280.00, 0,   80,  25, 'FIN / Shelf 02'),
 ('FS-BUFF-WHL',  'Buffing Wheel 8"',                   'Finishing Supplies', (SELECT category_id FROM categories WHERE name='Polishing & Abrasives'),   NULL, NULL, 'pcs', 210.00, 0,   90,  30, 'FIN / Shelf 03'),
 ('FS-DIE-REL',   'Die Release Agent',                  'Finishing Supplies', (SELECT category_id FROM categories WHERE name='Casting Consumables'),     NULL, NULL, 'L',   310.00, 0,  150,  50, 'CAST / Shelf 01'),
 ('FS-BOX-SM',    'Packaging Carton (small)',           'Finishing Supplies', (SELECT category_id FROM categories WHERE name='Packaging'),               NULL, NULL, 'pcs',  14.00, 0, 12000, 3000, 'PACK / Shelf 01')
ON CONFLICT (sku) DO NOTHING;

-- Finished goods ----------------------------------------------------------------------------------------------
INSERT INTO products (sku, name, department, category_id, grade, form, unit, unit_cost, selling_price, on_hand, reorder_level, location) VALUES
 ('FG-DC-MOTOR-HSG',  'Die-Cast Aluminum Motor Housing',      'Finished Goods', (SELECT category_id FROM categories WHERE name='Aluminum Die-Cast Products'), 'ADC12',  'Die-cast', 'pcs', 0, 520.00, 400, 120, 'FG-1 / Pallet 01'),
 ('FG-DC-PUMP-CVR',   'Die-Cast Aluminum Pump Cover',         'Finished Goods', (SELECT category_id FROM categories WHERE name='Aluminum Die-Cast Products'), 'A380',   'Die-cast', 'pcs', 0, 380.00, 650, 200, 'FG-1 / Pallet 02'),
 ('FG-DC-HEATSINK',   'Die-Cast Aluminum Heat Sink 100mm',    'Finished Goods', (SELECT category_id FROM categories WHERE name='Aluminum Die-Cast Products'), 'ADC12',  'Die-cast', 'pcs', 0, 295.00, 900, 300, 'FG-1 / Pallet 03'),
 ('FG-BF-ELBOW-34',   'Brass Forged Elbow 3/4"',              'Finished Goods', (SELECT category_id FROM categories WHERE name='Forged Brass Products'),      'C37700', 'Forged',   'pcs', 0, 165.00, 800, 250, 'FG-2 / Pallet 01'),
 ('FG-BF-COUPLING-12','Brass Forged Coupling 1/2"',           'Finished Goods', (SELECT category_id FROM categories WHERE name='Forged Brass Products'),      'C37700', 'Forged',   'pcs', 0,  95.00, 1500, 400, 'FG-2 / Pallet 02'),
 ('FG-BF-BALLVLV-34', 'Brass Forged Ball Valve Body 3/4"',    'Finished Goods', (SELECT category_id FROM categories WHERE name='Forged Brass Products'),      'C36000', 'Forged',   'pcs', 0, 340.00, 500, 150, 'FG-2 / Pallet 03')
ON CONFLICT (sku) DO NOTHING;

-- Bill of materials: quantity of each material needed to make ONE finished piece (sample figures; include casting/forging allowance) --
INSERT INTO product_materials (finished_product_id, material_product_id, qty_per_unit, unit)
SELECT f.product_id, m.product_id, v.q, m.unit
  FROM (VALUES
    ('FG-DC-MOTOR-HSG',   'RM-AL-ADC12',   1.2500),
    ('FG-DC-MOTOR-HSG',   'FS-DIE-REL',    0.0040),
    ('FG-DC-MOTOR-HSG',   'FS-PWD-BLK',    0.0300),
    ('FG-DC-MOTOR-HSG',   'FS-BOX-SM',     1.0000),
    ('FG-DC-PUMP-CVR',    'RM-AL-A380',    0.8500),
    ('FG-DC-PUMP-CVR',    'FS-DIE-REL',    0.0030),
    ('FG-DC-PUMP-CVR',    'FS-POL-CMP',    0.0020),
    ('FG-DC-PUMP-CVR',    'FS-BOX-SM',     1.0000),
    ('FG-DC-HEATSINK',    'RM-AL-ADC12',   0.4500),
    ('FG-DC-HEATSINK',    'FS-DIE-REL',    0.0020),
    ('FG-DC-HEATSINK',    'FS-PWD-BLK',    0.0150),
    ('FG-DC-HEATSINK',    'FS-BOX-SM',     1.0000),
    ('FG-BF-ELBOW-34',    'RM-BRS-C37700', 0.2200),
    ('FG-BF-ELBOW-34',    'FS-POL-CMP',    0.0030),
    ('FG-BF-ELBOW-34',    'FS-BUFF-WHL',   0.0050),
    ('FG-BF-ELBOW-34',    'FS-NI-SALT',    0.0008),
    ('FG-BF-ELBOW-34',    'FS-BOX-SM',     1.0000),
    ('FG-BF-COUPLING-12', 'RM-BRS-C37700', 0.1200),
    ('FG-BF-COUPLING-12', 'FS-POL-CMP',    0.0020),
    ('FG-BF-COUPLING-12', 'FS-NI-SALT',    0.0005),
    ('FG-BF-COUPLING-12', 'FS-BOX-SM',     1.0000),
    ('FG-BF-BALLVLV-34',  'RM-BRS-C36000', 0.4200),
    ('FG-BF-BALLVLV-34',  'FS-POL-CMP',    0.0040),
    ('FG-BF-BALLVLV-34',  'FS-BUFF-WHL',   0.0080),
    ('FG-BF-BALLVLV-34',  'FS-CR-ACID',    0.0010),
    ('FG-BF-BALLVLV-34',  'FS-BOX-SM',     1.0000)
  ) v(fg, mat, q)
  JOIN products f ON f.sku = v.fg
  JOIN products m ON m.sku = v.mat
ON CONFLICT (finished_product_id, material_product_id) DO NOTHING;

-- A finished good's cost follows from its recipe: set unit_cost = material cost (Finance can still adjust it later).
UPDATE products p SET unit_cost = c.material_cost
  FROM v_bom_cost c
 WHERE c.product_id = p.product_id AND p.unit_cost = 0 AND c.material_lines > 0;

COMMIT;
