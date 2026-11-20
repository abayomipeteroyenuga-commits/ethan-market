'use strict';

const crypto = require('node:crypto');
const { Pool } = require('pg');

// One-time bootstrap code is checked by its SHA-256 digest, never stored in plaintext.
const OWNER_SETUP_HASH = Buffer.from([
  0x7f, 0x11, 0x07, 0x74, 0x7f, 0xdc, 0x49, 0xf4,
  0xec, 0x16, 0x1e, 0x83, 0xc3, 0xf1, 0xbd, 0x89,
  0x32, 0x86, 0x29, 0x30, 0x72, 0x7f, 0xcc, 0x56,
  0x97, 0x98, 0xb1, 0x14, 0x50, 0x00, 0x2a, 0x00
]).toString('hex');

const COOKIE = 'ethan_market_session';
const SESSION_DAYS = 30;

function fieldKey() {
  const raw=String(process.env.MARKET_FIELD_ENCRYPTION_KEY||'');
  if(!/^[a-f0-9]{64}$/i.test(raw)) return null;
  return Buffer.from(raw,'hex');
}
function encryptField(value) {
  const text=String(value||''); if(!text) return '';
  if(text.startsWith('enc:v1:')) return text;
  const key=fieldKey(); if(!key) throw new HttpError(503,'Sensitive payout fields are not configured for encryption.');
  const iv=crypto.randomBytes(12); const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const encrypted=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
  return 'enc:v1:'+iv.toString('hex')+':'+cipher.getAuthTag().toString('hex')+':'+encrypted.toString('hex');
}
function decryptField(value) {
  const text=String(value||''); if(!text) return '';
  if(!text.startsWith('enc:v1:')) return text;
  const key=fieldKey(); if(!key) return '••••';
  const parts=text.split(':'); if(parts.length!==5) return '••••';
  try { const iv=Buffer.from(parts[2],'hex'); const tag=Buffer.from(parts[3],'hex'); const data=Buffer.from(parts[4],'hex'); const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8'); } catch { return '••••'; }
}
const MAX_BODY = 256 * 1024;
let pool;
let schemaPromise;

function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) throw new HttpError(503, 'Marketplace database is not configured.');
  const parsed = new URL(process.env.DATABASE_URL);
  parsed.searchParams.delete('channel_binding'); parsed.searchParams.delete('sslmode');
  pool = new Pool({
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: true },
    max: 4,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    application_name: 'ethan-market'
  });
  return pool;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const schema = [
  `CREATE TABLE IF NOT EXISTS market_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text NOT NULL, email text NOT NULL,
    phone text, password_hash text NOT NULL, role text NOT NULL DEFAULT 'buyer'
      CHECK (role IN ('buyer','seller','admin','super_admin')),
    is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS market_users_email_uq ON market_users (lower(email))`,
  `CREATE TABLE IF NOT EXISTS market_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES market_users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS market_sessions_user_idx ON market_sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS market_categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE, slug text NOT NULL UNIQUE,
    icon text NOT NULL DEFAULT '▦', sort_order int NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true
  )`,
  `CREATE TABLE IF NOT EXISTS market_sellers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE REFERENCES market_users(id) ON DELETE CASCADE,
    store_name text NOT NULL, slug text NOT NULL UNIQUE, description text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '',
    whatsapp text NOT NULL DEFAULT '', business_type text NOT NULL DEFAULT 'individual', city text NOT NULL DEFAULT '',
    state text NOT NULL DEFAULT '', seller_status text NOT NULL DEFAULT 'pending' CHECK (seller_status IN ('pending','approved','rejected','suspended')),
    bank_name text NOT NULL DEFAULT '', bank_code text NOT NULL DEFAULT '', account_number text NOT NULL DEFAULT '',
    account_name text NOT NULL DEFAULT '', commission_bps int NOT NULL DEFAULT 1000 CHECK (commission_bps BETWEEN 0 AND 5000),
    paystack_subaccount_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS market_products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid NOT NULL REFERENCES market_sellers(id),
    category_id uuid REFERENCES market_categories(id), name text NOT NULL, slug text NOT NULL,
    description text NOT NULL DEFAULT '', product_type text NOT NULL DEFAULT 'physical' CHECK (product_type IN ('physical','digital')),
    price_kobo bigint NOT NULL CHECK (price_kobo >= 100), compare_at_kobo bigint CHECK (compare_at_kobo IS NULL OR compare_at_kobo >= price_kobo),
    image_url text NOT NULL DEFAULT '', sku text NOT NULL DEFAULT '', stock_qty int NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
    digital_delivery_url text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'pending' CHECK (status IN ('draft','pending','active','rejected','archived')),
    featured boolean NOT NULL DEFAULT false, views int NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(seller_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS market_products_public_idx ON market_products(status, category_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS market_products_seller_idx ON market_products(seller_id, status)`,
  `CREATE TABLE IF NOT EXISTS market_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_number text NOT NULL UNIQUE,
    buyer_id uuid NOT NULL REFERENCES market_users(id), buyer_email text NOT NULL,
    recipient_name text NOT NULL, phone text NOT NULL, subtotal_kobo bigint NOT NULL, shipping_kobo bigint NOT NULL DEFAULT 0,
    total_kobo bigint NOT NULL, currency text NOT NULL DEFAULT 'NGN', payment_status text NOT NULL DEFAULT 'pending'
      CHECK (payment_status IN ('pending','paid','failed','refunded','reversed')),
    status text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment','processing','partially_dispatched','dispatched','delivered','cancelled','refunded')),
    paystack_reference text UNIQUE, shipping_address jsonb NOT NULL DEFAULT '{}'::jsonb, buyer_note text NOT NULL DEFAULT '',
    payment_verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS market_orders_buyer_idx ON market_orders(buyer_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS market_orders_status_idx ON market_orders(status, payment_status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS market_order_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES market_orders(id) ON DELETE CASCADE,
    product_id uuid REFERENCES market_products(id), seller_id uuid NOT NULL REFERENCES market_sellers(id),
    product_name text NOT NULL, product_type text NOT NULL CHECK (product_type IN ('physical','digital')),
    quantity int NOT NULL CHECK (quantity > 0), unit_price_kobo bigint NOT NULL, commission_kobo bigint NOT NULL DEFAULT 0,
    seller_net_kobo bigint NOT NULL DEFAULT 0, fulfillment_status text NOT NULL DEFAULT 'unfulfilled'
      CHECK (fulfillment_status IN ('unfulfilled','processing','dispatched','delivered','cancelled')),
    tracking_number text NOT NULL DEFAULT '', tracking_carrier text NOT NULL DEFAULT '', digital_delivery_url text NOT NULL DEFAULT '',
    stock_deducted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS market_order_items_seller_idx ON market_order_items(seller_id, fulfillment_status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS market_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES market_orders(id),
    provider text NOT NULL DEFAULT 'paystack', reference text NOT NULL UNIQUE, amount_kobo bigint NOT NULL,
    currency text NOT NULL DEFAULT 'NGN', status text NOT NULL DEFAULT 'pending', gateway_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS market_payouts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_item_id uuid NOT NULL UNIQUE REFERENCES market_order_items(id),
    order_id uuid NOT NULL REFERENCES market_orders(id), seller_id uuid NOT NULL REFERENCES market_sellers(id),
    gross_kobo bigint NOT NULL, commission_kobo bigint NOT NULL, net_kobo bigint NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','held','reversed')),
    payout_reference text NOT NULL DEFAULT '', paid_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS market_payouts_status_idx ON market_payouts(status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS market_wishlists (
    user_id uuid NOT NULL REFERENCES market_users(id) ON DELETE CASCADE,
    product_id uuid NOT NULL REFERENCES market_products(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id, product_id)
  )`,
  `CREATE TABLE IF NOT EXISTS market_reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES market_products(id) ON DELETE CASCADE,
    order_id uuid NOT NULL REFERENCES market_orders(id), buyer_id uuid NOT NULL REFERENCES market_users(id),
    rating int NOT NULL CHECK (rating BETWEEN 1 AND 5), review_text text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(product_id, order_id, buyer_id)
  )`,
  `CREATE TABLE IF NOT EXISTS market_settings (
    key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS market_audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid REFERENCES market_users(id),
    action text NOT NULL, entity_type text NOT NULL DEFAULT '', entity_id text NOT NULL DEFAULT '',
    details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS market_rate_limits (
    key text NOT NULL, action text NOT NULL, window_start timestamptz NOT NULL DEFAULT now(),
    attempts int NOT NULL DEFAULT 1, PRIMARY KEY(key, action)
  )`,
  `INSERT INTO market_categories(name,slug,icon,sort_order) VALUES
    ('Electronics','electronics','⌁',1),('Fashion','fashion','◈',2),('Home & Living','home-living','⌂',3),
    ('Beauty & Wellness','beauty-wellness','✦',4),('Food & Groceries','food-groceries','◉',5),
    ('Digital Products','digital-products','▣',6),('Books & Learning','books-learning','▤',7),
    ('Business & Office','business-office','▧',8),('Sports & Outdoors','sports-outdoors','◎',9)
    ON CONFLICT(slug) DO NOTHING`,
  `INSERT INTO market_settings(key,value) VALUES
    ('commission_bps','1000'::jsonb),('physical_shipping_kobo','200000'::jsonb),('marketplace_name','"ETHAN MARKET"'::jsonb),
    ('support_email','"ethandigitalacademy@gmail.com"'::jsonb),('seller_payout_hold_days','7'::jsonb)
    ON CONFLICT(key) DO NOTHING`
];

