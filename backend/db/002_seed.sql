-- Seed data generated from the mock arrays in script.js
BEGIN;
INSERT INTO roles (role_key,label) VALUES ('finance','Finance-Admin Officer'),('cashier','Sales Staff / Cashier'),('customer','Customer');
INSERT INTO categories (name) VALUES ('Carbon Steel'),('Stainless Steel'),('Aluminium'),('Copper Alloy');
INSERT INTO suppliers (code,name,status,location,contact,supplies) VALUES
('andes-copper','Andes Copper Coop','active','Warehouse C','Marisol Tan · +63 917 220 3391','Brass Billet C36000, Copper Tube'),
('northline-metals','Northline Metals Ltd.','active','Warehouse B','R. Guevarra · +63 918 445 2210','Zinc Alloy Zamak-3, Aluminium ADC-12'),
('rhein-stahl','Rhein Stahl GmbH','active','Mill Yard A','orders@rheinstahl.de','Hot Rolled Coil, Structural Plate'),
('kanto-alloy','Kanto Alloy Works','active','Warehouse B','H. Suzuki · +81 3 5555 0192','Stainless Sheet 2.0mm'),
('gulf-billet','Gulf Billet Trading','active','Mill Yard A','A. Al-Farsi · +971 4 220 8890','Billet 150mm Square'),
('metro-chem','Metro Chem Supplies','archived','Storeroom','F. Villanueva · +63 927 110 4482','Nickel Plating Salt');
INSERT INTO products (sku,name,department,category_id,grade,form,unit,unit_cost,selling_price,on_hand,reorder_level,location) VALUES
('CS-HRC-3.0-1250','Hot Rolled Coil 3.0mm × 1250','Raw Materials',(SELECT category_id FROM categories WHERE name='Carbon Steel'),'S275JR','Coil','kg',0.72,0.94,394000,300000,NULL),
('SS-316L-SHT-2.0','Stainless Sheet 2.0mm 2B','Raw Materials',(SELECT category_id FROM categories WHERE name='Stainless Steel'),'316L','Sheet','kg',3.85,4.98,53200,60000,NULL),
('AL-6061-BAR-40','Aluminium Round Bar 040','Raw Materials',(SELECT category_id FROM categories WHERE name='Aluminium'),'6061-T6','Bar','kg',2.41,3.24,115500,80000,NULL),
('CS-BIL-150SQ','Billet 150mm Square','Raw Materials',(SELECT category_id FROM categories WHERE name='Carbon Steel'),'C45','Billet','kg',0.68,0.86,32000,40000,NULL),
('CU-C11000-TUB-25','Copper Tube Ø25 × 1.5','Raw Materials',(SELECT category_id FROM categories WHERE name='Copper Alloy'),'C11000','Tube','kg',8.62,11.4,10550,12000,NULL),
('CS-PLT-12-2000','Structural Plate 12mm × 2000','Raw Materials',(SELECT category_id FROM categories WHERE name='Carbon Steel'),'S355J2','Plate','kg',0.79,1.02,563500,500000,NULL),
('SS-304-COIL-1.5','Stainless Coil 1.5mm','Raw Materials',(SELECT category_id FROM categories WHERE name='Stainless Steel'),'304','Coil','kg',3.12,4.05,62700,70000,NULL),
('AL-5052-SHT-3.0','Aluminium Sheet 3.0mm','Raw Materials',(SELECT category_id FROM categories WHERE name='Aluminium'),'5052-H32','Sheet','kg',2.68,3.61,2200,5000,NULL),
('BF-ELB-034','Brass Forged Elbow 3/4"','Finished Goods',NULL,NULL,NULL,'pcs',5.2,0,380,600,'FG-1 / Pallet 07'),
('DC-BRK-207','Die-Cast Mounting Bracket 207','Work In Progress',NULL,NULL,NULL,'pcs',7.35,0,640,900,'WIP-1 / Bin 18'),
('MC-FLNG-160','Machined Flange 160mm','Finished Goods',NULL,NULL,NULL,'pcs',24.75,0,220,400,'FG-2 / Pallet 02'),
('FS-NIPL-SALT','Nickel Plating Salt','Finishing Supplies',NULL,NULL,NULL,'kg',41,0,96,120,'CHEM / Cabinet A'),
('RM-ZAM-3','Zinc Alloy Zamak-3 Ingot','Raw Materials',NULL,NULL,NULL,'kg',3.15,0,1180,1500,'RM-A / Rack 04'),
('RM-BRS-C360','Brass Billet C36000 · 25mm','Raw Materials',NULL,NULL,NULL,'kg',6.42,0,8420,3000,'RM-A / Rack 01');
INSERT INTO product_suppliers (product_id,supplier_id,is_primary) SELECT * FROM (VALUES ((SELECT product_id FROM products WHERE sku='CS-HRC-3.0-1250'),(SELECT supplier_id FROM suppliers WHERE name='Rhein Stahl GmbH'),TRUE),((SELECT product_id FROM products WHERE sku='SS-316L-SHT-2.0'),(SELECT supplier_id FROM suppliers WHERE name='Kanto Alloy Works'),TRUE),((SELECT product_id FROM products WHERE sku='AL-6061-BAR-40'),(SELECT supplier_id FROM suppliers WHERE name='Northline Metals Ltd.'),TRUE),((SELECT product_id FROM products WHERE sku='CS-BIL-150SQ'),(SELECT supplier_id FROM suppliers WHERE name='Gulf Billet Trading'),TRUE),((SELECT product_id FROM products WHERE sku='CU-C11000-TUB-25'),(SELECT supplier_id FROM suppliers WHERE name='Andes Copper Coop'),TRUE),((SELECT product_id FROM products WHERE sku='CS-PLT-12-2000'),(SELECT supplier_id FROM suppliers WHERE name='Rhein Stahl GmbH'),TRUE),((SELECT product_id FROM products WHERE sku='SS-304-COIL-1.5'),(SELECT supplier_id FROM suppliers WHERE name='Kanto Alloy Works'),TRUE),((SELECT product_id FROM products WHERE sku='AL-5052-SHT-3.0'),(SELECT supplier_id FROM suppliers WHERE name='Northline Metals Ltd.'),TRUE)) v(a,b,c) WHERE b IS NOT NULL;
COMMIT;
