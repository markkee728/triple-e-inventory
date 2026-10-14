-- Run once against the SAME Cloud SQL database used by Cloud Run. Safe to rerun.
ALTER TABLE products ADD COLUMN IF NOT EXISTS shop_description TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS shop_specs JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shop_visible BOOLEAN NOT NULL DEFAULT TRUE;
CREATE TABLE IF NOT EXISTS shop_product_images (
 image_id BIGSERIAL PRIMARY KEY,
 product_id INT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
 image_url TEXT NOT NULL,
 alt_text TEXT NOT NULL DEFAULT '',
 sort_order INT NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT shop_image_url_length CHECK (char_length(image_url) BETWEEN 10 AND 2048)
);
CREATE INDEX IF NOT EXISTS shop_product_images_product_idx ON shop_product_images(product_id,sort_order,image_id);