async function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const db = getPool();
    // Normal production requests should not replay all DDL on every cold start.
    // Check the complete marketplace table set first; only bootstrap when needed.
    const requiredTables = [
      'market_users','market_sessions','market_categories','market_sellers',
      'market_products','market_orders','market_order_items','market_payments',
      'market_payouts','market_wishlists','market_reviews','market_settings',
      'market_audit_logs','market_rate_limits'
    ];
    const countTables = async (executor) => {
      const result = await executor.query(
        "SELECT COUNT(*)::int AS count FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1::text[])",
        [requiredTables]
      );
      return Number(result.rows[0]?.count || 0);
    };
    if (await countTables(db) === requiredTables.length) return;

    // Serialize only a genuine schema bootstrap. Re-check after obtaining the
    // lock in case another cold-start instance completed it while we waited.
    const client = await db.connect();
    const lockKey = 781204501;
    let locked = false;
    try {
      await client.query('SELECT pg_advisory_lock($1)', [lockKey]);
      locked = true;
      if (await countTables(client) !== requiredTables.length) {
        for (const sql of schema) await client.query(sql);
      }
    } finally {
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock($1)', [lockKey]); } catch {}
      }
      client.release();
    }
  })().catch(err => { schemaPromise = null; throw err; });
  return schemaPromise;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, maxAge) {
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

function safeOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) throw new HttpError(403, 'A same-origin browser request is required.');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  let parsed;
  try { parsed = new URL(origin); } catch { throw new HttpError(403, 'Request origin is not allowed.'); }
  if (parsed.host.toLowerCase() !== host || !['https:'].includes(parsed.protocol)) {
    throw new HttpError(403, 'Request origin is not allowed.');
  }
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY) { reject(new HttpError(413, 'Request is too large.')); req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new HttpError(400, 'Request body must be valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.end(JSON.stringify(data));
}

function cleanEmail(v) { return String(v || '').trim().toLowerCase().slice(0, 254); }
function text(v, max = 5000) { return String(v ?? '').trim().slice(0, max); }
function money(v) { const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : 0; }
function slugify(v) { return text(v, 100).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || crypto.randomBytes(4).toString('hex'); }
function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}

