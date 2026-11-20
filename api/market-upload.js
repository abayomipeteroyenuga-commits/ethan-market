'use strict';

const crypto = require('node:crypto');
const { Pool } = require('pg');
const { put } = require('@vercel/blob');

const COOKIE='ethan_market_session';
let pool;
function dbPool(){
  if(pool)return pool;
  if(!process.env.DATABASE_URL)throw new Error('Marketplace database is not configured.');
  const url=new URL(process.env.DATABASE_URL);url.searchParams.delete('channel_binding');url.searchParams.delete('sslmode');
  pool=new Pool({connectionString:url.toString(),ssl:{rejectUnauthorized:true},max:2,idleTimeoutMillis:10000,application_name:'ethan-market-media'});
  return pool;
}
function send(res,status,body){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.end(JSON.stringify(body));}
function hash(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}
function parseCookies(req){const out={};for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i>0)out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());}return out;}
function safeOrigin(req){
  const origin=req.headers.origin;if(!origin)throw Object.assign(new Error('Request origin is required.'),{status:403});
  let url;try{url=new URL(origin);}catch{throw Object.assign(new Error('Request origin is not allowed.'),{status:403});}
  const host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim().toLowerCase();
  if(url.protocol!=='https:'||url.host.toLowerCase()!==host)throw Object.assign(new Error('Request origin is not allowed.'),{status:403});
}
function safeFilename(name){return String(name||'product-image').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,90)||'product-image';}
function validImage(buffer,type){
  if(type==='image/jpeg')return buffer.length>3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff;
  if(type==='image/png')return buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if(type==='image/webp')return buffer.length>12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP';
  if(type==='image/avif')return buffer.length>12&&buffer.toString('ascii',4,8)==='ftyp'&&['avif','avis'].includes(buffer.toString('ascii',8,12));
  return false;
}
module.exports=async function handler(req,res){
  if(req.method!=='POST')return send(res,405,{error:'Method not allowed.'});
  try{
    safeOrigin(req);
    if(!req.body||typeof req.body!=='object')throw Object.assign(new Error('Upload payload is invalid.'),{status:400});
    const token=parseCookies(req)[COOKIE];
    if(!token||!/^[a-f0-9]{64}$/i.test(token))throw Object.assign(new Error('Sign in before uploading product photos.'),{status:401});
    const {rows}=await dbPool().query(
      `SELECT u.id,u.role,s.id AS seller_id,s.seller_status FROM market_sessions x
       JOIN market_users u ON u.id=x.user_id LEFT JOIN market_sellers s ON s.user_id=u.id
       WHERE x.token_hash=$1 AND x.expires_at>now() AND u.is_active=true LIMIT 1`,[hash(token)]
    );
    if(!rows.length)throw Object.assign(new Error('Your session has ended. Please sign in again.'),{status:401});
    const user=rows[0];
    const isAdmin=['admin','super_admin'].includes(user.role);
    if(!isAdmin&&!(user.role==='seller'&&user.seller_status==='approved'))throw Object.assign(new Error('Only approved sellers and marketplace administrators can upload product photos.'),{status:403});
    const fileName=safeFilename(req.body.file_name);
    const mime=String(req.body.mime_type||'');
    if(!['image/jpeg','image/png','image/webp','image/avif'].includes(mime))throw Object.assign(new Error('Only JPG, PNG, WebP or AVIF images are accepted.'),{status:400});
    const base64=String(req.body.base64||'');
    if(!base64||base64.length>Math.ceil(2.5*1024*1024*4/3)+16)throw Object.assign(new Error('Image is empty or exceeds the 2.5 MB limit.'),{status:413});
    const buffer=Buffer.from(base64,'base64');
    if(buffer.length>2.5*1024*1024||!validImage(buffer,mime))throw Object.assign(new Error('The uploaded file is not a valid supported image or exceeds 2.5 MB.'),{status:400});
    if(!process.env.BLOB_READ_WRITE_TOKEN)throw Object.assign(new Error('Product image storage is not configured.'),{status:503});
    const path=`products/${user.id}/${crypto.randomUUID()}-${fileName}`;
    const blob=await put(path,buffer,{access:'public',contentType:mime,addRandomSuffix:true,token:process.env.BLOB_READ_WRITE_TOKEN,cacheControlMaxAge:31536000});
    return send(res,200,{data:{url:blob.url,pathname:blob.pathname,size:buffer.length,contentType:mime}});
  }catch(error){
    const status=Number(error.status)||500;
    if(status>=500)console.error('ETHAN MARKET image upload failed:',error.message);
    return send(res,status,{error:status>=500?'The image could not be uploaded right now.':error.message});
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '4mb' } } };
