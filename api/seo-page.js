'use strict';

const { Pool } = require('pg');
let pool;
const ORIGIN='https://market.ethandigitalacademy.org';

function getPool(){
  if(pool)return pool;
  if(!process.env.DATABASE_URL)throw new Error('Marketplace database is unavailable.');
  const parsed=new URL(process.env.DATABASE_URL);
  parsed.searchParams.delete('channel_binding');parsed.searchParams.delete('sslmode');
  pool=new Pool({connectionString:parsed.toString(),ssl:{rejectUnauthorized:true},max:2,idleTimeoutMillis:10000,connectionTimeoutMillis:6000,application_name:'ethan-market-seo'});
  return pool;
}
function h(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function clean(value,max=1000){return String(value??'').replace(/\s+/g,' ').trim().slice(0,max);}
function schemaScript(value){return JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');}
function page({title,description,canonical,image,body,structuredData,ogType='website',robots='index,follow,max-image-preview:large'}){
  const json=structuredData?'<script type="application/ld+json">'+schemaScript(structuredData)+'</script>':'';
  return `<!doctype html>
<html lang="en-NG">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#122b4a">
<title>${h(title)}</title>
<meta name="description" content="${h(description)}">
<meta name="robots" content="${h(robots)}">
<link rel="canonical" href="${h(canonical)}">
<meta property="og:type" content="${h(ogType)}">
<meta property="og:site_name" content="ETHAN MARKET">
<meta property="og:title" content="${h(title)}">
<meta property="og:description" content="${h(description)}">
<meta property="og:url" content="${h(canonical)}">
${image?`<meta property="og:image" content="${h(image)}"><meta name="twitter:card" content="summary_large_image">`:'<meta name="twitter:card" content="summary">'}
<meta name="twitter:title" content="${h(title)}"><meta name="twitter:description" content="${h(description)}">
<link rel="icon" href="/assets/favicon.png" type="image/png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@500;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f8fb;color:#1a2c40;font:15px 'DM Sans',Arial,sans-serif}.top{height:72px;background:#fff;border-bottom:1px solid #e5eaf0;display:flex;align-items:center;justify-content:space-between;padding:0 clamp(18px,5vw,70px)}.top img{width:155px;height:auto}.top a,.crumb a{color:#17395c;text-decoration:none;font-weight:700}.wrap{max-width:1120px;margin:0 auto;padding:28px 20px 56px}.crumb{font-size:12px;color:#7d8b99;margin:0 0 22px}.crumb a{margin-right:6px}.card{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,.9fr);gap:40px;background:#fff;border:1px solid #e6ebf1;border-radius:18px;padding:clamp(18px,4vw,40px);box-shadow:0 16px 45px rgba(20,42,68,.06)}.photo{width:100%;max-height:480px;object-fit:contain;background:#f5f7fa;border-radius:13px;aspect-ratio:1/1}.eyebrow{font-size:10px;letter-spacing:.15em;font-weight:800;color:#a47c37;text-transform:uppercase}h1{font:800 clamp(28px,4vw,42px) 'Manrope',Arial,sans-serif;line-height:1.12;letter-spacing:-.04em;color:#122b4a;margin:12px 0}.meta{color:#748395;font-size:13px;line-height:1.7}.price{font:800 30px 'Manrope';color:#17395c;margin:20px 0}.description{white-space:pre-line;line-height:1.8;color:#45576a;margin:18px 0}.primary{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 22px;background:#122b4a;color:#fff;border:0;border-radius:9px;font-weight:800;text-decoration:none;cursor:pointer}.primary:disabled{opacity:.45;cursor:not-allowed}.secondary{display:inline-flex;align-items:center;justify-content:center;min-height:45px;padding:0 18px;border:1px solid #dce3eb;border-radius:9px;color:#193b60;text-decoration:none;font-weight:700;margin-left:8px}.badge{display:inline-block;background:#f2f6fb;color:#405a73;padding:6px 10px;border-radius:50px;font-size:11px;font-weight:700}.seller{border-top:1px solid #e7ebf0;margin-top:24px;padding-top:20px}.seller a{font-weight:800;color:#17395c;text-decoration:none}.section{margin-top:38px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(205px,1fr));gap:16px}.item{display:block;background:#fff;padding:14px;border:1px solid #e6ebf1;border-radius:13px;text-decoration:none;color:#17334f}.item img{width:100%;height:155px;object-fit:contain;background:#f5f7fa;border-radius:8px}.item strong{display:block;margin:10px 0 5px}.item span{color:#65778a;font-size:12px}.trust{margin-top:25px;background:#f1f5f9;border-radius:12px;padding:15px;color:#617184;font-size:12px;line-height:1.7}.foot{text-align:center;color:#8a97a5;font-size:11px;margin-top:32px}@media(max-width:760px){.card{grid-template-columns:1fr;gap:22px}.photo{max-height:360px}.top{height:64px}.top img{width:130px}}
</style>
${json}
</head>
<body>
<header class="top"><a href="/" aria-label="ETHAN MARKET home"><img src="/assets/ethan-market-logo.png" alt="ETHAN MARKET"></a><a href="/#shop">Shop the marketplace →</a></header>
<main class="wrap">${body}<p class="foot">© ${new Date().getFullYear()} ETHAN MARKET · Powered by Ethan Digital Academy · <a href="/buyer-protection" style="color:inherit">Buyer protection</a></p></main>
</body></html>`;
}
function send(res,status,html){
  res.statusCode=status;res.setHeader('Content-Type','text/html; charset=utf-8');
  res.setHeader('Cache-Control',status===200?'public, max-age=300, s-maxage=900, stale-while-revalidate=3600':'no-store');
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.end(html);
}
module.exports=async function handler(req,res){
  if(req.method!=='GET'){res.statusCode=405;res.setHeader('Allow','GET');return res.end('Method not allowed');}
  try{
    const url=new URL(req.url||'/',ORIGIN);const type=url.searchParams.get('type');
    if(type==='product'){
      const id=url.searchParams.get('id')||'';
      if(!/^[0-9a-f-]{36}$/i.test(id))return send(res,404,page({title:'Product not found | ETHAN MARKET',description:'This product is not available.',canonical:ORIGIN+'/',robots:'noindex,nofollow'}));
      const {rows}=await getPool().query(`
        SELECT p.id,p.name,p.slug,p.description,p.product_type,p.price_kobo,p.image_url,p.stock_qty,p.updated_at,
          c.name AS category_name,s.store_name,s.slug AS store_slug,s.city,s.state,
          COALESCE(rv.avg_rating,0) AS rating,COALESCE(rv.review_count,0) AS review_count
        FROM market_products p JOIN market_sellers s ON s.id=p.seller_id
        LEFT JOIN market_categories c ON c.id=p.category_id
        LEFT JOIN (SELECT product_id,round(avg(rating)::numeric,1) AS avg_rating,count(*) AS review_count FROM market_reviews GROUP BY product_id) rv ON rv.product_id=p.id
        WHERE p.id=$1 AND p.status='active' AND s.seller_status='approved' LIMIT 1`,[id]);
      if(!rows.length)return send(res,404,page({title:'Product not found | ETHAN MARKET',description:'This product is not available.',canonical:ORIGIN+'/',robots:'noindex,nofollow'}));
      const p=rows[0];const canonical=ORIGIN+'/product/'+encodeURIComponent(p.slug)+'/'+p.id;
      const description=clean(p.description,280)||('Shop '+p.name+' from '+p.store_name+' on ETHAN MARKET Nigeria.');
      const image=/^https:\/\//i.test(p.image_url||'')?p.image_url:'';
      const available=p.product_type==='digital'||Number(p.stock_qty)>0;
      const productSchema={
        '@context':'https://schema.org','@type':'Product',name:p.name,description:clean(p.description,5000),
        image:image?[image]:undefined,category:p.category_name||undefined,
        brand:{'@type':'Brand',name:p.store_name},
        offers:{'@type':'Offer',url:canonical,priceCurrency:'NGN',price:(Number(p.price_kobo)/100).toFixed(2),
          availability:available?'https://schema.org/InStock':'https://schema.org/OutOfStock',
          seller:{'@type':'Organization',name:p.store_name,url:ORIGIN+'/store/'+encodeURIComponent(p.store_slug)}},
        aggregateRating:Number(p.review_count)>0?{'@type':'AggregateRating',ratingValue:Number(p.rating),reviewCount:Number(p.review_count)}:undefined
      };
      const body=`<p class="crumb"><a href="/">Home</a> / <a href="/#shop">Shop</a> / ${h(p.category_name||'Product')}</p>
      <article class="card"><div>${image?`<img class="photo" src="${h(image)}" alt="${h(p.name)}" loading="eager">`:'<div class="photo" role="img" aria-label="Product image coming soon"></div>'}</div>
      <div><span class="eyebrow">${h(p.category_name||'ETHAN MARKET FIND')}</span><h1>${h(p.name)}</h1>
      <p class="meta">Sold by <a href="/store/${encodeURIComponent(p.store_slug)}">${h(p.store_name)}</a> · ${h([p.city,p.state].filter(Boolean).join(', ')||'Nigeria')}</p>
      <div class="price">₦${(Number(p.price_kobo)/100).toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
      <span class="badge">${p.product_type==='digital'?'Digital product':Number(p.stock_qty)>0?'In stock':'Out of stock'}</span>
      <p class="description">${h(p.description||'Contact the seller through ETHAN MARKET for more product information.')}</p>
      <button class="primary" type="button" data-add-product="${p.id}" data-stock="${Math.max(0,Number(p.stock_qty)||0)}" data-type="${h(p.product_type)}" ${!available?'disabled':''}>${available?'Add to bag':'Currently out of stock'}</button>
      <a class="secondary" href="/#shop">Continue shopping</a>
      <div class="seller"><div class="eyebrow">Seller storefront</div><p><a href="/store/${encodeURIComponent(p.store_slug)}">${h(p.store_name)} →</a></p></div>
      <div class="trust">Shop through ETHAN MARKET checkout. Keep your order details, delivery tracking and support correspondence for your records.</div>
      </div></article><script src="/assets/seo-product.js?v=20261120-seo1" defer></script>`;
      return send(res,200,page({title:p.name+' | '+p.store_name+' | ETHAN MARKET Nigeria',description,canonical,image,body,structuredData:productSchema,ogType:'product'}));
    }
    if(type==='store'){
      const slug=clean(url.searchParams.get('slug'),100);
      if(!slug)return send(res,404,page({title:'Store not found | ETHAN MARKET',description:'This store is not available.',canonical:ORIGIN+'/',robots:'noindex,nofollow'}));
      const {rows}=await getPool().query(`
        SELECT s.id,s.store_name,s.slug,s.description,s.city,s.state,s.phone,s.created_at
        FROM market_sellers s WHERE s.slug=$1 AND s.seller_status='approved' LIMIT 1`,[slug]);
      if(!rows.length)return send(res,404,page({title:'Store not found | ETHAN MARKET',description:'This store is not available.',canonical:ORIGIN+'/'}));
      const store=rows[0];
      const products=(await getPool().query(`
        SELECT p.id,p.name,p.slug,p.price_kobo,p.image_url,p.product_type,p.stock_qty,p.updated_at
        FROM market_products p WHERE p.seller_id=$1 AND p.status='active'
        ORDER BY p.featured DESC,p.created_at DESC LIMIT 60`,[store.id])).rows;
      const canonical=ORIGIN+'/store/'+encodeURIComponent(store.slug);
      const description=clean(store.description,280)||('Discover products from '+store.store_name+' on ETHAN MARKET Nigeria.');
      const jsonld={'@context':'https://schema.org','@type':'OnlineStore',name:store.store_name,url:canonical,
        description:clean(store.description,2000),areaServed:{'@type':'Country',name:'Nigeria'},
        address:{'@type':'PostalAddress',addressLocality:store.city||undefined,addressRegion:store.state||undefined,addressCountry:'NG'}};
      const body=`<p class="crumb"><a href="/">Home</a> / <a href="/#shop">Shop</a> / Store</p>
      <section class="card"><div><span class="eyebrow">APPROVED ETHAN MARKET SELLER</span><h1>${h(store.store_name)}</h1><p class="meta">${h([store.city,store.state].filter(Boolean).join(', ')||'Nigeria')}</p><p class="description">${h(store.description||'Explore products from this independent seller on ETHAN MARKET.')}</p><span class="badge">${products.length} published product${products.length===1?'':'s'}</span></div><div class="trust"><strong>Shop with confidence</strong><br>Products published by this storefront have passed ETHAN MARKET listing review. Use the marketplace order history and support process for order questions.</div></section>
      <section class="section"><h2>Products from ${h(store.store_name)}</h2><div class="grid">${products.map(p=>`<a class="item" href="/product/${encodeURIComponent(p.slug)}/${p.id}">${/^https:\/\//i.test(p.image_url||'')?`<img src="${h(p.image_url)}" alt="${h(p.name)}" loading="lazy">`:'<div class="photo" aria-hidden="true"></div>'}<strong>${h(p.name)}</strong><span>₦${(Number(p.price_kobo)/100).toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2})}</span></a>`).join('')||'<p>No published products are available yet.</p>'}</div></section>`;
      return send(res,200,page({title:store.store_name+' Store | ETHAN MARKET Nigeria',description,canonical,body,structuredData:jsonld}));
    }
    return send(res,404,page({title:'Page not found | ETHAN MARKET',description:'The requested marketplace page was not found.',canonical:ORIGIN+'/'}));
  }catch(error){
    console.error('ETHAN MARKET SEO page error:',error.message);
    return send(res,503,page({title:'Marketplace temporarily unavailable | ETHAN MARKET',description:'Please return to ETHAN MARKET shortly.',canonical:ORIGIN+'/'}));
  }
};