async function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const derived = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (e, key) => e ? reject(e) : resolve(key)));
  return `scrypt$131072$8$1$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function passwordVerify(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  if (!/^\d+$/.test(N) || !/^\d+$/.test(r) || !/^\d+$/.test(p) || !/^[a-f0-9]{32}$/i.test(saltHex) || !/^[a-f0-9]{128}$/i.test(hashHex)) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const got = await new Promise((resolve, reject) => crypto.scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024 }, (e, key) => e ? reject(e) : resolve(key)));
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

async function rateLimit(db, action, identity, max, minutes = 15) {
  const key = sha256(identity).slice(0, 48);
  const { rows } = await db.query(
    `INSERT INTO market_rate_limits(key,action,window_start,attempts) VALUES($1,$2,now(),1)
     ON CONFLICT(key,action) DO UPDATE SET
       attempts = CASE WHEN market_rate_limits.window_start < now() - ($3::text || ' minutes')::interval THEN 1 ELSE market_rate_limits.attempts + 1 END,
       window_start = CASE WHEN market_rate_limits.window_start < now() - ($3::text || ' minutes')::interval THEN now() ELSE market_rate_limits.window_start END
     RETURNING attempts`, [key, action, minutes]
  );
  if (Number(rows[0]?.attempts || 0) > max) throw new HttpError(429, 'Too many attempts. Please try again later.');
}

async function audit(db, userId, action, entityType = '', entityId = '', details = {}) {
  await db.query('INSERT INTO market_audit_logs(actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)', [userId || null, action, entityType, String(entityId || ''), JSON.stringify(details)]);
}

async function currentUser(req, db, required = false) {
  const token = parseCookies(req)[COOKIE];
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    if (required) throw new HttpError(401, 'Please sign in to continue.');
    return null;
  }
  const { rows } = await db.query(
    `SELECT u.id,u.full_name,u.email,u.phone,u.role,s.id AS session_id
     FROM market_sessions s JOIN market_users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.expires_at>now() AND u.is_active=true LIMIT 1`, [sha256(token)]
  );
  if (!rows.length) {
    if (required) throw new HttpError(401, 'Your session has ended. Please sign in again.');
    return null;
  }
  db.query('UPDATE market_sessions SET last_seen_at=now() WHERE id=$1', [rows[0].session_id]).catch(() => {});
  return rows[0];
}

async function requireRole(req, db, roles) {
  const user = await currentUser(req, db, true);
  if (!roles.includes(user.role)) throw new HttpError(403, 'You are not authorised to perform this action.');
  return user;
}

async function createSession(db, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = SESSION_DAYS * 24 * 60 * 60;
  await db.query('INSERT INTO market_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+($3::text||\' seconds\')::interval)', [userId, sha256(token), expires]);
  setCookie(res, COOKIE, token, expires);
}

async function authRegister(db, req, res, body) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  await rateLimit(db, 'register', ip, 8, 60);
  const fullName = text(body.full_name, 120);
  const email = cleanEmail(body.email);
  const phone = text(body.phone, 40);
  const password = String(body.password || '');
  const ownerToken = String(body.owner_token || '');
  if (fullName.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter your full name and a valid email address.');
  if (password.length < 10 || Buffer.byteLength(password, 'utf8') > 128) throw new HttpError(400, 'Use a password of at least 10 characters.');
  let role = 'buyer';
  const configuredOwner = cleanEmail(process.env.MARKET_SUPER_ADMIN_EMAIL);
  if (email === configuredOwner) {
    const setting = await db.query("SELECT value FROM market_settings WHERE key='owner_bootstrap_used'");
    const used = setting.rows[0]?.value === true;
    const codeMatches = safeEqual(sha256(ownerToken), OWNER_SETUP_HASH);
    if (used || !codeMatches) {
      throw new HttpError(403, 'The owner setup code is invalid or has already been used. Request a fresh owner activation code.');
    }
    role = 'super_admin';
  }
  const hash = await passwordHash(password);
  const client = await db.connect();
  let user;
  try {
    await client.query('BEGIN');
    const created = await client.query(
      'INSERT INTO market_users(full_name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING id,full_name,email,phone,role',
      [fullName,email,phone,hash,role]
    );
    user = created.rows[0];
    if (role === 'super_admin') {
      await client.query("INSERT INTO market_settings(key,value) VALUES('owner_bootstrap_used','true'::jsonb) ON CONFLICT(key) DO UPDATE SET value='true'::jsonb,updated_at=now()");
      await client.query("DELETE FROM market_settings WHERE key='owner_bootstrap_token_hash'");
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); if (e.code === '23505') throw new HttpError(409, 'An account with this email already exists.'); throw e; }
  finally { client.release(); }
  await createSession(db, res, user.id);
  await audit(db, user.id, 'ACCOUNT_REGISTERED', 'user', user.id, { role });
  return { user: publicUser(user) };
}

async function authLogin(db, req, res, body) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const email = cleanEmail(body.email);
  await rateLimit(db, 'login', ip + '|' + email, 8, 15);
  const { rows } = await db.query('SELECT id,full_name,email,phone,password_hash,role,is_active FROM market_users WHERE lower(email)=$1 LIMIT 1', [email]);
  const user = rows[0];
  if (!user || !user.is_active || !(await passwordVerify(String(body.password || ''), user.password_hash))) throw new HttpError(401, 'Email or password is incorrect.');
  await createSession(db, res, user.id);
  await audit(db, user.id, 'ACCOUNT_LOGIN', 'user', user.id);
  return { user: publicUser(user) };
}

function publicUser(user) {
  return { id: user.id, full_name: user.full_name, email: user.email, phone: user.phone || '', role: user.role };
}

async function authMe(db, req) {
  const user = await currentUser(req, db, false);
  if (!user) return { user: null };
  const { rows } = await db.query('SELECT id,store_name,slug,description,seller_status,commission_bps,city,state FROM market_sellers WHERE user_id=$1', [user.id]);
  return { user: publicUser(user), seller: rows[0] || null };
}

async function signOut(db, req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) await db.query('DELETE FROM market_sessions WHERE token_hash=$1', [sha256(token)]);
  clearCookie(res);
  return { ok: true };
}

async function getSettings(db) {
  const { rows } = await db.query('SELECT key,value FROM market_settings');
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

async function publicCategories(db) {
  const { rows } = await db.query('SELECT id,name,slug,icon FROM market_categories WHERE is_active=true ORDER BY sort_order,name');
  return rows;
}

async function listProducts(db, params = {}) {
  const values = [];
  const where = [`p.status='active'`, `s.seller_status='approved'`];
  if (params.category) { values.push(text(params.category,80)); where.push(`c.slug=$${values.length}`); }
  if (params.type && ['physical','digital'].includes(params.type)) { values.push(params.type); where.push(`p.product_type=$${values.length}`); }
  if (params.q) { values.push('%' + text(params.q,100).replace(/[%_]/g,'\\$&') + '%'); where.push(`(p.name ILIKE $${values.length} OR p.description ILIKE $${values.length} OR s.store_name ILIKE $${values.length})`); }
  if (params.featured === 'true') where.push('p.featured=true');
  let order = 'p.featured DESC,p.created_at DESC';
  if (params.sort === 'price-asc') order = 'p.price_kobo ASC,p.created_at DESC';
  if (params.sort === 'price-desc') order = 'p.price_kobo DESC,p.created_at DESC';
  if (params.sort === 'popular') order = 'p.views DESC,p.created_at DESC';
  const limit = Math.min(Math.max(Number(params.limit) || 24, 1), 60);
  values.push(limit);
  const { rows } = await db.query(
    `SELECT p.id,p.name,p.slug,p.description,p.product_type,p.price_kobo,p.compare_at_kobo,p.image_url,p.stock_qty,p.featured,p.created_at,
       c.name AS category_name,c.slug AS category_slug,s.id AS seller_id,s.store_name,s.slug AS store_slug,s.city,s.state,
       COALESCE(rv.avg_rating,0) AS rating,COALESCE(rv.review_count,0) AS review_count
     FROM market_products p JOIN market_sellers s ON s.id=p.seller_id LEFT JOIN market_categories c ON c.id=p.category_id
     LEFT JOIN (SELECT product_id,round(avg(rating)::numeric,1) AS avg_rating,count(*) AS review_count FROM market_reviews GROUP BY product_id) rv ON rv.product_id=p.id
     WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${values.length}`,
    values
  );
  return rows;
}

async function productDetail(db, idOrSlug) {
  const { rows } = await db.query(
    `SELECT p.id,p.name,p.slug,p.description,p.product_type,p.price_kobo,p.compare_at_kobo,p.image_url,p.stock_qty,p.featured,p.created_at,
      c.name AS category_name,c.slug AS category_slug,s.id AS seller_id,s.store_name,s.slug AS store_slug,s.description AS store_description,s.city,s.state,
      COALESCE(rv.avg_rating,0) AS rating,COALESCE(rv.review_count,0) AS review_count
     FROM market_products p JOIN market_sellers s ON s.id=p.seller_id LEFT JOIN market_categories c ON c.id=p.category_id
     LEFT JOIN (SELECT product_id,round(avg(rating)::numeric,1) AS avg_rating,count(*) AS review_count FROM market_reviews GROUP BY product_id) rv ON rv.product_id=p.id
     WHERE p.status='active' AND s.seller_status='approved' AND (p.id::text=$1 OR p.slug=$1) LIMIT 1`, [text(idOrSlug,120)]
  );
  if (!rows.length) throw new HttpError(404, 'Product not found.');
  await db.query('UPDATE market_products SET views=views+1 WHERE id=$1', [rows[0].id]);
  return rows[0];
}

async function getSellerByUser(db, userId, mustApproved = true) {
  const { rows } = await db.query('SELECT * FROM market_sellers WHERE user_id=$1 LIMIT 1', [userId]);
  if (!rows.length) throw new HttpError(403, 'Apply to become a seller before using the seller dashboard.');
  if (mustApproved && rows[0].seller_status !== 'approved') throw new HttpError(403, 'Your seller account is awaiting marketplace approval.');
  return rows[0];
}

async function applySeller(db, req, body) {
  const user = await requireRole(req, db, ['buyer','seller','admin','super_admin']);
  const storeName = text(body.store_name,120);
  const slug = slugify(body.slug || storeName);
  if (storeName.length < 2) throw new HttpError(400, 'Enter a store name.');
  const existing = await db.query('SELECT id FROM market_sellers WHERE user_id=$1', [user.id]);
  if (existing.rows.length) throw new HttpError(409, 'A seller application already exists for this account.');
  try {
    const settings = await getSettings(db);
    const defaultCommission = Math.min(Math.max(Number(settings.commission_bps ?? 1000), 0), 5000);
    const { rows } = await db.query(
      `INSERT INTO market_sellers(user_id,store_name,slug,description,phone,whatsapp,business_type,city,state,bank_name,bank_code,account_number,account_name,commission_bps)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id,store_name,slug,seller_status`,
      [user.id,storeName,slug,text(body.description,1500),text(body.phone,40),text(body.whatsapp,40),['individual','registered_business'].includes(body.business_type)?body.business_type:'individual',text(body.city,80),text(body.state,80),text(body.bank_name,120),encryptField(body.bank_code),encryptField(body.account_number),text(body.account_name,120),defaultCommission]
    );
    await audit(db,user.id,'SELLER_APPLICATION_SUBMITTED','seller',rows[0].id);
    return { seller: rows[0] };
  } catch(e) { if(e.code==='23505') throw new HttpError(409,'That store address is already in use.'); throw e; }
}

async function sellerDashboard(db, req) {
  const user = await requireRole(req, db, ['seller','admin','super_admin']);
  const seller = await getSellerByUser(db,user.id,true);
  const [products, orders, payouts] = await Promise.all([
    db.query(`SELECT p.id,p.name,p.price_kobo,p.compare_at_kobo,p.stock_qty,p.status,p.product_type,p.created_at,p.description,p.image_url,p.sku,p.digital_delivery_url,c.name AS category_name,c.id AS category_id FROM market_products p LEFT JOIN market_categories c ON c.id=p.category_id WHERE p.seller_id=$1 ORDER BY p.created_at DESC LIMIT 100`,[seller.id]),
    db.query(`SELECT oi.id,oi.product_name,oi.quantity,oi.unit_price_kobo,oi.fulfillment_status,oi.tracking_number,oi.tracking_carrier,o.order_number,o.status,o.payment_status,o.created_at,o.recipient_name,o.phone,o.shipping_address
      FROM market_order_items oi JOIN market_orders o ON o.id=oi.order_id WHERE oi.seller_id=$1 AND o.payment_status='paid' ORDER BY o.created_at DESC LIMIT 100`,[seller.id]),
    db.query('SELECT id,gross_kobo,commission_kobo,net_kobo,status,payout_reference,created_at,paid_at FROM market_payouts WHERE seller_id=$1 ORDER BY created_at DESC LIMIT 100',[seller.id])
  ]);
  const totals = await db.query(`SELECT COALESCE(sum(net_kobo),0) AS net_total,COALESCE(sum(net_kobo) FILTER(WHERE status IN ('pending','approved','held')),0) AS outstanding,COALESCE(sum(net_kobo) FILTER(WHERE status='paid'),0) AS paid FROM market_payouts WHERE seller_id=$1`,[seller.id]);
  return { seller: sellerPublic(seller), products: products.rows, orders: orders.rows, payouts: payouts.rows, totals: totals.rows[0] };
}

function sellerPublic(s) {
  return { id:s.id,store_name:s.store_name,slug:s.slug,description:s.description,phone:s.phone,whatsapp:s.whatsapp,business_type:s.business_type,city:s.city,state:s.state,seller_status:s.seller_status,bank_name:s.bank_name,bank_code:decryptField(s.bank_code),account_number:decryptField(s.account_number),account_name:s.account_name,commission_bps:s.commission_bps };
}

async function saveSellerProfile(db, req, body) {
  const user = await requireRole(req, db, ['seller','admin','super_admin']);
  const seller = await getSellerByUser(db,user.id,false);
  const { rows } = await db.query(
    `UPDATE market_sellers SET description=$2,phone=$3,whatsapp=$4,city=$5,state=$6,bank_name=$7,bank_code=$8,
      account_number=$9,account_name=$10,updated_at=now() WHERE id=$1 RETURNING *`,
    [seller.id,text(body.description,1500),text(body.phone,40),text(body.whatsapp,40),text(body.city,80),text(body.state,80),text(body.bank_name,120),encryptField(body.bank_code),encryptField(body.account_number),text(body.account_name,120)]
  );
  await audit(db,user.id,'SELLER_PROFILE_UPDATED','seller',seller.id);
  return { seller: sellerPublic(rows[0]) };
}

async function saveProduct(db, req, body) {
  const user = await requireRole(req, db, ['seller','admin','super_admin']);
  const seller = await getSellerByUser(db,user.id,true);
  const name = text(body.name,180);
  const description = text(body.description,5000);
  const price = money(body.price_kobo);
  const type = body.product_type === 'digital' ? 'digital' : 'physical';
  const stock = type === 'digital' ? 999999 : Math.min(Math.max(parseInt(body.stock_qty,10)||0,0),100000);
  const imageUrl = text(body.image_url,1000);
  if (name.length < 3 || description.length < 10 || price < 100) throw new HttpError(400,'Add a product name, a useful description and a price of at least ₦1.');
  if (body.compare_at_kobo && money(body.compare_at_kobo) < price) throw new HttpError(400,'The previous price must be higher than the selling price.');
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) throw new HttpError(400,'Product image must use a secure HTTPS image URL.');
  if (type === 'digital' && body.digital_delivery_url && !/^https:\/\//i.test(String(body.digital_delivery_url))) throw new HttpError(400,'Digital delivery links must use HTTPS.');
  if (type === 'physical' && stock < 1) throw new HttpError(400,'A physical product needs at least one item in stock.');
  const category = await db.query('SELECT id FROM market_categories WHERE id::text=$1 OR slug=$1 LIMIT 1',[text(body.category_id,100)]);
  if (!category.rows.length) throw new HttpError(400,'Choose a valid product category.');
  const productId = text(body.id,80);
  if (productId) {
    const { rows } = await db.query(
      `UPDATE market_products SET category_id=$3,name=$4,description=$5,product_type=$6,price_kobo=$7,
        compare_at_kobo=$8,image_url=$9,sku=$10,stock_qty=$11,digital_delivery_url=$12,status='pending',featured=false,updated_at=now()
       WHERE id=$1 AND seller_id=$2 RETURNING id,name,status,price_kobo,product_type,stock_qty`,
      [productId,seller.id,category.rows[0].id,name,description,type,price,body.compare_at_kobo?money(body.compare_at_kobo):null,imageUrl,text(body.sku,80),stock,type==='digital'?text(body.digital_delivery_url,1500):'']
    );
    if (!rows.length) throw new HttpError(404,'Product was not found in your store.');
    await audit(db,user.id,'PRODUCT_UPDATED','product',productId);
    return { product: rows[0] };
  }
  const slug = slugify(name) + '-' + crypto.randomBytes(2).toString('hex');
  const { rows } = await db.query(
    `INSERT INTO market_products(seller_id,category_id,name,slug,description,product_type,price_kobo,compare_at_kobo,image_url,sku,stock_qty,digital_delivery_url,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending') RETURNING id,name,status,price_kobo,product_type,stock_qty`,
    [seller.id,category.rows[0].id,name,slug,description,type,price,body.compare_at_kobo?money(body.compare_at_kobo):null,imageUrl,text(body.sku,80),stock,type==='digital'?text(body.digital_delivery_url,1500):'']
  );
  await audit(db,user.id,'PRODUCT_SUBMITTED','product',rows[0].id);
  return { product: rows[0] };
}

