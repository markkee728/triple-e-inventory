// Mount after auth() and wrap() are declared, before app.listen().
// This module stores image URLs (e.g. Google Cloud Storage HTTPS URLs), not image bytes.
module.exports = function mountShopProductContent({app,pool,auth,wrap}) {
 const getProduct = async sku => (await pool.query('SELECT product_id,sku,name,department,is_archived,selling_price,on_hand,shop_description,shop_specs,shop_visible FROM products WHERE sku=$1',[sku])).rows[0];
 const normalize = (r,images) => ({sku:r.sku,name:r.name,description:r.shop_description,specs:r.shop_specs,visible:r.shop_visible,images,available:Number(r.on_hand),price:Number(r.selling_price)});
 const imagesFor = async id => (await pool.query('SELECT image_id AS id,image_url AS url,alt_text AS alt,sort_order AS "order" FROM shop_product_images WHERE product_id=$1 ORDER BY sort_order,image_id',[id])).rows;
 const validUrl = v => {try {const u=new URL(v);return u.protocol==='https:' && u.username==='' && u.password==='' && v.length<=2048;}catch{return false;}};
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
  if(!Array.isArray(b.images)||b.images.length>8||b.images.some((im,i)=>!im||typeof im.url!=='string'||!validUrl(im.url)||typeof im.alt!=='string'||im.alt.length>200))return res.status(400).json({error:'Use up to 8 HTTPS image URLs and short alt text'});
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
