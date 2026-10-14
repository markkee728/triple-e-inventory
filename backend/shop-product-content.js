// Mount after auth() and wrap() are declared, before app.listen().
// Product photos are either HTTPS URLs typed in by Finance, or files uploaded from the product form.
// Uploaded files are stored in the database (table shop_image_files) and served from /api/shop/images/:id,
// so they survive restarts and redeploys (Cloud Run's own disk is not permanent).
const express = require('express');
module.exports = function mountShopProductContent({app,pool,auth,wrap}) {
 // Self-healing schema: creates the online-shop columns/table if 004_shop_product_content.sql was never run
 // on this database (safe to run on every start). Without them the online catalog cannot save or read details.
 const ready=(async()=>{
  try{
   await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS shop_description TEXT NOT NULL DEFAULT ''");
   await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS shop_specs JSONB NOT NULL DEFAULT '{}'::jsonb");
   await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS shop_visible BOOLEAN NOT NULL DEFAULT TRUE');
   await pool.query(`CREATE TABLE IF NOT EXISTS shop_product_images (
    image_id BIGSERIAL PRIMARY KEY,
    product_id INT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    alt_text TEXT NOT NULL DEFAULT '',
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT shop_image_url_length CHECK (char_length(image_url) BETWEEN 10 AND 2048))`);
   await pool.query(`CREATE TABLE IF NOT EXISTS shop_image_files (
    file_id BIGSERIAL PRIMARY KEY,
    mime TEXT NOT NULL,
    data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
   await pool.query('CREATE INDEX IF NOT EXISTS shop_product_images_product_idx ON shop_product_images(product_id,sort_order,image_id)');
   console.log('[shop] online product details schema ready');
  }catch(err){console.warn('[shop] could not prepare the online product details schema:',err.message);}
 })();
 const whenReady=(req,res,next)=>{ready.then(()=>next(),next);};
 app.use('/api/shop',whenReady);
 app.use('/api/finance/shop-products',whenReady);
 app.use('/api/finance/shop-images',whenReady);
 const getProduct = async sku => (await pool.query('SELECT product_id,sku,name,department,is_archived,selling_price,on_hand,shop_description,shop_specs,shop_visible FROM products WHERE sku=$1',[sku])).rows[0];
 const normalize = (r,images) => ({sku:r.sku,name:r.name,description:r.shop_description,specs:r.shop_specs,visible:r.shop_visible,images,available:Number(r.on_hand),price:Number(r.selling_price)});
 const imagesFor = async id => (await pool.query('SELECT image_id AS id,image_url AS url,alt_text AS alt,sort_order AS "order" FROM shop_product_images WHERE product_id=$1 ORDER BY sort_order,image_id',[id])).rows;
 const UPLOADED = /^\/api\/shop\/images\/\d{1,12}$/;   // photos uploaded through the product form
 const validUrl = v => {if(UPLOADED.test(v))return true;try {const u=new URL(v);return u.protocol==='https:' && u.username==='' && u.password==='' && v.length<=2048;}catch{return false;}};
 const sniff = b => b.length>12 && ((b[0]===0xFF&&b[1]===0xD8&&b[2]===0xFF)?'image/jpeg'
   : (b[0]===0x89&&b.toString('latin1',1,4)==='PNG')?'image/png'
   : (b.toString('latin1',0,4)==='RIFF'&&b.toString('latin1',8,12)==='WEBP')?'image/webp':null);
 // Upload one photo (raw JPG / PNG / WEBP bytes, max 2 MB). Returns the URL to save with the product.
 app.post('/api/finance/shop-images',auth('finance'),express.raw({type:['image/jpeg','image/png','image/webp'],limit:'2mb'}),wrap(async(req,res)=>{
  const buf=req.body, type=Buffer.isBuffer(buf)&&sniff(buf);
  if(!type)return res.status(400).json({error:'Choose a JPG, PNG or WEBP image (max 2 MB)'});
  const r=await pool.query('INSERT INTO shop_image_files(mime,data) VALUES($1,$2) RETURNING file_id',[type,buf]);
  res.status(201).json({url:'/api/shop/images/'+r.rows[0].file_id});
 }));
 // Public on purpose: product photos are shown on the shop page and are not secret. Ids cannot be listed.
 app.get('/api/shop/images/:id',wrap(async(req,res)=>{
  if(!/^\d{1,12}$/.test(req.params.id))return res.status(404).end();
  const r=await pool.query('SELECT mime,data FROM shop_image_files WHERE file_id=$1',[req.params.id]);
  if(!r.rowCount)return res.status(404).end();
  res.set({'Content-Type':r.rows[0].mime,'Cache-Control':'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'});
  res.send(r.rows[0].data);
 }));
 // Existing customer auth and finance roles are reused. Never expose raw supplier costs.
 app.get('/api/shop/product-content/:sku',auth('customer','finance'),wrap(async(req,res)=>{
  const r=await getProduct(String(req.params.sku).toUpperCase());
  if(!r || (req.user.role==='customer' && (r.is_archived || r.department!=='Finished Goods' || r.selling_price<=0 || !r.shop_visible))) return res.status(404).json({error:'Product not found'});
  res.json(normalize(r,await imagesFor(r.product_id)));
 }));
 app.get('/api/finance/shop-products',auth('finance'),wrap(async(req,res)=>{
  const {rows}=await pool.query(`SELECT sku,name,shop_visible AS visible,shop_description AS description FROM products WHERE department='Finished Goods' AND NOT is_archived ORDER BY name`);
  res.json(rows);
 }));
 app.put('/api/finance/shop-products/:sku',auth('finance'),wrap(async(req,res)=>{
  const sku=String(req.params.sku).toUpperCase(), b=req.body||{};
  if(typeof b.description!=='string'||b.description.length>5000||typeof b.visible!=='boolean'||!b.specs||typeof b.specs!=='object'||Array.isArray(b.specs)) return res.status(400).json({error:'Invalid product content'});
  const specs=Object.entries(b.specs);
  if(specs.length>30||specs.some(([k,v])=>k.length>80||!k.trim()||typeof v!=='string'||v.length>300))return res.status(400).json({error:'Invalid specifications'});
  if(!Array.isArray(b.images)||b.images.length>8||b.images.some((im,i)=>!im||typeof im.url!=='string'||!validUrl(im.url)||typeof im.alt!=='string'||im.alt.length>200))return res.status(400).json({error:'Use up to 8 photos (uploaded files or HTTPS image URLs) and short alt text'});
  const client=await pool.connect();
  try {
   await client.query('BEGIN');
   const r=await client.query(`SELECT product_id FROM products WHERE sku=$1 AND department='Finished Goods' AND NOT is_archived FOR UPDATE`,[sku]);
   if(!r.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Product not found'});}
   const id=r.rows[0].product_id;
   await client.query('UPDATE products SET shop_description=$1,shop_specs=$2::jsonb,shop_visible=$3 WHERE product_id=$4',[b.description.trim(),JSON.stringify(b.specs),b.visible,id]);
   await client.query('DELETE FROM shop_product_images WHERE product_id=$1',[id]);
   for(let i=0;i<b.images.length;i++)await client.query('INSERT INTO shop_product_images(product_id,image_url,alt_text,sort_order) VALUES($1,$2,$3,$4)',[id,b.images[i].url,b.images[i].alt.trim(),i]);
   await client.query('COMMIT');res.json({ok:true});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }));
};