async function checkout(db, req, body) {
  if (!process.env.PAYSTACK_SECRET_KEY) throw new HttpError(503,'Secure checkout is being connected. Marketplace browsing and seller registration are available, but payment is not enabled yet.');
  const user = await requireRole(req, db, ['buyer','seller','admin','super_admin']);
  await rateLimit(db, 'checkout', user.id, 10, 60);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 30) throw new HttpError(400,'Your cart is empty or contains too many products.');
  const quantities = new Map();
  for (const item of items) {
    const id = text(item.product_id,80); const q = Math.min(Math.max(parseInt(item.quantity,10)||0,0),20);
    if (!/^[0-9a-f-]{36}$/i.test(id) || q < 1) throw new HttpError(400,'Your cart contains an invalid item.');
    quantities.set(id,(quantities.get(id)||0)+q);
    if (quantities.get(id) > 20) throw new HttpError(400,'A product quantity cannot exceed 20 per checkout.');
  }
  const dbClient = await db.connect();
  let order;
  try {
    await dbClient.query('BEGIN');
    await dbClient.query("UPDATE market_orders SET payment_status='failed',status='cancelled',updated_at=now() WHERE payment_status='pending' AND created_at < now()-interval '30 minutes'");
    const ids = [...quantities.keys()];
    const { rows: products } = await dbClient.query(
      `SELECT p.*,s.id AS approved_seller_id,s.commission_bps,s.store_name FROM market_products p
       JOIN market_sellers s ON s.id=p.seller_id WHERE p.id=ANY($1::uuid[]) AND p.status='active' AND s.seller_status='approved' FOR UPDATE OF p`, [ids]
    );
    if (products.length !== ids.length) throw new HttpError(409,'One or more products are no longer available. Refresh your cart.');
    let subtotal = 0; let physical = false;
    const orderId = crypto.randomUUID();
    const orderNumber = 'EM-' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const ref = 'EM' + Date.now().toString() + crypto.randomBytes(5).toString('hex').toUpperCase();
    const itemSnapshots=[];
    for (const p of products) {
      const quantity = quantities.get(p.id);
      if (p.product_type === 'physical') {
        const reserved = await dbClient.query(
          `SELECT COALESCE(sum(oi.quantity),0)::int AS quantity FROM market_order_items oi
           JOIN market_orders o ON o.id=oi.order_id
           WHERE oi.product_id=$1 AND oi.product_type='physical' AND o.payment_status='pending'
             AND o.created_at >= now()-interval '30 minutes'`, [p.id]
        );
        const available = Number(p.stock_qty) - Number(reserved.rows[0]?.quantity || 0);
        if (available < quantity) throw new HttpError(409,`${p.name} has only ${Math.max(available,0)} item(s) currently available.`);
      }
      subtotal += Number(p.price_kobo) * quantity;
      if (p.product_type === 'physical') physical = true;
      const commission = Math.round(Number(p.price_kobo) * quantity * Number(p.commission_bps) / 10000);
      itemSnapshots.push({p,quantity,commission,net:Number(p.price_kobo)*quantity-commission});
    }
    if (!Number.isSafeInteger(subtotal) || subtotal < 100) throw new HttpError(400,'The cart total is invalid.');
    const settings = await getSettings(dbClient);
    const shipping = physical ? money(settings.physical_shipping_kobo ?? 200000) : 0;
    const total = subtotal + shipping;
    const recipient = text(body.recipient_name || user.full_name,120);
    const phone = text(body.phone || user.phone,40);
    const address = {
      line1:text(body.address_line1,180),line2:text(body.address_line2,180),city:text(body.city,80),
      state:text(body.state,80),postal_code:text(body.postal_code,30),country:'Nigeria'
    };
    if (physical && (!recipient || !phone || !address.line1 || !address.city || !address.state)) throw new HttpError(400,'Complete the delivery name, phone, street, city and state for physical items.');
    await dbClient.query(
      `INSERT INTO market_orders(id,order_number,buyer_id,buyer_email,recipient_name,phone,subtotal_kobo,shipping_kobo,total_kobo,paystack_reference,shipping_address,buyer_note)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [orderId,orderNumber,user.id,user.email,recipient,phone,subtotal,shipping,total,ref,JSON.stringify(address),text(body.buyer_note,1000)]
    );
    for (const it of itemSnapshots) {
      await dbClient.query(
        `INSERT INTO market_order_items(order_id,product_id,seller_id,product_name,product_type,quantity,unit_price_kobo,commission_kobo,seller_net_kobo,digital_delivery_url,fulfillment_status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [orderId,it.p.id,it.p.seller_id,it.p.name,it.p.product_type,it.quantity,it.p.price_kobo,it.commission,it.net,it.p.product_type==='digital'?text(it.p.digital_delivery_url,1500):'',it.p.product_type==='digital'?'delivered':'unfulfilled']
      );
    }
    await dbClient.query('INSERT INTO market_payments(order_id,reference,amount_kobo) VALUES($1,$2,$3)',[orderId,ref,total]);
    await dbClient.query('COMMIT');
    order={id:orderId,order_number:orderNumber,reference:ref,total_kobo:total,email:user.email};
  } catch(e) { await dbClient.query('ROLLBACK'); throw e; }
  finally { dbClient.release(); }

  const callback = (process.env.MARKET_PUBLIC_URL || 'https://market.ethandigitalacademy.org').replace(/\/$/,'') + '/?payment=verify';
  try {
    const gateway = await paystack('/transaction/initialize', {
      method:'POST',
      body:{email:order.email,amount:String(order.total_kobo),currency:'NGN',reference:order.reference,callback_url:callback,
        metadata:{order_id:order.id,order_number:order.order_number,app:'ETHAN MARKET'},channels:['card','bank','bank_transfer','ussd']}
    });
    if (!gateway?.data?.authorization_url) throw new HttpError(502,'Paystack did not return a checkout link.');
    return { authorization_url:gateway.data.authorization_url,reference:order.reference,order_number:order.order_number,total_kobo:order.total_kobo };
  } catch (error) {
    await db.query("UPDATE market_orders SET payment_status='failed',status='cancelled',updated_at=now() WHERE id=$1 AND payment_status='pending'",[order.id]);
    await db.query("UPDATE market_payments SET status='failed' WHERE reference=$1 AND status='pending'",[order.reference]);
    throw error;
  }
}

