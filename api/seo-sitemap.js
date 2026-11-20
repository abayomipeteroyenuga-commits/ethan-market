'use strict';
const { Pool } = require('pg');
let pool;
const ORIGIN='https://market.ethandigitalacademy.org';
function getPool(){
  if(pool)return pool;
  if(!process.env.DATABASE_URL)throw new Error('Database unavailable.');
  const parsed=new URL(process.env.DATABASE_URL);
  parsed.searchParams.delete('channel_binding');parsed.searchParams.delete('sslmode');
  pool=new Pool({connectionString:parsed.toString(),ssl:{rejectUnauthorized:true},max:2,connectionTimeoutMillis:6000,application_name:'ethan-market-sitemap'});
  return pool;
}
function xml(value){return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');}
module.exports=async function handler(req,res){
  if(req.method!=='GET'){res.statusCode=405;res.setHeader('Allow','GET');return res.end('Method not allowed');}
  try{
    const type=new URL(req.url||'/',ORIGIN).searchParams.get('type');
    let rows=[];
    if(type==='products'){
      rows=(await getPool().query(`SELECT p.id,p.slug,p.updated_at FROM market_products p
        JOIN market_sellers s ON s.id=p.seller_id WHERE p.status='active' AND s.seller_status='approved'
        ORDER BY p.updated_at DESC LIMIT 50000`)).rows;
      rows=rows.map(p=>({loc:ORIGIN+'/product/'+encodeURIComponent(p.slug)+'/'+p.id,lastmod:p.updated_at}));
    }else if(type==='stores'){
      rows=(await getPool().query(`SELECT s.slug,s.updated_at FROM market_sellers s
        WHERE s.seller_status='approved' AND EXISTS(SELECT 1 FROM market_products p WHERE p.seller_id=s.id AND p.status='active')
        ORDER BY s.updated_at DESC LIMIT 50000`)).rows;
      rows=rows.map(s=>({loc:ORIGIN+'/store/'+encodeURIComponent(s.slug),lastmod:s.updated_at}));
    }else{
      res.statusCode=400;return res.end('Unknown sitemap type');
    }
    const urls=rows.map(row=>'<url><loc>'+xml(row.loc)+'</loc>'+(row.lastmod?'<lastmod>'+new Date(row.lastmod).toISOString().slice(0,10)+'</lastmod>':'')+'<changefreq>weekly</changefreq><priority>0.7</priority></url>').join('');
    res.statusCode=200;res.setHeader('Content-Type','application/xml; charset=utf-8');res.setHeader('Cache-Control','public, max-age=1800, s-maxage=3600');
    res.end('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+urls+'</urlset>');
  }catch(error){
    console.error('ETHAN MARKET sitemap error:',error.message);
    res.statusCode=503;res.setHeader('Content-Type','text/plain; charset=utf-8');res.end('Sitemap temporarily unavailable');
  }
};