async function paystack(path, options={}) {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new HttpError(503,'Paystack is not configured yet.');
  let response;
  try {
    response = await fetch('https://api.paystack.co' + path, {
      method:options.method||'GET',
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',Accept:'application/json'},
      body:options.body?JSON.stringify(options.body):undefined,
      signal:AbortSignal.timeout(15000)
    });
  } catch { throw new HttpError(502,'Payment provider is temporarily unavailable.'); }
  const payload = await response.json().catch(()=>({}));
  if (!response.ok || !payload.status) throw new HttpError(502,payload.message || 'Payment provider could not complete the request.');
  return payload;
}

async function finalizePaid(db, transaction) {
  if (!transaction || transaction.status !== 'success' || !transaction.reference) throw new HttpError(400,'This transaction has not been confirmed as successful.');
  const client = await db.connect();
  let orderInfo;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM market_orders WHERE paystack_reference=$1 FOR UPDATE',[String(transaction.reference)]);
    if (!rows.length) throw new HttpError(404,'No ETHAN MARKET order matches this payment reference.');
    const order = rows[0];
    if (Number(transaction.amount) !== Number(order.total_kobo) || String(transaction.currency).toUpperCase() !== 'NGN') throw new HttpError(400,'The payment amount or currency does not match this order.');
    if (order.payment_status !== 'paid') {
      await client.query("UPDATE market_orders SET payment_status='paid',status=CASE WHEN NOT EXISTS(SELECT 1 FROM market_order_items WHERE order_id=$1 AND product_type='physical') THEN 'delivered' ELSE 'processing' END,payment_verified_at=now(),updated_at=now() WHERE id=$1",[order.id]);
      await client.query("UPDATE market_payments SET status='success',gateway_payload=$2::jsonb,verified_at=now() WHERE reference=$1",[String(transaction.reference),JSON.stringify(transaction)]);
      const { rows:changed } = await client.query('UPDATE market_order_items SET stock_deducted=true WHERE order_id=$1 AND product_type=\'physical\' AND stock_deducted=false RETURNING product_id,quantity',[order.id]);
      for (const row of changed) if (row.product_id) await client.query('UPDATE market_products SET stock_qty=GREATEST(stock_qty-$2,0),updated_at=now() WHERE id=$1',[row.product_id,row.quantity]);
      await client.query(
        `INSERT INTO market_payouts(order_item_id,order_id,seller_id,gross_kobo,commission_kobo,net_kobo)
         SELECT id,order_id,seller_id,unit_price_kobo*quantity,commission_kobo,seller_net_kobo FROM market_order_items WHERE order_id=$1
         ON CONFLICT(order_item_id) DO NOTHING`,[order.id]
      );
    }
    orderInfo={id:order.id,order_number:order.order_number,total_kobo:Number(order.total_kobo),payment_status:'paid'};
    await client.query('COMMIT');
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  return orderInfo;
}

async function verifyPayment(db, req, body) {
  const user = await currentUser(req,db,true);
  const reference = text(body.reference,120);
  if (!reference) throw new HttpError(400,'Payment reference is required.');
  const { rows } = await db.query('SELECT id,buyer_id FROM market_orders WHERE paystack_reference=$1',[reference]);
  if (!rows.length) throw new HttpError(404,'Order not found.');
  if (rows[0].buyer_id !== user.id && !['admin','super_admin'].includes(user.role)) throw new HttpError(403,'This order does not belong to your account.');
  const verified = await paystack('/transaction/verify/'+encodeURIComponent(reference));
  const order = await finalizePaid(db,verified.data);
  return { order };
}

function verifyWebhookSignature(req, rawBody) {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return false;
  const sig = String(req.headers['paystack-signature'] || req.headers['x-paystack-signature'] || '');
  if (!sig) return false;
  if (sig.startsWith('t=')) {
    const parts=sig.split(','); const t=parts.find(x=>x.startsWith('t='))?.slice(2);
    const variants=parts.filter(x=>x.startsWith('v1=')).map(x=>x.slice(3).split(':').slice(1).join(':')).filter(Boolean);
    if (!t || !/^\d+$/.test(t) || Math.abs(Date.now()/1000-Number(t))>300) return false;
    const expected=crypto.createHmac('sha512',secret).update(t+'.').update(rawBody).digest('hex');
    return variants.some(v=>safeEqual(v,expected));
  }
  const expected=crypto.createHmac('sha512',secret).update(rawBody).digest('hex');
  return safeEqual(sig,expected);
}

async function readRaw(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  return new Promise((resolve,reject)=>{
    const chunks=[];let size=0;
    req.on('data',chunk=>{size+=chunk.length;if(size>MAX_BODY){reject(new HttpError(413,'Webhook payload is too large.'));req.destroy();return;}chunks.push(chunk);});
    req.on('end',()=>resolve(Buffer.concat(chunks)));
    req.on('error',reject);
  });
}

async function webhook(req,res,db) {
  const raw = await readRaw(req);
  if (!verifyWebhookSignature(req,raw)) return send(res,401,{error:'Invalid payment webhook signature.'});
  let event;
  try { event=JSON.parse(raw.toString('utf8')); } catch { return send(res,400,{error:'Invalid webhook payload.'}); }
  if (event.event === 'charge.success' && event.data?.reference) {
    try {
      const verification=await paystack('/transaction/verify/'+encodeURIComponent(event.data.reference));
      await finalizePaid(db,verification.data);
    } catch (e) {
      console.error('ETHAN MARKET webhook processing failed:',e.message);
      return send(res,500,{error:'Webhook could not be processed. Paystack may retry.'});
    }
  }
  return send(res,200,{received:true});
}

async function buyerOrders(db,req) {
  const user=await currentUser(req,db,true);
  const {rows}=await db.query(
    `SELECT o.id,o.order_number,o.subtotal_kobo,o.shipping_kobo,o.total_kobo,o.payment_status,o.status,o.created_at,
      json_agg(json_build_object('id',oi.id,'product_id',oi.product_id,'product_name',oi.product_name,'product_type',oi.product_type,'quantity',oi.quantity,
       'unit_price_kobo',oi.unit_price_kobo,'fulfillment_status',oi.fulfillment_status,'tracking_number',oi.tracking_number,'tracking_carrier',oi.tracking_carrier,
       'download_url',CASE WHEN oi.product_type='digital' AND o.payment_status='paid' THEN oi.digital_delivery_url ELSE '' END)
       ORDER BY oi.created_at) AS items
     FROM market_orders o JOIN market_order_items oi ON oi.order_id=o.id LEFT JOIN market_products p ON p.id=oi.product_id WHERE o.buyer_id=$1
     GROUP BY o.id ORDER BY o.created_at DESC LIMIT 100`,[user.id]
  );
  return {orders:rows};
}

async function toggleWishlist(db,req,body) {
  const user=await currentUser(req,db,true); const id=text(body.product_id,80);
  const existing=await db.query('DELETE FROM market_wishlists WHERE user_id=$1 AND product_id=$2 RETURNING product_id',[user.id,id]);
  if(!existing.rows.length) await db.query("INSERT INTO market_wishlists(user_id,product_id) SELECT $1,id FROM market_products WHERE id=$2 AND status='active' ON CONFLICT DO NOTHING",[user.id,id]);
  return {saved:!existing.rows.length};
}

async function wishlist(db,req) {
  const user=await currentUser(req,db,true);
  const {rows}=await db.query(
    `SELECT p.id,p.name,p.slug,p.price_kobo,p.image_url,p.product_type,s.store_name FROM market_wishlists w JOIN market_products p ON p.id=w.product_id
     JOIN market_sellers s ON s.id=p.seller_id WHERE w.user_id=$1 AND p.status='active' AND s.seller_status='approved' ORDER BY w.created_at DESC`,[user.id]
  );
  return {products:rows};
}

async function addReview(db,req,body) {
  const user=await requireRole(req,db,['buyer','seller','admin','super_admin']);
  const productId=text(body.product_id,80), orderId=text(body.order_id,80), rating=Math.min(Math.max(parseInt(body.rating,10)||0,0),5);
  if(rating<1||rating>5) throw new HttpError(400,'Choose a rating from 1 to 5.');
  const {rows}=await db.query(
    `INSERT INTO market_reviews(product_id,order_id,buyer_id,rating,review_text)
     SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM market_orders o JOIN market_order_items i ON i.order_id=o.id
       WHERE o.id=$2 AND o.buyer_id=$3 AND o.payment_status='paid' AND i.product_id=$1 AND i.fulfillment_status='delivered')
     RETURNING id`,[productId,orderId,user.id,rating,text(body.review_text,1200)]
  );
  if(!rows.length) throw new HttpError(403,'Reviews are available after the item has been delivered.');
  return {ok:true};
}

async function sellerFulfill(db,req,body) {
  const user=await requireRole(req,db,['seller','admin','super_admin']);
  const seller=await getSellerByUser(db,user.id,true);
  const status=['processing','dispatched','delivered'].includes(body.status)?body.status:null;
  if(!status) throw new HttpError(400,'Choose a valid fulfilment status.');
  const itemId=text(body.order_item_id,80);
  const {rows}=await db.query(
    `UPDATE market_order_items SET fulfillment_status=$3,tracking_number=$4,tracking_carrier=$5
     WHERE id=$1 AND seller_id=$2 AND EXISTS(SELECT 1 FROM market_orders o WHERE o.id=market_order_items.order_id AND o.payment_status='paid')
     RETURNING order_id`,[itemId,seller.id,status,text(body.tracking_number,100),text(body.tracking_carrier,100)]
  );
  if(!rows.length) throw new HttpError(404,'Order item not found.');
  await db.query(
    `UPDATE market_orders o SET status=CASE
      WHEN NOT EXISTS(SELECT 1 FROM market_order_items i WHERE i.order_id=o.id AND i.fulfillment_status<>'delivered') THEN 'delivered'
      WHEN EXISTS(SELECT 1 FROM market_order_items i WHERE i.order_id=o.id AND i.fulfillment_status='dispatched') THEN 'partially_dispatched'
      ELSE 'processing' END,updated_at=now() WHERE o.id=$1`,[rows[0].order_id]
  );
  await audit(db,user.id,'ORDER_ITEM_FULFILMENT_UPDATED','order_item',itemId,{status});
  return {ok:true};
}

async function adminOverview(db,req) {
  const user=await requireRole(req,db,['admin','super_admin']);
  const [orders,products,sellers,payouts,recent]=await Promise.all([
    db.query(`SELECT count(*) AS count,COALESCE(sum(total_kobo) FILTER(WHERE payment_status='paid'),0) AS gmv,
      count(*) FILTER(WHERE payment_status='paid') AS paid_orders,count(*) FILTER(WHERE payment_status='pending') AS awaiting_payment FROM market_orders`),
    db.query("SELECT count(*) AS total,count(*) FILTER(WHERE status='active') AS active,count(*) FILTER(WHERE status='pending') AS pending FROM market_products"),
    db.query("SELECT count(*) AS total,count(*) FILTER(WHERE seller_status='approved') AS approved,count(*) FILTER(WHERE seller_status='pending') AS pending FROM market_sellers"),
    db.query("SELECT count(*) AS count,COALESCE(sum(net_kobo) FILTER(WHERE status IN ('pending','approved','held')),0) AS outstanding FROM market_payouts"),
    db.query(`SELECT o.id,o.order_number,o.buyer_email,o.total_kobo,o.payment_status,o.status,o.created_at FROM market_orders o ORDER BY o.created_at DESC LIMIT 8`)
  ]);
  return {orders:orders.rows[0],products:products.rows[0],sellers:sellers.rows[0],payouts:payouts.rows[0],recent:recent.rows};
}

async function adminList(db,req,kind) {
  await requireRole(req,db,['admin','super_admin']);
  if(kind==='sellers') {
    const {rows}=await db.query(`SELECT s.*,u.full_name,u.email,u.phone FROM market_sellers s JOIN market_users u ON u.id=s.user_id ORDER BY CASE s.seller_status WHEN 'pending' THEN 0 ELSE 1 END,s.created_at DESC LIMIT 250`);
    return {sellers:rows.map(s=>({...sellerPublic(s),user_name:s.full_name,email:s.email,user_phone:s.phone}))};
  }
  if(kind==='products') {
    const {rows}=await db.query(`SELECT p.*,s.store_name,c.name AS category_name FROM market_products p JOIN market_sellers s ON s.id=p.seller_id LEFT JOIN market_categories c ON c.id=p.category_id ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END,p.created_at DESC LIMIT 250`);
    return {products:rows};
  }
  if(kind==='orders') {
    const {rows}=await db.query(`SELECT o.*,COALESCE(json_agg(json_build_object('product_name',i.product_name,'quantity',i.quantity,'seller_id',i.seller_id,'fulfillment_status',i.fulfillment_status)) FILTER(WHERE i.id IS NOT NULL),'[]'::json) AS items FROM market_orders o LEFT JOIN market_order_items i ON i.order_id=o.id GROUP BY o.id ORDER BY o.created_at DESC LIMIT 250`);
    return {orders:rows};
  }
  if(kind==='payouts') {
    const {rows}=await db.query(`SELECT p.*,s.store_name,u.full_name,u.email,o.order_number,s.bank_name,s.bank_code,s.account_number,s.account_name FROM market_payouts p JOIN market_sellers s ON s.id=p.seller_id JOIN market_users u ON u.id=s.user_id JOIN market_orders o ON o.id=p.order_id ORDER BY CASE p.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,p.created_at DESC LIMIT 500`);
    return {payouts:rows.map(p=>({...p,bank_code:decryptField(p.bank_code),account_number:decryptField(p.account_number)}))};
  }
  if(kind==='settings') return {settings:await getSettings(db)};
  throw new HttpError(400,'Unknown administration list.');
}

async function adminAction(db,req,body) {
  const user=await requireRole(req,db,['admin','super_admin']);
  const action=body.action;
  const id=text(body.id,80);
  if(action==='admin.seller-status') {
    const status=['approved','rejected','suspended'].includes(body.status)?body.status:null;
    if(!status) throw new HttpError(400,'Invalid seller status.');
    const {rows}=await db.query('UPDATE market_sellers SET seller_status=$2,updated_at=now() WHERE id=$1 RETURNING user_id,store_name',[id,status]);
    if(!rows.length) throw new HttpError(404,'Seller not found.');
    if(status==='approved') await db.query("UPDATE market_users SET role='seller',updated_at=now() WHERE id=$1 AND role='buyer'",[rows[0].user_id]);
    if(status==='suspended') await db.query("UPDATE market_users SET role='buyer',updated_at=now() WHERE id=$1 AND role='seller'",[rows[0].user_id]);
    await audit(db,user.id,'SELLER_STATUS_CHANGED','seller',id,{status}); return {ok:true};
  }
  if(action==='admin.product-status') {
    const status=['active','rejected','archived'].includes(body.status)?body.status:null;
    if(!status) throw new HttpError(400,'Invalid product status.');
    const {rows}=await db.query('UPDATE market_products SET status=$2,featured=$3,updated_at=now() WHERE id=$1 RETURNING id',[id,status,status==='active'&&body.featured===true]);
    if(!rows.length) throw new HttpError(404,'Product not found.');
    await audit(db,user.id,'PRODUCT_STATUS_CHANGED','product',id,{status}); return {ok:true};
  }
  if(action==='admin.payout-status') {
    const status=['approved','held','paid'].includes(body.status)?body.status:null;
    if(!status) throw new HttpError(400,'Invalid payout status.');
    if(status==='paid'&&!text(body.payout_reference,140)) throw new HttpError(400,'A bank transfer reference is required to record a completed payout.');
    const {rows}=await db.query(
      `UPDATE market_payouts SET status=$2,payout_reference=CASE WHEN $2='paid' THEN $3 ELSE payout_reference END,
       paid_at=CASE WHEN $2='paid' THEN now() ELSE paid_at END WHERE id=$1 AND status<>'reversed' AND ($2<>'paid' OR status='approved') RETURNING id`,
      [id,status,text(body.payout_reference,140)]
    );
    if(!rows.length) throw new HttpError(404,'Payout record not found.');
    await audit(db,user.id,'PAYOUT_STATUS_CHANGED','payout',id,{status}); return {ok:true};
  }
  if(action==='admin.settings') {
    const commission=Math.min(Math.max(parseInt(body.commission_bps,10)||0,0),5000);
    const shipping=money(body.physical_shipping_kobo);
    await db.query("INSERT INTO market_settings(key,value) VALUES('commission_bps',$1::jsonb),('physical_shipping_kobo',$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[JSON.stringify(commission),JSON.stringify(shipping)]);
    await db.query('UPDATE market_sellers SET commission_bps=$1,updated_at=now()', [commission]);
    await audit(db,user.id,'MARKET_SETTINGS_UPDATED','settings','market'); return {settings:await getSettings(db)};
  }
  if(action==='admin.order-status') {
    const status=['processing','dispatched','delivered','cancelled'].includes(body.status)?body.status:null;
    if(!status) throw new HttpError(400,'Invalid order status.');
    const {rows}=await db.query('UPDATE market_orders SET status=$2,updated_at=now() WHERE id=$1 RETURNING id',[id,status]);
    if(!rows.length) throw new HttpError(404,'Order not found.');
    await audit(db,user.id,'ORDER_STATUS_CHANGED','order',id,{status}); return {ok:true};
  }
  throw new HttpError(400,'Unsupported administration action.');
}

async function storeDetails(db, slug) {
  const {rows}=await db.query(`SELECT s.id,s.store_name,s.slug,s.description,s.city,s.state,s.created_at,u.full_name
    FROM market_sellers s JOIN market_users u ON u.id=s.user_id WHERE s.slug=$1 AND s.seller_status='approved' LIMIT 1`,[text(slug,100)]);
  if(!rows.length) throw new HttpError(404,'Store not found.');
  const products=await listProducts(db,{limit:60});
  return {store:rows[0],products:products.filter(p=>p.seller_id===rows[0].id)};
}

async function handle(db,req,res,body) {
  const action=text(body.action,80);
  if(action==='health') return {status:'ok',service:'ETHAN MARKET',database:'connected',payments:!!process.env.PAYSTACK_SECRET_KEY};
  if(action==='market.config') { const settings=await getSettings(db); return { marketplace_name:'ETHAN MARKET', shipping_kobo:Number(settings.physical_shipping_kobo ?? 200000), commission_bps:Number(settings.commission_bps ?? 1000), payments_enabled:!!process.env.PAYSTACK_SECRET_KEY, support_email:String(settings.support_email || 'ethandigitalacademy@gmail.com') }; }
  if(action==='auth.register') return authRegister(db,req,res,body);
  if(action==='auth.login') return authLogin(db,req,res,body);
  if(action==='auth.me') return authMe(db,req);
  if(action==='auth.logout') return signOut(db,req,res);
  if(action==='categories.list') return {categories:await publicCategories(db)};
  if(action==='products.list') return {products:await listProducts(db,body)};
  if(action==='products.detail') return {product:await productDetail(db,body.id || body.slug)};
  if(action==='store.detail') return storeDetails(db,body.slug);
  if(action==='seller.apply') return applySeller(db,req,body);
  if(action==='seller.dashboard') return sellerDashboard(db,req);
  if(action==='seller.profile') return saveSellerProfile(db,req,body);
  if(action==='seller.product.save') return saveProduct(db,req,body);
  if(action==='seller.fulfill') return sellerFulfill(db,req,body);
  if(action==='buyer.orders') return buyerOrders(db,req);
  if(action==='wishlist.list') return wishlist(db,req);
  if(action==='wishlist.toggle') return toggleWishlist(db,req,body);
  if(action==='reviews.create') return addReview(db,req,body);
  if(action==='checkout.create') return checkout(db,req,body);
  if(action==='payment.verify') return verifyPayment(db,req,body);
  if(action==='admin.overview') return adminOverview(db,req);
  if(action==='admin.list') return adminList(db,req,body.kind);
  if(action.startsWith('admin.')) return adminAction(db,req,body);
  throw new HttpError(400,'Unknown marketplace action.');
}

module.exports = async function handler(req,res) {
  const pathname = (()=>{try{return new URL(req.url,'https://market.ethandigitalacademy.org').pathname}catch{return '/api/market'}})();
  if(req.method==='OPTIONS') { res.statusCode=204; res.setHeader('Allow','POST, GET, OPTIONS'); return res.end(); }
  if(req.method==='GET') {
    const url = new URL(req.url || '/api/market', 'https://market.ethandigitalacademy.org');
    if (url.searchParams.get('health') === '1') {
      try { await ensureSchema(); return send(res,200,{status:'ok',service:'ETHAN MARKET',database:'connected',payments:!!process.env.PAYSTACK_SECRET_KEY,uploads:!!process.env.BLOB_READ_WRITE_TOKEN}); }
      catch(e) { console.error('ETHAN MARKET health check failed:',e.message); return send(res,503,{status:'unavailable',service:'ETHAN MARKET',database:'unavailable'}); }
    }
    return send(res,405,{error:'Method not allowed.'});
  }
  if(pathname.endsWith('/webhook')) {
    if(req.method!=='POST') return send(res,405,{error:'Method not allowed.'});
    try { await ensureSchema(); return await webhook(req,res,getPool()); }
    catch(e) { console.error('ETHAN MARKET webhook error:',e.message); return send(res,e.status||500,{error:e.status?e.message:'Webhook processing failed.'}); }
  }
  if(req.method!=='POST') return send(res,405,{error:'Method not allowed.'});
  try {
    safeOrigin(req);
    const body=await readBody(req);
    await ensureSchema();
    const result=await handle(getPool(),req,res,body);
    return send(res,200,{data:result});
  } catch(e) {
    const status=Number(e.status)||500;
    if(status>=500) console.error('ETHAN MARKET API error:',e.stack||e.message);
    return send(res,status,{error:status>=500?'The marketplace service is temporarily unavailable.':e.message});
  }
};

module.exports.config = { api: { bodyParser: false } };
